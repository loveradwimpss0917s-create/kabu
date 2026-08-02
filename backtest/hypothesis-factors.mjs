// backtest/hypothesis-factors.mjs — Step3-(4): 無料データ(OHLCV)で検証可能な
// クロスセクショナル・ファクターの一括検証
//
// 背景: 信用需給データは無料では取得できない（J-Quants APIの有料プランが必要）ため、
// 既存のOHLCVキャッシュだけで検証できる仮説に切り替えた。
//
// 【重要・事前登録】結果を見てから仮説や判定基準を変えないため、検証する
// ファクターと期待する符号をコード上で事前に固定する。4ファクターすべての結果を
// 良し悪しに関わらず報告する（都合の良いものだけ選んで報告しない）。
// また4つ同時に検証するため多重比較の問題が生じる。95%CIを4回使えば、
// 真に効果がなくても1つくらいは「有意」に見えることがある（family-wise error）。
// そのため参考としてBonferroni補正済みの基準(98.75%CI相当)も併記し、
// 「補正前は有意だが補正後は非有意」なものを過大評価しないようにする。
//
// 検証する4ファクター（いずれも期待符号はQ5-Q1がマイナス）:
//   rev5      直近5営業日リターン    … 短期リバーサル(Jegadeesh 1990/Lehmann 1990)。
//                                      PEADサニティチェックで実際に強い反転を検出しており、
//                                      本プロジェクトで最も有望な手がかり
//   rev20     直近20営業日リターン   … 1ヶ月リバーサル。rev5より長い窓での同種の効果
//   vol60     直近60日の日次リターン標準偏差 … 低ボラティリティ・アノマリー
//   turnover  直近20日の平均売買代金(対数) … 流動性プレミアム（低流動性ほど高リターン）
//
// 統計手法はrun.mjs・hypothesis-pead.mjs・hypothesis-momentum.mjs・
// hypothesis-sector.mjsと同一（日付単位の事前集計＋移動ブロック・ブートストラップ、
// 上場廃止等による異常リターンの除外も同じ閾値）。
//
// 実行: .github/workflows/hypothesis-factors.yml から手動実行する

import { buildAdjustedSeries } from '../indicators.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZocHdtYWZuYnptdGplbWxkbWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxOTA5OTQsImV4cCI6MjA5Nzc2Njk5NH0.DUlD9QbME-ReQY7ujlA172sMObR1JRay7dJAqoPq4-U';

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

const CONFIG = {
  horizons: [1, 5, 20],
  rev5Lookback: 5,
  rev20Lookback: 20,
  volLookback: 60,
  turnoverLookback: 20,
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 2000)),
  blockLength: Math.round(num(process.env.BT_BLOCK_LENGTH, 40)),
  // 信頼区間の拡大倍率。移動ブロック・ブートストラップは日付を（ブロック単位で）
  // リサンプリングするため時系列方向の不確実性は捉えるが、「どの銘柄が抽出されたか」
  // という銘柄横断方向の不確実性を捉えられず、標準誤差を系統的に過小評価する。
  //
  // 合成データでの実測（効果ゼロのパネル40本、200銘柄×700本）:
  //   独立試行から実測した真のSE = 0.0928%
  //   ブロック長40でのブートストラップSE = 0.0713%（真の0.77倍＝23%の過小評価）
  // その結果、補正なしでは「効果ゼロなのにCI95が0を除外する」頻度が23%に達した
  // （本来5%であるべき）。区間の半幅を拡大した場合の実測:
  //   1.0倍→偽陽性23% / 1.2倍→10% / 1.3倍→8% / 1.5倍→0%（いずれも検出力は100%を維持）
  // 検出力を損なわずに偽陽性を抑えられる1.5倍を採用する。
  //
  // 注意: この較正は200銘柄×700本の合成データで行った。実データ（約3,575銘柄×
  // 約2,200本）では最適倍率が異なりうるが、過小評価するという偏りの向きは構造的で
  // あり、1.5倍は保守的側（優位性を見逃す方向）に倒す安全な選択である。
  ciInflation: num(process.env.BT_CI_INFLATION, 1.5),
};

