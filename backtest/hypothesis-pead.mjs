// backtest/hypothesis-pead.mjs — Step3-(1): PEAD（決算後ドリフト）のサニティチェック
//
// 目的: 「サプライズ後、株価は数日〜数週間かけて同方向にドリフトする」という
// 学術的に確立されたアノマリー(Post-Earnings-Announcement Drift)を、
// この測定環境（Supabaseキャッシュ + 移動ブロック・ブートストラップ）が
// 検出できるかどうかのサニティチェック。既知のアノマリーを検出できなければ、
// 以後のモメンタム・セクター相対強度・信用需給の各仮説で「効かなかった」と
// 出ても、それが測定環境の検出力不足によるものなのか、真に効かないのかを
// 区別できない（ユーザーの明示的な懸念事項）。
//
// データ制約（重要・正直に書く）:
// Yahoo Financeから3,575銘柄×10年分の実際の決算発表日・サプライズ（実績/予想比）を
// 無料枠で取得することは現実的でない（quoteSummaryのearningsHistoryは直近4四半期
// 程度しか提供されない）。そのため、決算発表に類似した「急な株価変動+出来高急増」を
// サプライズイベントの代理指標として使う。これは真のSUE（標準化予想外利益）ベースの
// 検証ではなく、あくまで代理指標である。この代理指標でPEADが検出できても、決算固有の
// ドリフトを証明したことにはならない（決算以外の材料によるジャンプも混入するため）。
// あくまで「この測定環境が既知の継続性アノマリーを拾えるか」の確認に限定して解釈する。
//
// 統計手法はbacktest/run.mjsと同一（日付単位の事前集計＋移動ブロック・ブートストラップ）。
// 素朴なt検定・単純日付リサンプリングは使わない。
//
// 実行: GitHub Actions の workflow_dispatch から起動する
//       （.github/workflows/hypothesis.yml, name=pead）

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
  volLookback: 20,          // 出来高の平常時基準を計算する遡り日数
  retThresholdPct: num(process.env.BT_PEAD_RET_THRESHOLD, 5),      // サプライズ判定: |当日リターン|がこれ以上
  volRatioThreshold: num(process.env.BT_PEAD_VOL_THRESHOLD, 2.0),  // サプライズ判定: 出来高が平常の何倍以上
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 2000)),
  blockLength: Math.round(num(process.env.BT_BLOCK_LENGTH, 40)),
};

// backtest/run.mjsで実データにより確認済みの閾値（上場廃止等のデータ異常を除外）
const MAX_PLAUSIBLE_RET_PCT = 1000;
let implausibleExcluded = 0;

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

async function fetchUniverseNames() {
  const map = new Map();
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const q = `${SUPABASE_URL}/rest/v1/bt_universe?select=code,name&order=code.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetchWithRetry(q, { headers: anonHeaders });
    if (!res.ok) throw new Error(`bt_universe取得失敗: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) map.set(r.code, r.name);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return map;
}

function dateStr(epochSec) { return new Date(epochSec * 1000).toISOString().slice(0, 10); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round(v, d) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }
function percentileCI(values) {
  const valid = values.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return [null, null];
  const lo = valid[Math.floor(0.025 * valid.length)];
  const hi = valid[Math.min(valid.length - 1, Math.floor(0.975 * valid.length))];
  return [round(lo, 3), round(hi, 3)];
}

// ── イベント検出: 「急な株価変動+出来高急増」をサプライズの代理指標として使う ──
// ルックアヘッド防止: イベント判定・方向は日iまでのデータのみで決める。
// エントリーは翌営業日の始値、エグジットは日i+horizonの終値（run.mjsと同じ規約）
function detectEvents(code, chart) {
  const { o, c, v, dates } = buildAdjustedSeries(chart);
  const maxHorizon = Math.max(...CONFIG.horizons);
  const L = CONFIG.volLookback;
  if (c.length < L + maxHorizon + 10) return [];

  const rows = [];
  for (let i = L; i <= c.length - 1 - maxHorizon - 1; i++) {
    const prevClose = c[i - 1];
    if (!(prevClose > 0)) continue;
    const ret1 = (c[i] - prevClose) / prevClose * 100;
    const avgVol = mean(v.slice(i - L, i).filter(x => x != null && x > 0));
    if (!(avgVol > 0) || v[i] == null) continue;
    const volRatio = v[i] / avgVol;
    if (Math.abs(ret1) < CONFIG.retThresholdPct || volRatio < CONFIG.volRatioThreshold) continue;

    const direction = ret1 > 0 ? 1 : -1;
    const entry = o[i + 1];
    if (!(entry > 0)) continue;

    const row = {
      code, date: dateStr(dates[i]), direction,
      eventRet1: round(ret1, 2), volRatio: round(volRatio, 2)
    };
    let ok = true;
    for (const hz of CONFIG.horizons) {
      const exitPrice = c[i + hz];
      if (!(exitPrice > 0)) { ok = false; break; }
      const ret = (exitPrice - entry) / entry * 100;
      if (Math.abs(ret) > MAX_PLAUSIBLE_RET_PCT) { ok = false; implausibleExcluded++; break; }
      row['ret' + hz] = ret;
    }
    if (ok) rows.push(row);
  }
  return rows;
}

