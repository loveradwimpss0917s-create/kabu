// backtest/run.mjs — StockEdge バックテスト（GitHub Actions上でのみ実行する。CLI操作は不要）
//
// 目的: 「calcTradeScoreが高い銘柄は、その後リターンが高い」という中核仮説を、
//       反証可能な形で検証する。優位性が確認できなければ「確認できなかった」と
//       出力することが正しい成果である（結果を良く見せるための調整は行わない）。
//
// ルックアヘッド防止: スコア計算には常に slice(0, i+1) （i日目までのデータのみ）を渡す。
//                     インデックスを渡して関数内部で未来を読める構造にはしない。
//
// 実行: GitHub Actions の workflow_dispatch から起動する（.github/workflows/backtest.yml）。
//       fee/slippage/tax/bootstrapIters は環境変数 BT_FEE_BPS 等で上書き可能。

import { calcTradeScore, buildAdjustedSeries } from '../indicators.js';
import { SCAN_STOCKS } from '../stocks.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// GitHub Actionsの共有IPから直接Yahoo Financeを叩くと、世界中の無関係なジョブと
// 合算されたレート制限に恒常的に引っかかり続けることを実運用で確認した
// （429が指数バックオフ・複数分の待機を挟んでも一切解消せず、81銘柄+crumb取得の
// 全リクエストが68分間ノーガードで失敗し続けた）。
// そのため、自前でYahooのcrumbを取得して直接叩くのではなく、既にYahoo Financeへの
// 接続実績があるCloudflare Worker（本アプリ本体）の /yfin/* プロキシ経由でデータを
// 取得する。crumbの取得・キャッシュはWorker側の既存ロジックにそのまま委ねる
const WORKER_BASE = process.env.BT_WORKER_BASE || 'https://kabu.loveradwimps-s0917s.workers.dev';

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

// ── 設定（実行前に固定。結果を見てから変更しないこと） ──────────────────────
const CONFIG = {
  feeBpsOneWay: num(process.env.BT_FEE_BPS, 5),           // 片道手数料 5bps = 0.05%
  slippageBpsOneWay: num(process.env.BT_SLIPPAGE_BPS, 10), // 片道スリッページ 10bps = 0.10%
  taxRatePct: num(process.env.BT_TAX_PCT, 20.315),          // 譲渡益税（利益が出た場合のみ）
  horizons: [1, 5, 20],
  warmupBars: 250,       // EMA200等が収束するまで捨てる日数
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 2000)),
  fetchDelayMs: 1500,    // Worker経由リクエストの間隔（Cloudflare/Yahoo双方への配慮）
  maxRetries: 4,          // 429/5xx受信時の再試行回数（指数バックオフ）
};

const BUCKETS = ['0-30', '30-50', '50-75', '75-90', '90-100'];
const APP_LABEL = { '0-30': 'STRONG SELL', '30-50': 'SELL', '50-75': 'NEUTRAL', '75-90': 'BUY', '90-100': 'STRONG BUY' };
const ITEM_NAME_TO_COL = {
  '出来高': 'vol_pts', 'EMA配列': 'ema_pts', 'RSI': 'rsi_pts', 'MACD': 'macd_pts',
  'ATRボラ': 'atr_pts', 'GU/GD': 'gap_pts', '52W高値': 'w52_pts',
  '材料': 'material_pts', 'アナリスト': 'material_pts'
};
const ITEM_COLS = ['vol_pts', 'ema_pts', 'rsi_pts', 'macd_pts', 'atr_pts', 'gap_pts', 'w52_pts', 'material_pts'];

// ── データ取得（Cloudflare Worker の /yfin/* プロキシ経由） ────────────────────

// 429（Workerが内部でYahooから429を受けた場合に転送されうる）・5xx（Worker/Cloudflare側の
// 一時的な不調）を対象にRetry-After（無ければ指数バックオフ+ジッター）で待って再試行する
async function fetchWithRetry(url, options, maxRetries) {
  maxRetries = maxRetries ?? CONFIG.maxRetries;
  let res;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === maxRetries) return res;
    const retryAfter = parseFloat(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : (3000 * 2 ** attempt + Math.random() * 1000);
    console.log(`  HTTP ${res.status}受信 — ${Math.round(waitMs / 1000)}秒待って再試行 (${attempt + 1}/${maxRetries})`);
    await sleep(waitMs);
  }
  return res;
}