// 事前登録したファクター定義。expectedSign は Q5-Q1 スプレッドに期待する符号。
// 実行後にこの定義を書き換えて「当たったこと」にしてはならない。
const FACTORS = [
  { key: 'rev5', label: '短期リバーサル(直近5日リターン)', expectedSign: -1,
    rationale: 'PEADサニティチェックで急変動後の反転を強く検出したため、その体系版' },
  { key: 'rev20', label: '1ヶ月リバーサル(直近20日リターン)', expectedSign: -1,
    rationale: 'rev5より長い窓での同種の反転効果' },
  { key: 'vol60', label: '低ボラティリティ(直近60日の日次リターン標準偏差)', expectedSign: -1,
    rationale: '低ボラティリティ・アノマリー（高ボラ銘柄が劣後する）' },
  { key: 'turnover', label: '低流動性(直近20日の平均売買代金・対数)', expectedSign: -1,
    rationale: '流動性プレミアム（売買代金が小さい銘柄ほど高リターン）' },
];

const QUINTILES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
const MAX_PLAUSIBLE_RET_PCT = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchWithRetry(url, options, maxRetries) {
  maxRetries = maxRetries ?? 3;
  let res;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === maxRetries) return res;
    const waitMs = 1000 * 2 ** attempt + Math.random() * 500;
    console.log(`  HTTP ${res.status}受信 — ${Math.round(waitMs / 1000)}秒待って再試行 (${attempt + 1}/${maxRetries})`);
    await sleep(waitMs);
  }
  return res;
}

const anonHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Accept: 'application/json' };

async function* iterateCachedSeries(pageSize) {
  let offset = 0;
  for (;;) {
    const q = `${SUPABASE_URL}/rest/v1/bt_prices_cache?select=code,series&status=eq.done&order=code.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetchWithRetry(q, { headers: anonHeaders });
    if (!res.ok) throw new Error(`bt_prices_cache取得失敗: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const r of rows) yield r;
    if (rows.length < pageSize) return;
    offset += pageSize;
  }
}

function dateStr(epochSec) { return new Date(epochSec * 1000).toISOString().slice(0, 10); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
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
// pLow/pHigh を変えることで信頼水準を切り替える（多重比較のBonferroni補正用）
function percentileCI(values, pLow, pHigh) {
  const valid = values.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return [null, null];
  const lo = valid[Math.floor(pLow * valid.length)];
  const hi = valid[Math.min(valid.length - 1, Math.floor(pHigh * valid.length))];
  return [lo, hi];
}

// ブートストラップCIをCONFIG.ciInflation倍に広げる（点推定を中心に半幅を拡大）。
// 過小評価の実測と倍率の根拠はCONFIG.ciInflationのコメントを参照
function ciFrom(bootMeans, pointEstimate, pLow, pHigh) {
  const [lo, hi] = percentileCI(bootMeans, pLow, pHigh);
  if (lo == null || hi == null) return [null, null];
  if (pointEstimate == null) return [round(lo, 3), round(hi, 3)];
  const k = CONFIG.ciInflation;
  return [round(pointEstimate - (pointEstimate - lo) * k, 3), round(pointEstimate + (hi - pointEstimate) * k, 3)];
}
function stddevOf(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

// ── 1銘柄分: 4ファクターと将来リターンを一度に計算（ルックアヘッドなし） ──────
// 日iまでのデータのみでファクターを計算し、エントリーは翌営業日の始値、
// エグジットは日i+horizonの終値（既存スクリプトと同じ規約）
function computeStockRows(chart) {
  const { o, c, v, dates } = buildAdjustedSeries(chart);
  const maxHorizon = Math.max(...CONFIG.horizons);
  const warmup = Math.max(CONFIG.rev5Lookback, CONFIG.rev20Lookback, CONFIG.volLookback, CONFIG.turnoverLookback) + 1;
  if (c.length < warmup + maxHorizon + 10) return [];

  // 日次リターン系列（ボラティリティ算出用に事前計算）
  const dailyRet = new Array(c.length).fill(null);
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] > 0 && c[i] > 0) dailyRet[i] = (c[i] - c[i - 1]) / c[i - 1] * 100;
  }

  const rows = [];
  for (let i = warmup; i <= c.length - 1 - maxHorizon - 1; i++) {
    const c5 = c[i - CONFIG.rev5Lookback], c20 = c[i - CONFIG.rev20Lookback];
    if (!(c[i] > 0) || !(c5 > 0) || !(c20 > 0)) continue;

    const volWindow = dailyRet.slice(i - CONFIG.volLookback + 1, i + 1).filter(x => x != null);
    if (volWindow.length < CONFIG.volLookback * 0.8) continue;
    const vol60 = stddevOf(volWindow);
    if (vol60 == null || !(vol60 > 0)) continue;

    // 売買代金 = 終値×出来高。桁が大きく分布が歪むため対数を取る
    const toWindow = [];
    for (let k = i - CONFIG.turnoverLookback + 1; k <= i; k++) {
      if (c[k] > 0 && v[k] > 0) toWindow.push(c[k] * v[k]);
    }
    if (toWindow.length < CONFIG.turnoverLookback * 0.8) continue;
    const avgTurnover = mean(toWindow);
    if (!(avgTurnover > 0)) continue;

    const entry = o[i + 1];
    if (!(entry > 0)) continue;

    const row = {
      date: dateStr(dates[i]),
      rev5: (c[i] - c5) / c5 * 100,
      rev20: (c[i] - c20) / c20 * 100,
      vol60,
      turnover: Math.log(avgTurnover)
    };
    let ok = true;
    for (const hz of CONFIG.horizons) {
      const exitPrice = c[i + hz];
      if (!(exitPrice > 0)) { ok = false; break; }
      const ret = (exitPrice - entry) / entry * 100;
      if (Math.abs(ret) > MAX_PLAUSIBLE_RET_PCT) { ok = false; break; }
      row['ret' + hz] = ret;
    }
    if (ok) rows.push(row);
  }
  return rows;
}