// 出来高「以外」の全営業日についても、ベンチマーク（同日・全銘柄の等加重平均リターン）
// 算出のためret1/5/20を計算しておく（イベント日だけでは市場全体の動きを代表できないため）
function computeDailyReturnsForBenchmark(code, chart, benchmarkAccum) {
  const { o, c, dates } = buildAdjustedSeries(chart);
  const maxHorizon = Math.max(...CONFIG.horizons);
  if (c.length < maxHorizon + 10) return;
  for (let i = 0; i <= c.length - 1 - maxHorizon - 1; i++) {
    const entry = o[i + 1];
    if (!(entry > 0)) continue;
    const date = dateStr(dates[i]);
    let s = benchmarkAccum.get(date);
    if (!s) { s = {}; for (const hz of CONFIG.horizons) s[hz] = { sum: 0, count: 0 }; benchmarkAccum.set(date, s); }
    for (const hz of CONFIG.horizons) {
      const exitPrice = c[i + hz];
      if (!(exitPrice > 0)) continue;
      const ret = (exitPrice - entry) / entry * 100;
      if (Math.abs(ret) > MAX_PLAUSIBLE_RET_PCT) continue;
      s[hz].sum += ret; s[hz].count++;
    }
  }
}

function finalizeBenchmark(accum) {
  const benchmark = new Map();
  for (const [date, s] of accum) {
    const b = {};
    for (const hz of CONFIG.horizons) b[hz] = s[hz].count ? s[hz].sum / s[hz].count : null;
    benchmark.set(date, b);
  }
  return benchmark;
}

