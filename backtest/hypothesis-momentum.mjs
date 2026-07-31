// backtest/hypothesis-momentum.mjs — Step3-(2): クロスセクショナル・モメンタム(12-1)の検証
//
// 仮説: 過去12ヶ月のリターンが高い銘柄（直近1ヶ月は除外）は、その後も
// 市場平均を上回り続ける（Jegadeesh & Titman 1993 型の学術的モメンタム）。
// 直近1ヶ月を除くのは、短期リバーサル（PEADサニティチェックで実際に検出した、
// 急変動後の反動）が12ヶ月モメンタムに混入するのを避けるため。
//
// これはbacktest/run.mjsのスコア帯（固定の0-100点閾値）とは異なり、
// 「その日その日の全銘柄の中での相対順位」でグループ分けする必要がある
// （クロスセクショナル分位点）。日付ごとに全銘柄のモメンタム値を集めて
// 分位点を決め、各銘柄をその日のQ1(下位20%)〜Q5(上位20%)に割り当てる。
//
// 統計手法はbacktest/run.mjs・hypothesis-pead.mjsと同一
// （日付単位の事前集計＋移動ブロック・ブートストラップ、異常リターン除外も同じ閾値）。
//
// 実行: .github/workflows/hypothesis-momentum.yml から手動実行する

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
  lookbackBars: Math.round(num(process.env.BT_MOM_LOOKBACK, 252)), // 12ヶ月 ≈ 252営業日
  skipBars: Math.round(num(process.env.BT_MOM_SKIP, 21)),          // 直近1ヶ月 ≈ 21営業日を除外
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 2000)),
  blockLength: Math.round(num(process.env.BT_BLOCK_LENGTH, 40)),
};

const QUINTILES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
const QUINTILE_LABEL = { Q1: '下位20%(loser)', Q2: '下位40-20%', Q3: '中位', Q4: '上位40-20%', Q5: '上位20%(winner)' };
const MAX_PLAUSIBLE_RET_PCT = 1000; // run.mjsで実データにより確認済みの閾値

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
function percentileCI(values) {
  const valid = values.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return [null, null];
  const lo = valid[Math.floor(0.025 * valid.length)];
  const hi = valid[Math.min(valid.length - 1, Math.floor(0.975 * valid.length))];
  return [round(lo, 3), round(hi, 3)];
}
function quantile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