function computeBenchmark(allRows) {
  const byDate = new Map();
  for (const r of allRows) {
    let s = byDate.get(r.date);
    if (!s) { s = {}; for (const hz of CONFIG.horizons) s[hz] = { sum: 0, count: 0 }; byDate.set(r.date, s); }
    for (const hz of CONFIG.horizons) {
      const val = r['ret' + hz];
      if (val != null) { s[hz].sum += val; s[hz].count++; }
    }
  }
  const benchmark = new Map();
  for (const [date, s] of byDate) {
    const b = {};
    for (const hz of CONFIG.horizons) b[hz] = s[hz].count ? s[hz].sum / s[hz].count : null;
    benchmark.set(date, b);
  }
  return benchmark;
}
function excessOf(r, hz, benchmark) {
  const g = r['ret' + hz];
  if (g == null) return null;
  const b = benchmark.get(r.date);
  const bm = b ? b[hz] : null;
  return bm != null ? g - bm : null;
}

// 1ファクター分の日付別分位点カットオフを求める（メモリ節約のためファクターごとに逐次実行）
function computeCutoffs(allRows, factorKey) {
  const byDate = new Map();
  for (const r of allRows) {
    const val = r[factorKey];
    if (val == null || !Number.isFinite(val)) continue;
    let arr = byDate.get(r.date);
    if (!arr) { arr = []; byDate.set(r.date, arr); }
    arr.push(val);
  }
  const cutoffs = new Map();
  for (const [date, arr] of byDate) {
    if (arr.length < 20) continue; // 分位点を作るのに最低限必要な銘柄数
    arr.sort((a, b) => a - b);
    const q = p => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    cutoffs.set(date, { p20: q(0.20), p40: q(0.40), p60: q(0.60), p80: q(0.80) });
  }
  return cutoffs;
}
function quintileOf(val, cut) {
  if (val <= cut.p20) return 'Q1';
  if (val <= cut.p40) return 'Q2';
  if (val <= cut.p60) return 'Q3';
  if (val <= cut.p80) return 'Q4';
  return 'Q5';
}

function buildBlockedDateSequence(dateList, blockLength) {
  const n = dateList.length;
  const maxStart = Math.max(0, n - blockLength);
  const seq = [];
  while (seq.length < n) {
    const start = Math.floor(Math.random() * (maxStart + 1));
    for (let i = start; i < Math.min(start + blockLength, n) && seq.length < n; i++) seq.push(dateList[i]);
  }
  return seq;
}