// 失敗時は null を返さず例外を投げる（HTTPステータス・エラー内容を呼び出し側で
// ログに残せるようにするため。「取得失敗」とだけ表示されて原因が分からない、
// という事態を避ける）
async function fetchHistory(code) {
  const params = new URLSearchParams({ interval: '1d', range: '5y', includeAdjustedClose: 'true' });
  const res = await fetchWithRetry(`${WORKER_BASE}/yfin/v8/finance/chart/${code}.T?${params}`, {
    headers: { Accept: 'application/json' }
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(bodyText); } catch (e) {
    throw new Error(`JSON解析失敗 — ${bodyText.slice(0, 300)}`);
  }
  const chart = data?.chart?.result?.[0];
  if (!chart) {
    const err = data?.chart?.error;
    throw new Error(`chart.resultが空 — ${err ? JSON.stringify(err) : bodyText.slice(0, 300)}`);
  }
  return chart;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── スコア帯・項目別加点抽出 ─────────────────────────────────────────────────

function scoreBucket(score) {
  if (score < 30) return '0-30';
  if (score < 50) return '30-50';
  if (score < 75) return '50-75';
  if (score < 90) return '75-90';
  return '90-100';
}

function extractItemPoints(details) {
  const cols = Object.fromEntries(ITEM_COLS.map(c => [c, 0]));
  for (const d of details) {
    const col = ITEM_NAME_TO_COL[d.name];
    if (col) cols[col] += d.pts;
  }
  return cols;
}

function dateStr(epochSec) { return new Date(epochSec * 1000).toISOString().slice(0, 10); }

// ── 1銘柄分のルックアヘッドなしシミュレーション ──────────────────────────────
// 分割・配当調整後の系列（buildAdjustedSeries）を使い、i日目までのデータのみ
// （slice(0, i+1)）でスコアを計算する。エントリーは翌営業日の始値。
function simulateStock(code, chart) {
  const { o, h, l, c, v, dates } = buildAdjustedSeries(chart);
  const maxHorizon = Math.max(...CONFIG.horizons);
  if (c.length < CONFIG.warmupBars + maxHorizon + 10) return [];

  const evalStart = CONFIG.warmupBars;
  const evalEnd = c.length - 1 - maxHorizon;
  const rows = [];
  for (let i = evalStart; i <= evalEnd; i++) {
    // ── ここから先、参照してよいのは添字 0..i のみ ──
    const ts = calcTradeScore(
      o.slice(0, i + 1), h.slice(0, i + 1), l.slice(0, i + 1), c.slice(0, i + 1), v.slice(0, i + 1),
      null, // summaryData: 過去時点の決算日履歴・アナリスト評価はYahooから取得できないため常にnull
      '1d'
    );
    // ── ここから先は将来データ。エントリーは必ず翌営業日の始値 ──
    const entry = o[i + 1];
    if (!(entry > 0)) continue;
    const row = { code, date: dateStr(dates[i]), score: ts.score, bucket: scoreBucket(ts.score), ...extractItemPoints(ts.details) };
    let ok = true;
    for (const hz of CONFIG.horizons) {
      const exitPrice = c[i + hz];
      if (!(exitPrice > 0)) { ok = false; break; }
      row['ret' + hz] = (exitPrice - entry) / entry * 100;
    }
    if (ok) rows.push(row);
  }
  return rows;
}

// ── コスト・税 ───────────────────────────────────────────────────────────────
// friction（往復の手数料+スリッページ）はストラテジー側のみに適用し、
// ベンチマーク（ユニバース平均の受動的な参照値）には適用しない。
function frictionOnlyPct(grossPct) {
  const friction = 2 * (CONFIG.feeBpsOneWay + CONFIG.slippageBpsOneWay) / 100;
  return grossPct - friction;
}
function afterTaxPct(grossPct) {
  const beforeTax = frictionOnlyPct(grossPct);
  return beforeTax > 0 ? beforeTax * (1 - CONFIG.taxRatePct / 100) : beforeTax;
}

// ── ユニバース平均ベンチマーク（同日・同ホライズンの全銘柄等加重平均） ───────
function computeBenchmarkAndExcess(allRows) {
  const byDate = new Map();
  for (const r of allRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const benchmark = new Map();
  for (const [date, rows] of byDate) {
    const b = {};
    for (const hz of CONFIG.horizons) {
      const vals = rows.map(r => r['ret' + hz]).filter(v => v != null);
      b[hz] = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
    }
    benchmark.set(date, b);
  }
  for (const r of allRows) {
    const b = benchmark.get(r.date);
    for (const hz of CONFIG.horizons) {
      const gross = r['ret' + hz];
      const net = frictionOnlyPct(gross);
      const bm = b ? b[hz] : null;
      r['mkt' + hz] = bm;
      r['net' + hz] = net;
      r['afterTax' + hz] = afterTaxPct(gross);
      // 判定に使う超過リターンは「摩擦控除後・税引前」を使う（税引後を使うとベンチマークとの
      // 比較が不当になる。ベンチマークにも同じ税がかかるため）
      r['excess' + hz] = (bm != null) ? net - bm : null;
    }
  }
  return byDate;
}

// ── 統計ヘルパー ─────────────────────────────────────────────────────────────
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function round(v, d) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let num_ = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num_ += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  if (dx2 === 0 || dy2 === 0) return null;
  return num_ / Math.sqrt(dx2 * dy2);
}
function rankOf(arr) {
  const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
  const ranks = new Array(arr.length);
  idx.forEach((originalIdx, rank) => { ranks[originalIdx] = rank + 1; });
  return ranks;
}
// バケットによっては数万件の重複ポジション（同日・複数銘柄）を単純に直列複利するため、
// 素朴に equity *= (1+r/100) を積算すると浮動小数点アンダーフローで0になりNaNが発生する
// （実際に50-75バケット・58,236件で発生を確認）。対数空間で積算することで
// 桁数がいくら増えても数値的に安定させる。
function equityStats(rets) {
  let logEquity = 0, logPeak = 0, maxDD = 0, gp = 0, gl = 0;
  for (const r of rets) {
    const growth = 1 + r / 100;
    if (growth > 0) {
      logEquity += Math.log(growth);
      logPeak = Math.max(logPeak, logEquity);
      const dd = 1 - Math.exp(logEquity - logPeak);
      if (dd > maxDD) maxDD = dd;
    }
    if (r > 0) gp += r; else gl += -r;
  }
  const pf = gl > 0 ? gp / gl : null;
  return { maxDrawdownPct: round(maxDD * 100, 2), profitFactor: pf != null ? round(pf, 2) : null };
}
function percentileCI(values) {
  const valid = values.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return [null, null];
  const lo = valid[Math.floor(0.025 * valid.length)];
  const hi = valid[Math.min(valid.length - 1, Math.floor(0.975 * valid.length))];
  return [round(lo, 3), round(hi, 3)];
}

// ── 日付クラスタ・ブートストラップ用の事前集計 ───────────────────────────────
// 素朴なt検定は使わない：20日リターンの時系列重複と横断面の相関で2重に独立性が
// 崩れているため、日付単位でリサンプリングするクラスタ・ブートストラップを使う。
// ボトルネック回避のため、生の行を毎回スキャンせず日付ごとにあらかじめ集計しておく。
function buildDateStats(allRows) {
  const stats = new Map();
  for (const r of allRows) {
    let s = stats.get(r.date);
    if (!s) {
      s = { buckets: {}, verdictGroup: {}, items: {} };
      for (const b of BUCKETS) s.buckets[b] = Object.fromEntries(CONFIG.horizons.map(hz => [hz, { sum: 0, count: 0 }]));
      for (const hz of CONFIG.horizons) s.verdictGroup[hz] = { sum: 0, count: 0 };
      for (const col of ITEM_COLS) s.items[col] = { pos: { sum: 0, count: 0 }, neg: { sum: 0, count: 0 } };
      stats.set(r.date, s);
    }
    const isB4B5 = r.bucket === '75-90' || r.bucket === '90-100';
    for (const hz of CONFIG.horizons) {
      const ev = r['excess' + hz];
      if (ev == null) continue;
      s.buckets[r.bucket][hz].sum += ev; s.buckets[r.bucket][hz].count++;
      if (isB4B5) { s.verdictGroup[hz].sum += ev; s.verdictGroup[hz].count++; }
    }
    const e20 = r.excess20;
    if (e20 != null) {
      for (const col of ITEM_COLS) {
        const v = r[col];
        if (v == null) continue;
        const grp = v > 0 ? 'pos' : 'neg';
        s.items[col][grp].sum += e20; s.items[col][grp].count++;
      }
    }
  }
  return stats;
}

function bootstrapBucketCI(dateList, dateStats, bucket, hz, iters) {
  const n = dateList.length;
  const means = [];
  for (let iter = 0; iter < iters; iter++) {
    let sum = 0, count = 0;
    for (let k = 0; k < n; k++) {
      const d = dateList[(Math.random() * n) | 0];
      const st = dateStats.get(d).buckets[bucket][hz];
      sum += st.sum; count += st.count;
    }
    means.push(count > 0 ? sum / count : null);
  }
  return percentileCI(means);
}

function bootstrapVerdictGroupCI(dateList, dateStats, hz, iters) {
  const n = dateList.length;
  const means = [];
  for (let iter = 0; iter < iters; iter++) {
    let sum = 0, count = 0;
    for (let k = 0; k < n; k++) {
      const d = dateList[(Math.random() * n) | 0];
      const st = dateStats.get(d).verdictGroup[hz];
      sum += st.sum; count += st.count;
    }
    means.push(count > 0 ? sum / count : null);
  }
  return percentileCI(means);
}

function bootstrapItemDiffCI(dateList, dateStats, col, iters) {
  const n = dateList.length;
  const diffs = [];
  for (let iter = 0; iter < iters; iter++) {
    let sumPos = 0, cntPos = 0, sumNeg = 0, cntNeg = 0;
    for (let k = 0; k < n; k++) {
      const d = dateList[(Math.random() * n) | 0];
      const it = dateStats.get(d).items[col];
      sumPos += it.pos.sum; cntPos += it.pos.count;
      sumNeg += it.neg.sum; cntNeg += it.neg.count;
    }
    if (cntPos > 0 && cntNeg > 0) diffs.push(sumPos / cntPos - sumNeg / cntNeg);
  }
  return percentileCI(diffs);
}

// ── 集計 ─────────────────────────────────────────────────────────────────────

function aggregateBuckets(allRows, dateList, dateStats) {
  const result = {};
  for (const b of BUCKETS) {
    const rows = allRows.filter(r => r.bucket === b);
    // 簡易エクイティカーブ（equityStats）は「時系列順」の複利を意図しているため、
    // 銘柄処理順（allRowsの並び）ではなく日付順に並べ替えてから渡す
    const rowsByDate = [...rows].sort((a, b2) => a.date < b2.date ? -1 : a.date > b2.date ? 1 : 0);
    const horizons = {};
    for (const hz of CONFIG.horizons) {
      const gross = rows.map(r => r['ret' + hz]).filter(v => v != null);
      const net = rows.map(r => r['net' + hz]).filter(v => v != null);
      const netSorted = rowsByDate.map(r => r['net' + hz]).filter(v => v != null);
      const afterTax = rows.map(r => r['afterTax' + hz]).filter(v => v != null);
      const mkt = rows.map(r => r['mkt' + hz]).filter(v => v != null);
      const excess = rows.map(r => r['excess' + hz]).filter(v => v != null);
      const winRate = gross.length ? gross.filter(v => v > 0).length / gross.length * 100 : null;
      const netWinRate = net.length ? net.filter(v => v > 0).length / net.length * 100 : null;
      const eq = equityStats(netSorted);
      horizons[hz + 'd'] = {
        n: gross.length,
        grossMeanPct: round(mean(gross), 3), grossMedianPct: round(median(gross), 3), grossStdPct: round(stddev(gross), 3),
        grossWinRatePct: round(winRate, 1),
        netMeanPct: round(mean(net), 3), netWinRatePct: round(netWinRate, 1),
        afterTaxMeanPct: round(mean(afterTax), 3),
        benchmarkMeanPct: round(mean(mkt), 3),
        excessMeanPct: round(mean(excess), 3), excessMedianPct: round(median(excess), 3), excessStdPct: round(stddev(excess), 3),
        excessCI95: bootstrapBucketCI(dateList, dateStats, b, hz, CONFIG.bootstrapIters),
        maxDrawdownPct: eq.maxDrawdownPct, profitFactor: eq.profitFactor
      };
    }
    result[b] = { bucket: b, scoreRange: b.split('-').map(Number), appLabel: APP_LABEL[b], n: rows.length, horizons };
  }
  return result;
}

function computeRobustness(bucketResults, allRows) {
  const spearman = {};
  for (const hz of CONFIG.horizons) {
    const means = BUCKETS.map(b => bucketResults[b].horizons[hz + 'd'].excessMeanPct);
    const validIdx = means.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
    if (validIdx.length < 2) { spearman[hz] = null; continue; }
    const xs = validIdx.map(i => i + 1);
    const ys = validIdx.map(i => means[i]);
    spearman[hz] = round(pearson(rankOf(xs), rankOf(ys)), 4);
  }

  const allDates = [...new Set(allRows.map(r => r.date))].sort();
  const n = allDates.length;
  const chunkSize = Math.ceil(n / 3);
  const subPeriods = [0, 1, 2].map(k => {
    const datesInChunk = allDates.slice(k * chunkSize, (k + 1) * chunkSize);
    const dateSet = new Set(datesInChunk);
    const rows = allRows.filter(r => dateSet.has(r.date) && (r.bucket === '75-90' || r.bucket === '90-100'));
    const vals = rows.map(r => r.excess20).filter(v => v != null);
    return {
      label: 'Y' + (k + 1),
      start: datesInChunk[0] || null,
      end: datesInChunk[datesInChunk.length - 1] || null,
      n: vals.length,
      b4b5ExcessMeanPct20d: round(mean(vals), 3)
    };
  });

  return { spearmanRhoBucketVsExcess: spearman, subPeriods };
}

function computeItemAnalysis(allRows, dateList, dateStats) {
  return ITEM_COLS.map(col => {
    const withRet = allRows.filter(r => r[col] != null && r.excess20 != null);
    const withPts = withRet.filter(r => r[col] > 0);
    const withoutPts = withRet.filter(r => r[col] <= 0);
    const meanWith = mean(withPts.map(r => r.excess20));
    const meanWithout = mean(withoutPts.map(r => r.excess20));
    return {
      item: col,
      nPositive: withPts.length,
      nZeroOrNegative: withoutPts.length,
      meanExcess20dWhenPositive: round(meanWith, 3),
      meanExcess20dWhenNotPositive: round(meanWithout, 3),
      difference: (meanWith != null && meanWithout != null) ? round(meanWith - meanWithout, 3) : null,
      differenceCI95: bootstrapItemDiffCI(dateList, dateStats, col, CONFIG.bootstrapIters),
      note: col === 'material_pts'
        ? '検証不能: summaryData未使用のため常に0（過去時点の決算日履歴・アナリスト評価はYahooから取得できないため）'
        : null
    };
  });
}

function computeVerdict(dateList, dateStats, robustness) {
  const [ci95Lower20] = bootstrapVerdictGroupCI(dateList, dateStats, 20, CONFIG.bootstrapIters);
  const criterion1 = ci95Lower20 != null && ci95Lower20 > 0;

  const rho20 = robustness.spearmanRhoBucketVsExcess[20];
  const criterion2 = rho20 != null && rho20 >= 0.8;

  const positiveCount = robustness.subPeriods.filter(p => p.b4b5ExcessMeanPct20d != null && p.b4b5ExcessMeanPct20d > 0).length;
  const criterion3 = positiveCount >= 2;

  const allPass = criterion1 && criterion2 && criterion3;
  return {
    criterion1_ci95LowerAboveZero: criterion1,
    criterion1_detail: { b4b5ExcessCI95_20d: [ci95Lower20 != null ? round(ci95Lower20, 3) : null, null] },
    criterion2_spearmanRhoAtLeast08: criterion2,
    criterion2_detail: { rho20d: rho20 },
    criterion3_signPositiveIn2of3SubPeriods: criterion3,
    criterion3_detail: { positiveSubPeriods: positiveCount, of: 3 },
    conclusion: allPass ? 'EDGE_CONFIRMED' : 'EDGE_NOT_CONFIRMED',
    survivorshipBiasNote:
      '対象はSCAN_STOCKS（現在の大型株81銘柄の固定リスト）であり、3年間生き残り今も大型株である銘柄のみを' +
      '対象としているため、結果は構造的に上方バイアスを持つ。EDGE_CONFIRMEDでも、この基準を辛うじて満たす' +
      '程度の弱い結果（例: 20日超過リターンが+0.1%程度）は「優位性なし」と解釈するのが妥当である。'
  };
}

// ── メイン処理 ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log(`データ取得元: ${WORKER_BASE}/yfin/*（Cloudflare Worker経由。crumb処理はWorker側に委ねる）`);

  const allRows = [];
  const skippedStocks = [];
  for (let idx = 0; idx < SCAN_STOCKS.length; idx++) {
    const [code, name] = SCAN_STOCKS[idx];
    process.stdout.write(`[${idx + 1}/${SCAN_STOCKS.length}] ${code} ${name} ... `);
    try {
      const chart = await fetchHistory(code);
      const rows = simulateStock(code, chart);
      if (!rows.length) { console.log('データ不足'); skippedStocks.push({ code, name, reason: 'insufficient_data' }); }
      else { allRows.push(...rows); console.log(`${rows.length}件`); }
    } catch (e) {
      console.log('エラー: ' + e.message);
      skippedStocks.push({ code, name, reason: e.message });
    } finally {
      // continue/catch のいずれの経路でも必ず1回だけ待機する
      // （以前はcontinueが待機処理を素通りし、81銘柄が約1.5秒で終わってしまっていた）
      await sleep(CONFIG.fetchDelayMs);
    }
  }

  if (!allRows.length) {
    console.error('有効なデータが1件もありません。終了します。');
    process.exit(1);
  }

  console.log(`\n観測数: ${allRows.length}件。ベンチマーク・超過リターンを計算中...`);
  computeBenchmarkAndExcess(allRows);

  const dateList = [...new Set(allRows.map(r => r.date))].sort();
  console.log(`対象営業日数: ${dateList.length}日。日付別集計を構築中...`);
  const dateStats = buildDateStats(allRows);

  console.log(`ブートストラップ実行中（${CONFIG.bootstrapIters}回 × バケット/項目）...`);
  const buckets = aggregateBuckets(allRows, dateList, dateStats);
  const robustness = computeRobustness(buckets, allRows);
  const itemAnalysis = computeItemAnalysis(allRows, dateList, dateStats);
  const verdict = computeVerdict(dateList, dateStats, robustness);

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    config: CONFIG,
    universe: {
      stockCount: SCAN_STOCKS.length,
      scoredStockCount: SCAN_STOCKS.length - skippedStocks.length,
      startDate: dateList[0], endDate: dateList[dateList.length - 1]
    },
    coverage: {
      totalObservations: allRows.length,
      skippedStocks,
      scoredItems: '①〜⑦のみ（⑧材料・アナリストはsummaryData未使用のため検証不能）'
    },
    buckets: BUCKETS.map(b => buckets[b]),
    robustness,
    itemAnalysis,
    verdict
  };

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/${runId}.md`, renderMarkdown(report));
  writeFileSync(`${outDir}/latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/latest.md`, renderMarkdown(report));

  console.log(`\n完了: backtest/results/${runId}.json / .md を出力しました`);
  console.log(`判定: ${verdict.conclusion}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# バックテスト結果 (${report.runId})`);
  lines.push('');
  lines.push(`- 対象期間: ${report.universe.startDate} 〜 ${report.universe.endDate}`);
  lines.push(`- 対象銘柄: ${report.universe.scoredStockCount} / ${report.universe.stockCount}（スキップ ${report.coverage.skippedStocks.length}件）`);
  lines.push(`- 観測数: ${report.coverage.totalObservations}件`);
  lines.push(`- コスト前提: 片道手数料${report.config.feeBpsOneWay}bps / 片道スリッページ${report.config.slippageBpsOneWay}bps / 譲渡益税${report.config.taxRatePct}%（利益時のみ）`);
  lines.push(`- スコア⑧（材料・アナリスト）: ${report.coverage.scoredItems}`);
  lines.push('');
  lines.push('## 判定');
  lines.push('');
  lines.push(`**結論: ${report.verdict.conclusion}**`);
  lines.push('');
  lines.push('| 条件 | 結果 |');
  lines.push('|---|---|');
  lines.push(`| ① B4+B5(75点以上) 20日超過リターンCI95%下限>0 | ${report.verdict.criterion1_ci95LowerAboveZero ? '✅' : '❌'} (下限=${report.verdict.criterion1_detail.b4b5ExcessCI95_20d[0]}) |`);
  lines.push(`| ② スコア帯の単調性 Spearman ρ≥0.8 | ${report.verdict.criterion2_spearmanRhoAtLeast08 ? '✅' : '❌'} (ρ=${report.verdict.criterion2_detail.rho20d}) |`);
  lines.push(`| ③ 3サブ期間中2つ以上でB4+B5超過リターン>0 | ${report.verdict.criterion3_signPositiveIn2of3SubPeriods ? '✅' : '❌'} (${report.verdict.criterion3_detail.positiveSubPeriods}/3) |`);
  lines.push('');
  lines.push(`> ${report.verdict.survivorshipBiasNote}`);
  lines.push('');
  lines.push('## スコア帯別集計（20日ホライズン）');
  lines.push('');
  lines.push('| バケット | 表示ラベル | n | 平均超過リターン(%) | 95%CI | 勝率(%) | 最大DD(%) | PF |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const b of report.buckets) {
    const h = b.horizons['20d'];
    lines.push(`| ${b.bucket} | ${b.appLabel} | ${h.n} | ${h.excessMeanPct} | [${h.excessCI95[0]}, ${h.excessCI95[1]}] | ${h.grossWinRatePct} | ${h.maxDrawdownPct} | ${h.profitFactor} |`);
  }
  lines.push('');
  lines.push('## 項目別相関（20日超過リターンとの関係）');
  lines.push('');
  lines.push('| 項目 | 加点あり平均 | 加点なし平均 | 差 | 95%CI | n(あり/なし) |');
  lines.push('|---|---|---|---|---|---|');
  for (const it of report.itemAnalysis) {
    lines.push(`| ${it.item}${it.note ? ' ※' : ''} | ${it.meanExcess20dWhenPositive} | ${it.meanExcess20dWhenNotPositive} | ${it.difference} | [${it.differenceCI95[0]}, ${it.differenceCI95[1]}] | ${it.nPositive}/${it.nZeroOrNegative} |`);
  }
  const notes = report.itemAnalysis.filter(it => it.note);
  if (notes.length) {
    lines.push('');
    notes.forEach(it => lines.push(`※ ${it.item}: ${it.note}`));
  }
  lines.push('');
  lines.push('## サブ期間安定性');
  lines.push('');
  lines.push('| 期間 | 開始 | 終了 | n | B4+B5 20日超過リターン平均(%) |');
  lines.push('|---|---|---|---|---|');
  for (const p of report.robustness.subPeriods) {
    lines.push(`| ${p.label} | ${p.start} | ${p.end} | ${p.n} | ${p.b4b5ExcessMeanPct20d} |`);
  }
  if (report.coverage.skippedStocks.length) {
    lines.push('');
    lines.push('## スキップした銘柄');
    lines.push('');
    lines.push('| コード | 名称 | 理由 |');
    lines.push('|---|---|---|');
    for (const s of report.coverage.skippedStocks) lines.push(`| ${s.code} | ${s.name} | ${s.reason} |`);
  }
  return lines.join('\n') + '\n';
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