// ── 1銘柄分: 12-1モメンタム値と将来リターンを計算（ルックアヘッドなし） ──────
// モメンタム値はi-skipBars時点までの過去lookbackBars区間のリターン（直近1ヶ月は除く）。
// エントリーは翌営業日の始値、エグジットはi+horizon日の終値（run.mjsと同じ規約）
function computeMomentumRows(code, chart) {
  const { o, c, dates } = buildAdjustedSeries(chart);
  const maxHorizon = Math.max(...CONFIG.horizons);
  const need = CONFIG.lookbackBars + CONFIG.skipBars;
  if (c.length < need + maxHorizon + 10) return [];

  const rows = [];
  for (let i = need; i <= c.length - 1 - maxHorizon - 1; i++) {
    const refIdx = i - CONFIG.skipBars;       // 直近1ヶ月を除いた基準日
    const baseIdx = refIdx - CONFIG.lookbackBars; // 12ヶ月前
    const baseClose = c[baseIdx], refClose = c[refIdx];
    if (!(baseClose > 0) || !(refClose > 0)) continue;
    const mom = (refClose - baseClose) / baseClose * 100;

    const entry = o[i + 1];
    if (!(entry > 0)) continue;
    const row = { code, date: dateStr(dates[i]), mom: round(mom, 3) };
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

// ── 日付別ベンチマーク（run.mjsと同じ考え方。行への書き戻しはしない） ───────
function computeBenchmark(allRows) {
  const byDate = new Map();
  for (const r of allRows) {
    let s = byDate.get(r.date);
    if (!s) { s = {}; for (const hz of CONFIG.horizons) s[hz] = { sum: 0, count: 0 }; byDate.set(r.date, s); }
    for (const hz of CONFIG.horizons) {
      const v = r['ret' + hz];
      if (v != null) { s[hz].sum += v; s[hz].count++; }
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

// ── 日付別クロスセクショナル分位点（その日の全銘柄のモメンタム値から決める） ──
function computeQuantileCutoffs(allRows) {
  const byDate = new Map();
  for (const r of allRows) {
    if (r.mom == null) continue;
    let arr = byDate.get(r.date);
    if (!arr) { arr = []; byDate.set(r.date, arr); }
    arr.push(r.mom);
  }
  const cutoffs = new Map();
  for (const [date, arr] of byDate) {
    const sorted = [...arr].sort((a, b) => a - b);
    cutoffs.set(date, {
      p20: quantile(sorted, 0.20), p40: quantile(sorted, 0.40),
      p60: quantile(sorted, 0.60), p80: quantile(sorted, 0.80)
    });
  }
  return cutoffs;
}
function quintileOf(r, cutoffs) {
  const c = cutoffs.get(r.date);
  if (!c || r.mom == null) return null;
  if (r.mom <= c.p20) return 'Q1';
  if (r.mom <= c.p40) return 'Q2';
  if (r.mom <= c.p60) return 'Q3';
  if (r.mom <= c.p80) return 'Q4';
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

// 日付×分位点別に事前集計（run.mjsのbuildDateStatsと同じ考え方）。
// 併せてQ5-Q1スプレッド（ロング・ショート・ポートフォリオ）も日付単位で保持する
function buildDateStats(allRows, benchmark, cutoffs) {
  const stats = new Map();
  for (const r of allRows) {
    const q = quintileOf(r, cutoffs);
    if (!q) continue;
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
  // スプレッド = その日のQ5平均超過リターン - Q1平均超過リターン（両方に十分なnがある日のみ）
  for (const [date, s] of stats) {
    s.spread = {};
    for (const hz of CONFIG.horizons) {
      const q5 = s.quintiles['Q5'][hz], q1 = s.quintiles['Q1'][hz];
      s.spread[hz] = (q5.count > 0 && q1.count > 0) ? (q5.sum / q5.count) - (q1.sum / q1.count) : null;
    }
  }
  return stats;
}

function bootstrapQuintileCI(dateList, dateStats, quintile, hz, iters) {
  const means = [];
  for (let iter = 0; iter < iters; iter++) {
    const seq = buildBlockedDateSequence(dateList, CONFIG.blockLength);
    let sum = 0, count = 0;
    for (const d of seq) {
      const st = dateStats.get(d);
      if (!st) continue;
      const g = st.quintiles[quintile][hz];
      sum += g.sum; count += g.count;
    }
    means.push(count > 0 ? sum / count : null);
  }
  return percentileCI(means);
}

function bootstrapSpreadCI(dateList, dateStats, hz, iters) {
  const means = [];
  for (let iter = 0; iter < iters; iter++) {
    const seq = buildBlockedDateSequence(dateList, CONFIG.blockLength);
    const vals = [];
    for (const d of seq) {
      const st = dateStats.get(d);
      if (st && st.spread[hz] != null) vals.push(st.spread[hz]);
    }
    means.push(vals.length ? mean(vals) : null);
  }
  return percentileCI(means);
}

async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log('データ取得元: Supabase(bt_prices_cache)。決算・信用取引データは使用しない');

  const nameMap = await fetchUniverseNames();
  console.log(`ユニバース件数: ${nameMap.size}`);

  const allRows = [];
  const skippedStocks = [];
  let processed = 0;
  const PAGE_SIZE = 100;
  for await (const { code, series } of iterateCachedSeries(PAGE_SIZE)) {
    processed++;
    const name = nameMap.get(code) || code;
    if (processed % 200 === 0) console.log(`  ...${processed}銘柄処理済み`);
    try {
      if (!series) { skippedStocks.push({ code, name, reason: 'cache_error' }); continue; }
      const rows = computeMomentumRows(code, series);
      if (!rows.length) skippedStocks.push({ code, name, reason: 'insufficient_data' });
      else allRows.push(...rows);
    } catch (e) {
      skippedStocks.push({ code, name, reason: e.message });
    }
  }
  console.log(`キャッシュから読み込み完了: ${processed}銘柄（有効${processed - skippedStocks.length} / スキップ${skippedStocks.length}）`);
  console.log(`観測数: ${allRows.length}件`);

  if (!allRows.length) {
    console.error('有効なデータが1件もありません。');
    process.exit(1);
  }

  console.log('ベンチマーク・クロスセクショナル分位点を計算中...');
  const benchmark = computeBenchmark(allRows);
  const cutoffs = computeQuantileCutoffs(allRows);

  const dateStats = buildDateStats(allRows, benchmark, cutoffs);
  const dateList = [...dateStats.keys()].sort();
  console.log(`対象営業日数: ${dateList.length}日。ブートストラップ実行中（${CONFIG.bootstrapIters}回 × 分位点/スプレッド）...`);

  const quintileResults = {};
  for (const q of QUINTILES) {
    const horizons = {};
    for (const hz of CONFIG.horizons) {
      let sum = 0, count = 0;
      for (const s of dateStats.values()) { sum += s.quintiles[q][hz].sum; count += s.quintiles[q][hz].count; }
      horizons[hz + 'd'] = {
        n: count,
        excessMeanPct: round(count ? sum / count : null, 3),
        excessCI95: bootstrapQuintileCI(dateList, dateStats, q, hz, CONFIG.bootstrapIters)
      };
    }
    quintileResults[q] = { quintile: q, label: QUINTILE_LABEL[q], horizons };
  }

  const spread20 = bootstrapSpreadCI(dateList, dateStats, 20, CONFIG.bootstrapIters);
  const spreadHorizons = {};
  for (const hz of CONFIG.horizons) {
    const vals = [...dateStats.values()].map(s => s.spread[hz]).filter(v => v != null);
    spreadHorizons[hz + 'd'] = { meanPct: round(mean(vals), 3), CI95: bootstrapSpreadCI(dateList, dateStats, hz, CONFIG.bootstrapIters) };
  }

  // 単調性: Q1→Q5でexcessMeanPct(20d)が単調増加しているか
  const means20 = QUINTILES.map(q => quintileResults[q].horizons['20d'].excessMeanPct);
  const validIdx = means20.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
  const spearmanRho = validIdx.length >= 2 ? round(pearson(rankOf(validIdx.map(i => i + 1)), rankOf(validIdx.map(i => means20[i]))), 4) : null;

  // サブ期間安定性（Q5-Q1スプレッド）
  const allDates = dateList;
  const n = allDates.length;
  const chunkSize = Math.ceil(n / 3);
  const subPeriods = [0, 1, 2].map(k => {
    const datesInChunk = allDates.slice(k * chunkSize, (k + 1) * chunkSize);
    const vals = datesInChunk.map(d => { const s = dateStats.get(d); return s ? s.spread[20] : null; }).filter(v => v != null);
    return { label: 'Y' + (k + 1), start: datesInChunk[0] || null, end: datesInChunk[datesInChunk.length - 1] || null, n: vals.length, spreadMeanPct20d: round(mean(vals), 3) };
  });

  const criterion1 = spread20[0] != null && spread20[0] > 0;
  const criterion2 = spearmanRho != null && spearmanRho >= 0.8;
  const criterion3 = subPeriods.filter(p => p.spreadMeanPct20d != null && p.spreadMeanPct20d > 0).length >= 2;
  const conclusion = (criterion1 && criterion2 && criterion3) ? 'EDGE_CONFIRMED' : 'EDGE_NOT_CONFIRMED';

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    hypothesis: 'クロスセクショナル・モメンタム(12-1) — 過去12ヶ月(直近1ヶ月除く)のリターンが高い銘柄は市場平均を上回り続けるか',
    config: CONFIG,
    universe: { stockCount: processed, scoredStockCount: processed - skippedStocks.length, startDate: dateList[0], endDate: dateList[dateList.length - 1] },
    coverage: { totalObservations: allRows.length, skippedStocks: skippedStocks.length },
    quintiles: QUINTILES.map(q => quintileResults[q]),
    spread: { description: 'Q5(winner)-Q1(loser)の超過リターン差（ロング・ショート・ポートフォリオ相当）', horizons: spreadHorizons },
    robustness: { spearmanRho20d: spearmanRho, subPeriods },
    verdict: {
      criterion1_spread20dCI95LowerAboveZero: criterion1,
      criterion1_detail: { spreadCI95_20d: spread20 },
      criterion2_monotonicitySpearmanAtLeast08: criterion2,
      criterion2_detail: { rho20d: spearmanRho },
      criterion3_signPositiveIn2of3SubPeriods: criterion3,
      criterion3_detail: { positiveSubPeriods: subPeriods.filter(p => p.spreadMeanPct20d != null && p.spreadMeanPct20d > 0).length, of: 3 },
      conclusion
    }
  };

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/momentum-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/momentum-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/momentum-latest.md`, renderMarkdown(report));

  console.log(`\n完了: backtest/results/momentum-${runId}.json を出力しました`);
  console.log(`判定: ${conclusion}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# モメンタム(12-1) 検証結果 (${report.runId})`);
  lines.push('');
  lines.push(`- 対象期間: ${report.universe.startDate} 〜 ${report.universe.endDate}`);
  lines.push(`- 対象銘柄: ${report.universe.scoredStockCount} / ${report.universe.stockCount}`);
  lines.push(`- 観測数: ${report.coverage.totalObservations}件`);
  lines.push(`- モメンタム定義: 過去${report.config.lookbackBars}営業日リターン（直近${report.config.skipBars}営業日は除外）`);
  lines.push('');
  lines.push(`## 判定: ${report.verdict.conclusion}`);
  lines.push('');
  lines.push('| 条件 | 結果 |');
  lines.push('|---|---|');
  lines.push(`| ① Q5-Q1スプレッド 20日CI95%下限>0 | ${report.verdict.criterion1_spread20dCI95LowerAboveZero ? '✅' : '❌'} (下限=${report.verdict.criterion1_detail.spreadCI95_20d[0]}) |`);
  lines.push(`| ② 分位点の単調性 Spearman ρ≥0.8 | ${report.verdict.criterion2_monotonicitySpearmanAtLeast08 ? '✅' : '❌'} (ρ=${report.verdict.criterion2_detail.rho20d}) |`);
  lines.push(`| ③ 3サブ期間中2つ以上でスプレッド>0 | ${report.verdict.criterion3_signPositiveIn2of3SubPeriods ? '✅' : '❌'} (${report.verdict.criterion3_detail.positiveSubPeriods}/3) |`);
  lines.push('');
  lines.push('## 分位点別・20日超過リターン（市場平均比）');
  lines.push('');
  lines.push('| 分位点 | n | 平均(%) | 95%CI |');
  lines.push('|---|---|---|---|');
  for (const q of report.quintiles) {
    const h = q.horizons['20d'];
    lines.push(`| ${q.quintile} ${q.label} | ${h.n} | ${h.excessMeanPct} | [${h.excessCI95[0]}, ${h.excessCI95[1]}] |`);
  }
  lines.push('');
  lines.push('## Q5-Q1スプレッド（ロング・ショート）');
  lines.push('');
  lines.push('| ホライズン | 平均(%) | 95%CI |');
  lines.push('|---|---|---|');
  for (const hz of report.config.horizons) {
    const h = report.spread.horizons[hz + 'd'];
    lines.push(`| ${hz}d | ${h.meanPct} | [${h.CI95[0]}, ${h.CI95[1]}] |`);
  }
  lines.push('');
  lines.push('## サブ期間安定性（Q5-Q1スプレッド・20日）');
  lines.push('');
  lines.push('| 期間 | 開始 | 終了 | n | スプレッド平均(%) |');
  lines.push('|---|---|---|---|---|');
  for (const p of report.robustness.subPeriods) {
    lines.push(`| ${p.label} | ${p.start} | ${p.end} | ${p.n} | ${p.spreadMeanPct20d} |`);
  }
  return lines.join('\n') + '\n';
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