function buildDateStats(allRows, benchmark, factorKey, cutoffs) {
  const stats = new Map();
  for (const r of allRows) {
    const val = r[factorKey];
    if (val == null || !Number.isFinite(val)) continue;
    const cut = cutoffs.get(r.date);
    if (!cut) continue;
    const q = quintileOf(val, cut);
    let s = stats.get(r.date);
    if (!s) {
      s = { quintiles: {}, spread: {} };
      for (const ql of QUINTILES) s.quintiles[ql] = Object.fromEntries(CONFIG.horizons.map(hz => [hz, { sum: 0, count: 0 }]));
      stats.set(r.date, s);
    }
    for (const hz of CONFIG.horizons) {
      const ev = excessOf(r, hz, benchmark);
      if (ev == null) continue;
      s.quintiles[q][hz].sum += ev; s.quintiles[q][hz].count++;
    }
  }
  for (const [, s] of stats) {
    for (const hz of CONFIG.horizons) {
      const q5 = s.quintiles['Q5'][hz], q1 = s.quintiles['Q1'][hz];
      s.spread[hz] = (q5.count > 0 && q1.count > 0) ? (q5.sum / q5.count) - (q1.sum / q1.count) : null;
    }
  }
  return stats;
}

// ブートストラップは1回のリサンプリングで分位点・スプレッド両方を同時に集計する
// （同じ乱数系列を使い回すことで試行回数を増やさずに済ませる）
function bootstrapAll(dateList, dateStats, hz, iters) {
  const quintileMeans = Object.fromEntries(QUINTILES.map(q => [q, []]));
  const spreadMeans = [];
  for (let iter = 0; iter < iters; iter++) {
    const seq = buildBlockedDateSequence(dateList, CONFIG.blockLength);
    const acc = Object.fromEntries(QUINTILES.map(q => [q, { sum: 0, count: 0 }]));
    const spreadVals = [];
    for (const d of seq) {
      const st = dateStats.get(d);
      if (!st) continue;
      for (const q of QUINTILES) {
        const g = st.quintiles[q][hz];
        acc[q].sum += g.sum; acc[q].count += g.count;
      }
      if (st.spread[hz] != null) spreadVals.push(st.spread[hz]);
    }
    for (const q of QUINTILES) quintileMeans[q].push(acc[q].count > 0 ? acc[q].sum / acc[q].count : null);
    spreadMeans.push(spreadVals.length ? mean(spreadVals) : null);
  }
  return { quintileMeans, spreadMeans };
}