// 方向調整済み超過リターン: サプライズと同方向にどれだけ市場平均を上回って
// 動き続けたか（PEADの「継続」を検出するための符号付き指標）
function signedExcess(row, hz, benchmark) {
  const ret = row['ret' + hz];
  if (ret == null) return null;
  const b = benchmark.get(row.date);
  const bm = b ? b[hz] : null;
  if (bm == null) return null;
  return row.direction * (ret - bm);
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

// 日付×方向グループ別に事前集計（run.mjsのbuildDateStatsと同じ考え方）
function buildDateStats(rows, benchmark) {
  const stats = new Map();
  for (const r of rows) {
    let s = stats.get(r.date);
    if (!s) {
      s = { pos: {}, neg: {} };
      for (const hz of CONFIG.horizons) { s.pos[hz] = { sum: 0, count: 0 }; s.neg[hz] = { sum: 0, count: 0 }; }
      stats.set(r.date, s);
    }
    const grp = r.direction > 0 ? s.pos : s.neg;
    for (const hz of CONFIG.horizons) {
      const se = signedExcess(r, hz, benchmark);
      if (se == null) continue;
      grp[hz].sum += se; grp[hz].count++;
    }
  }
  return stats;
}

function bootstrapCI(dateList, dateStats, group, hz, iters) {
  const means = [];
  for (let iter = 0; iter < iters; iter++) {
    const seq = buildBlockedDateSequence(dateList, CONFIG.blockLength);
    let sum = 0, count = 0;
    for (const d of seq) {
      const st = dateStats.get(d);
      if (!st) continue;
      const g = st[group][hz];
      sum += g.sum; count += g.count;
    }
    means.push(count > 0 ? sum / count : null);
  }
  return percentileCI(means);
}

async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log('データ取得元: Supabase(bt_prices_cache)。決算日データは使用しない');
  console.log('※ サプライズの代理指標: |当日リターン|>=' + CONFIG.retThresholdPct + '% かつ 出来高>=平常の' + CONFIG.volRatioThreshold + '倍');

  const nameMap = await fetchUniverseNames();
  console.log(`ユニバース件数: ${nameMap.size}`);

  const eventRows = [];
  const benchmarkAccum = new Map();
  const skippedStocks = [];
  let processed = 0;
  const PAGE_SIZE = 100;
  for await (const { code, series } of iterateCachedSeries(PAGE_SIZE)) {
    processed++;
    const name = nameMap.get(code) || code;
    if (processed % 200 === 0) console.log(`  ...${processed}銘柄処理済み`);
    try {
      if (!series) { skippedStocks.push({ code, name, reason: 'cache_error' }); continue; }
      computeDailyReturnsForBenchmark(code, series, benchmarkAccum);
      const evts = detectEvents(code, series);
      if (evts.length) eventRows.push(...evts);
    } catch (e) {
      skippedStocks.push({ code, name, reason: e.message });
    }
  }
  console.log(`キャッシュから読み込み完了: ${processed}銘柄（イベント検出${eventRows.length}件 / スキップ${skippedStocks.length}）`);
  if (implausibleExcluded > 0) console.log(`異常リターン除外: ${implausibleExcluded}件`);

  if (!eventRows.length) {
    console.error('イベントが1件も検出されませんでした。閾値が厳しすぎる可能性があります。');
    process.exit(1);
  }

  const benchmark = finalizeBenchmark(benchmarkAccum);
  const dateStats = buildDateStats(eventRows, benchmark);
  const dateList = [...dateStats.keys()].sort();
  console.log(`イベント対象営業日数: ${dateList.length}日。ブートストラップ実行中（${CONFIG.bootstrapIters}回）...`);

  const posRows = eventRows.filter(r => r.direction > 0);
  const negRows = eventRows.filter(r => r.direction < 0);

  function summarize(rows, group) {
    const horizons = {};
    for (const hz of CONFIG.horizons) {
      const vals = rows.map(r => signedExcess(r, hz, benchmark)).filter(v => v != null);
      horizons[hz + 'd'] = {
        n: vals.length,
        signedExcessMeanPct: round(mean(vals), 3),
        signedExcessMedianPct: round(median(vals), 3),
        signedExcessCI95: bootstrapCI(dateList, dateStats, group, hz, CONFIG.bootstrapIters)
      };
    }
    return horizons;
  }

  const positiveSurprise = { n: posRows.length, horizons: summarize(posRows, 'pos') };
  const negativeSurprise = { n: negRows.length, horizons: summarize(negRows, 'neg') };

  // 判定: 20日ホライズンで正・負サプライズ双方が「継続方向に有意」であれば、
  // この測定環境は既知のアノマリー（PEAD類似の継続性）を検出できると判断する
  const posSig = positiveSurprise.horizons['20d'].signedExcessCI95[0] > 0;
  const negSig = negativeSurprise.horizons['20d'].signedExcessCI95[0] > 0;
  const conclusion = (posSig && negSig) ? 'PEAD_PROXY_DETECTED'
    : (posSig || negSig) ? 'PEAD_PROXY_PARTIALLY_DETECTED'
    : 'PEAD_PROXY_NOT_DETECTED';

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    hypothesis: 'PEAD（決算後ドリフト）のサニティチェック — 測定環境が既知の継続性アノマリーを検出できるかの確認',
    dataLimitation: '実際の決算発表日・サプライズ(SUE)データは使用していない代理指標による検証。' +
      '「価格急変+出来高急増」を決算サプライズの代理として使うため、決算以外の材料によるジャンプも混入する。' +
      'したがって本結果は「決算後ドリフトの証明」ではなく「この測定環境が継続性アノマリーを拾えるかの確認」に限定して解釈すること。',
    config: CONFIG,
    universe: { stockCount: processed, eventStockCount: new Set(eventRows.map(r => r.code)).size },
    coverage: { totalEvents: eventRows.length, skippedStocks, implausibleReturnsExcluded: implausibleExcluded },
    positiveSurprise, negativeSurprise,
    verdict: {
      conclusion,
      criterion_positiveSurpriseContinuation20d: posSig,
      criterion_negativeSurpriseContinuation20d: negSig
    }
  };

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/pead-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/pead-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/pead-latest.md`, renderMarkdown(report));

  console.log(`\n完了: backtest/results/pead-${runId}.json を出力しました`);
  console.log(`判定: ${conclusion}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# PEAD サニティチェック結果 (${report.runId})`);
  lines.push('');
  lines.push(`> ${report.dataLimitation}`);
  lines.push('');
  lines.push(`- 対象銘柄: ${report.universe.stockCount}（イベント検出銘柄: ${report.universe.eventStockCount}）`);
  lines.push(`- イベント検出条件: |当日リターン|≥${report.config.retThresholdPct}% かつ 出来高≥平常${report.config.volRatioThreshold}倍`);
  lines.push(`- 総イベント数: ${report.coverage.totalEvents}件（正サプライズ${report.positiveSurprise.n} / 負サプライズ${report.negativeSurprise.n}）`);
  if (report.coverage.implausibleReturnsExcluded > 0) {
    lines.push(`- 異常リターン除外: ${report.coverage.implausibleReturnsExcluded}件`);
  }
  lines.push('');
  lines.push(`## 判定: ${report.verdict.conclusion}`);
  lines.push('');
  lines.push('| サプライズ方向 | 継続方向に20日で有意? |');
  lines.push('|---|---|');
  lines.push(`| 正（急騰+出来高急増） | ${report.verdict.criterion_positiveSurpriseContinuation20d ? '✅' : '❌'} |`);
  lines.push(`| 負（急落+出来高急増） | ${report.verdict.criterion_negativeSurpriseContinuation20d ? '✅' : '❌'} |`);
  lines.push('');
  lines.push('## 詳細（方向調整済み超過リターン = サプライズと同方向にどれだけ市場平均を上回ったか）');
  lines.push('');
  lines.push('| サプライズ方向 | ホライズン | n | 平均(%) | 中央値(%) | 95%CI |');
  lines.push('|---|---|---|---|---|---|');
  for (const [label, grp] of [['正', report.positiveSurprise], ['負', report.negativeSurprise]]) {
    for (const hz of report.config.horizons) {
      const h = grp.horizons[hz + 'd'];
      lines.push(`| ${label} | ${hz}d | ${h.n} | ${h.signedExcessMeanPct} | ${h.signedExcessMedianPct} | [${h.signedExcessCI95[0]}, ${h.signedExcessCI95[1]}] |`);
    }
  }
  return lines.join('\n') + '\n';
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