async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log('事前登録した検証ファクター:');
  for (const f of FACTORS) console.log(`  - ${f.key}: ${f.label} / 期待符号(Q5-Q1)=${f.expectedSign > 0 ? '+' : '-'} / 理由: ${f.rationale}`);
  console.log('データ取得元: Supabase(bt_prices_cache)のみ');

  const allRows = [];
  let processed = 0, skipped = 0;
  const PAGE_SIZE = 100;
  for await (const { code, series } of iterateCachedSeries(PAGE_SIZE)) {
    processed++;
    if (processed % 200 === 0) console.log(`  ...${processed}銘柄処理済み`);
    try {
      if (!series) { skipped++; continue; }
      const rows = computeStockRows(series);
      if (!rows.length) skipped++;
      else allRows.push(...rows);
    } catch (e) {
      skipped++;
    }
  }
  console.log(`キャッシュから読み込み完了: ${processed}銘柄（スキップ${skipped}）`);
  console.log(`観測数: ${allRows.length}件`);
  if (!allRows.length) { console.error('有効なデータが1件もありません。'); process.exit(1); }

  console.log('ベンチマークを計算中...');
  const benchmark = computeBenchmark(allRows);

  // 多重比較: 4ファクターを同時検定するためBonferroni補正後の水準も算出する
  const nTests = FACTORS.length;
  const bonfAlpha = 0.05 / nTests;              // 0.0125
  const bonfLow = bonfAlpha / 2, bonfHigh = 1 - bonfAlpha / 2; // 98.75%CI

  const factorResults = [];
  for (const f of FACTORS) {
    console.log(`\n[${f.key}] 分位点を計算中...`);
    const cutoffs = computeCutoffs(allRows, f.key);
    const dateStats = buildDateStats(allRows, benchmark, f.key, cutoffs);
    const dateList = [...dateStats.keys()].sort();
    console.log(`[${f.key}] 対象営業日数: ${dateList.length}日。ブートストラップ実行中（${CONFIG.bootstrapIters}回）...`);

    const horizons = {};
    let spread20CI = null, spread20BonfCI = null, spread20Mean = null;
    for (const hz of CONFIG.horizons) {
      const { quintileMeans, spreadMeans } = bootstrapAll(dateList, dateStats, hz, CONFIG.bootstrapIters);
      const quintiles = {};
      for (const q of QUINTILES) {
        let sum = 0, count = 0;
        for (const s of dateStats.values()) { sum += s.quintiles[q][hz].sum; count += s.quintiles[q][hz].count; }
        const pt = count ? sum / count : null;
        quintiles[q] = {
          n: count,
          excessMeanPct: round(pt, 3),
          excessCI95: ciFrom(quintileMeans[q], pt, 0.025, 0.975)
        };
      }
      const spreadVals = [...dateStats.values()].map(s => s.spread[hz]).filter(v => v != null);
      const sPoint = mean(spreadVals);
      const sMean = round(sPoint, 3);
      const sCI = ciFrom(spreadMeans, sPoint, 0.025, 0.975);
      const sBonf = ciFrom(spreadMeans, sPoint, bonfLow, bonfHigh);
      horizons[hz + 'd'] = { quintiles, spreadMeanPct: sMean, spreadCI95: sCI, spreadCI_bonferroni: sBonf };
      if (hz === 20) { spread20CI = sCI; spread20BonfCI = sBonf; spread20Mean = sMean; }
    }

    // 判定: 事前登録した期待符号の方向にCIが0を除外しているか
    const sig95 = f.expectedSign < 0
      ? (spread20CI[1] != null && spread20CI[1] < 0)
      : (spread20CI[0] != null && spread20CI[0] > 0);
    const sigBonf = f.expectedSign < 0
      ? (spread20BonfCI[1] != null && spread20BonfCI[1] < 0)
      : (spread20BonfCI[0] != null && spread20BonfCI[0] > 0);

    // 単調性（期待符号がマイナスなら Q1→Q5 で減少しているはず）
    const means20 = QUINTILES.map(q => horizons['20d'].quintiles[q].excessMeanPct);
    const validIdx = means20.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
    const rho = validIdx.length >= 2 ? round(pearson(rankOf(validIdx.map(i => i + 1)), rankOf(validIdx.map(i => means20[i]))), 4) : null;
    const monotonic = rho != null && (f.expectedSign < 0 ? rho <= -0.8 : rho >= 0.8);

    // サブ期間安定性
    const n = dateList.length;
    const chunkSize = Math.ceil(n / 3);
    const subPeriods = [0, 1, 2].map(k => {
      const datesInChunk = dateList.slice(k * chunkSize, (k + 1) * chunkSize);
      const vals = datesInChunk.map(d => { const s = dateStats.get(d); return s ? s.spread[20] : null; }).filter(v => v != null);
      const m = round(mean(vals), 3);
      return { label: 'Y' + (k + 1), start: datesInChunk[0] || null, end: datesInChunk[datesInChunk.length - 1] || null, n: vals.length, spreadMeanPct20d: m };
    });
    const consistentCount = subPeriods.filter(p => p.spreadMeanPct20d != null && Math.sign(p.spreadMeanPct20d) === f.expectedSign).length;
    const consistent = consistentCount >= 2;

    const conclusion = (sigBonf && monotonic && consistent) ? 'EDGE_CONFIRMED'
      : (sig95 && monotonic && consistent) ? 'EDGE_LIKELY_BUT_NOT_MULTIPLICITY_ROBUST'
      : 'EDGE_NOT_CONFIRMED';

    console.log(`[${f.key}] 20日スプレッド=${spread20Mean}% CI95=[${spread20CI}] → ${conclusion}`);

    factorResults.push({
      key: f.key, label: f.label, expectedSign: f.expectedSign, rationale: f.rationale,
      horizons,
      robustness: { spearmanRho20d: rho, monotonicAsExpected: monotonic, subPeriods, subPeriodsConsistent: consistentCount },
      verdict: {
        significant95: sig95, significantBonferroni: sigBonf,
        monotonic, consistent, conclusion,
        spread20d: { meanPct: spread20Mean, ci95: spread20CI, ciBonferroni: spread20BonfCI }
      }
    });
    if (global.gc) global.gc();
  }

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    hypothesis: '無料OHLCVデータで検証可能なクロスセクショナル・ファクター4種の一括検証',
    preRegistration: '検証するファクターと期待符号は実行前にコード上で固定した。4件すべての結果を良し悪しに関わらず報告する。',
    multipleTestingNote: `4ファクターを同時検定しているため多重比較の問題がある。95%CIを4回使うと、真に効果がなくても約18%の確率でいずれかが偶然「有意」に見える。そのためBonferroni補正後(${(bonfAlpha * 100).toFixed(2)}%水準=98.75%CI)でも有意なものだけをEDGE_CONFIRMEDとし、補正前のみ有意なものはEDGE_LIKELY_BUT_NOT_MULTIPLICITY_ROBUSTとして区別する。`,
    ciCalibrationNote: `移動ブロック・ブートストラップは銘柄横断方向の不確実性を捉えられず標準誤差を約23%過小評価することを合成データで実測した（真のSE 0.0928%に対しブートストラップSE 0.0713%）。補正なしでは効果ゼロのデータでも23%の頻度で「有意」と誤判定した。そのため全ての信頼区間を点推定中心に${CONFIG.ciInflation}倍へ拡大している（この倍率で偽陽性0%・検出力100%を実測）。`,
    config: CONFIG,
    coverage: { stockCount: processed, skipped, totalObservations: allRows.length },
    factors: factorResults
  };

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/factors-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/factors-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/factors-latest.md`, renderMarkdown(report));

  console.log(`\n完了: backtest/results/factors-${runId}.json を出力しました`);
  for (const fr of factorResults) console.log(`  ${fr.key}: ${fr.verdict.conclusion}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# ファクター一括検証 結果 (${report.runId})`);
  lines.push('');
  lines.push(`> **事前登録**: ${report.preRegistration}`);
  lines.push('');
  lines.push(`> **多重比較について**: ${report.multipleTestingNote}`);
  lines.push('');
  lines.push(`> **信頼区間の較正について**: ${report.ciCalibrationNote}`);
  lines.push('');
  lines.push(`- 対象銘柄: ${report.coverage.stockCount}（スキップ ${report.coverage.skipped}）`);
  lines.push(`- 観測数: ${report.coverage.totalObservations}件`);
  lines.push('');
  lines.push('## 判定サマリー');
  lines.push('');
  lines.push('| ファクター | 期待符号 | 20日スプレッド(%) | 95%CI | Bonferroni補正CI | 判定 |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of report.factors) {
    const v = f.verdict;
    lines.push(`| ${f.key} ${f.label} | ${f.expectedSign > 0 ? '+' : '-'} | ${v.spread20d.meanPct} | [${v.spread20d.ci95[0]}, ${v.spread20d.ci95[1]}] | [${v.spread20d.ciBonferroni[0]}, ${v.spread20d.ciBonferroni[1]}] | ${v.conclusion} |`);
  }
  lines.push('');
  for (const f of report.factors) {
    lines.push(`## ${f.key} — ${f.label}`);
    lines.push('');
    lines.push(`- 検証理由: ${f.rationale}`);
    lines.push(`- 単調性: Spearman ρ=${f.robustness.spearmanRho20d}（期待通り: ${f.robustness.monotonicAsExpected ? '✅' : '❌'}）`);
    lines.push(`- サブ期間で期待符号と一致: ${f.robustness.subPeriodsConsistent}/3`);
    lines.push('');
    lines.push('| 分位点 | n | 20日超過リターン(%) | 95%CI |');
    lines.push('|---|---|---|---|');
    for (const q of QUINTILES) {
      const qq = f.horizons['20d'].quintiles[q];
      lines.push(`| ${q} | ${qq.n} | ${qq.excessMeanPct} | [${qq.excessCI95[0]}, ${qq.excessCI95[1]}] |`);
    }
    lines.push('');
    lines.push('| ホライズン | Q5-Q1スプレッド(%) | 95%CI |');
    lines.push('|---|---|---|');
    for (const hz of report.config.horizons) {
      const h = f.horizons[hz + 'd'];
      lines.push(`| ${hz}d | ${h.spreadMeanPct} | [${h.spreadCI95[0]}, ${h.spreadCI95[1]}] |`);
    }
    lines.push('');
    lines.push('| サブ期間 | 開始 | 終了 | スプレッド平均(%) |');
    lines.push('|---|---|---|---|');
    for (const p of f.robustness.subPeriods) {
      lines.push(`| ${p.label} | ${p.start} | ${p.end} | ${p.spreadMeanPct20d} |`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
