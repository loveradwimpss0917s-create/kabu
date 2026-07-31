// backtest/hypothesis-sector.mjs — Step3-(3): セクター相対強度の検証
//
// 仮説: 直近で強い業種（トレイリングリターンが高いセクター）に属する銘柄は、
// その後も市場平均を上回り続ける（資金が向かっている業種への追随・セクターローテーション）。
//
// backtest/hypothesis-momentum.mjs（個別銘柄のクロスセクショナル分位点）よりさらに
// 一段階複雑で、二段階のクロスセクショナル集計が必要:
//   1. 銘柄ごとのトレイリングリターン(60営業日=3ヶ月)を計算
//   2. 日付ごとに「同じ業種の銘柄群」で平均し、業種のトレイリングリターンを求める
//   3. その日の全業種をランク付けし、上位/中位/下位の三分位に分ける
//   4. 各銘柄が属する業種の三分位に応じて、将来リターンを集計する
//
// 業種分類はscripts/fetch-sector-map.mjsでYahoo Finance(assetProfile)から
// キャッシュ済み（Supabase: sector_map）。umihico/kabu-json由来のbt_universeには
// 業種情報がないため、この専用キャッシュが必要だった。
//
// 統計手法はrun.mjs・hypothesis-pead.mjs・hypothesis-momentum.mjsと同一
// （日付単位の事前集計＋移動ブロック・ブートストラップ、異常リターン除外も同じ閾値）。
//
// 実行: .github/workflows/hypothesis-sector.yml から手動実行する

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
  sectorLookback: Math.round(num(process.env.BT_SECTOR_LOOKBACK, 60)), // 業種トレイリングリターン算出期間(≈3ヶ月)
  minStocksPerSectorDate: 3, // その日その業種の平均を計算するのに必要な最低銘柄数
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 2000)),
  blockLength: Math.round(num(process.env.BT_BLOCK_LENGTH, 40)),
};

const TERCILES = ['bottom', 'mid', 'top'];
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

async function fetchAllRows(table, select) {
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const q = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=${PAGE}&offset=${offset}`;
    const res = await fetchWithRetry(q, { headers: anonHeaders });
    if (!res.ok) throw new Error(`${table}取得失敗: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function fetchSectorMap() {
  const rows = await fetchAllRows('sector_map', 'code,sector');
  const map = new Map();
  for (const r of rows) if (r.sector) map.set(r.code, r.sector);
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

// ── 1銘柄分: トレイリングリターンと将来リターンを計算（ルックアヘッドなし） ──
function computeStockRows(code, sector, chart) {
  const { o, c, dates } = buildAdjustedSeries(chart);
  const maxHorizon = Math.max(...CONFIG.horizons);
  const L = CONFIG.sectorLookback;
  if (c.length < L + maxHorizon + 10) return [];

  const rows = [];
  for (let i = L; i <= c.length - 1 - maxHorizon - 1; i++) {
    const baseClose = c[i - L];
    if (!(baseClose > 0) || !(c[i] > 0)) continue;
    const trailingRet = (c[i] - baseClose) / baseClose * 100;

    const entry = o[i + 1];
    if (!(entry > 0)) continue;
    const row = { code, sector, date: dateStr(dates[i]), trailingRet: round(trailingRet, 3) };
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

// ── 日付×業種のトレイリングリターン平均を求め、その日の業種ランキングから
// 上位/中位/下位の三分位を決める ──────────────────────────────────────────
function computeSectorTercilesByDate(allRows) {
  const bySectorDate = new Map(); // date -> Map<sector, {sum,count}>
  for (const r of allRows) {
    if (r.trailingRet == null) continue;
    let bySector = bySectorDate.get(r.date);
    if (!bySector) { bySector = new Map(); bySectorDate.set(r.date, bySector); }
    let s = bySector.get(r.sector);
    if (!s) { s = { sum: 0, count: 0 }; bySector.set(r.sector, s); }
    s.sum += r.trailingRet; s.count++;
  }

  const tercileByDate = new Map(); // date -> Map<sector, 'top'|'mid'|'bottom'>
  for (const [date, bySector] of bySectorDate) {
    const entries = [...bySector.entries()]
      .filter(([, s]) => s.count >= CONFIG.minStocksPerSectorDate)
      .map(([sector, s]) => [sector, s.sum / s.count]);
    if (entries.length < 3) continue; // 三分位に分けるには最低3業種必要
    entries.sort((a, b) => a[1] - b[1]);
    const n = entries.length;
    const thirds = Math.ceil(n / 3);
    const map = new Map();
    entries.forEach(([sector], idx) => {
      const tercile = idx < thirds ? 'bottom' : idx < n - thirds ? 'mid' : 'top';
      map.set(sector, tercile);
    });
    tercileByDate.set(date, map);
  }
  return tercileByDate;
}
function tercileOf(r, tercileByDate) {
  const m = tercileByDate.get(r.date);
  return m ? (m.get(r.sector) || null) : null;
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

function buildDateStats(allRows, benchmark, tercileByDate) {
  const stats = new Map();
  for (const r of allRows) {
    const t = tercileOf(r, tercileByDate);
    if (!t) continue;
    let s = stats.get(r.date);
    if (!s) {
      s = { tercile: {}, spread: {} };
      for (const tl of TERCILES) s.tercile[tl] = Object.fromEntries(CONFIG.horizons.map(hz => [hz, { sum: 0, count: 0 }]));
      stats.set(r.date, s);
    }
    for (const hz of CONFIG.horizons) {
      const ev = excessOf(r, hz, benchmark);
      if (ev == null) continue;
      s.tercile[t][hz].sum += ev; s.tercile[t][hz].count++;
    }
  }
  for (const [, s] of stats) {
    s.spread = {};
    for (const hz of CONFIG.horizons) {
      const top = s.tercile['top'][hz], bottom = s.tercile['bottom'][hz];
      s.spread[hz] = (top.count > 0 && bottom.count > 0) ? (top.sum / top.count) - (bottom.sum / bottom.count) : null;
    }
  }
  return stats;
}

function bootstrapTercileCI(dateList, dateStats, tercile, hz, iters) {
  const means = [];
  for (let iter = 0; iter < iters; iter++) {
    const seq = buildBlockedDateSequence(dateList, CONFIG.blockLength);
    let sum = 0, count = 0;
    for (const d of seq) {
      const st = dateStats.get(d);
      if (!st) continue;
      const g = st.tercile[tercile][hz];
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
  console.log('データ取得元: Supabase(bt_prices_cache, sector_map)');

  const sectorMap = await fetchSectorMap();
  console.log(`業種分類の件数: ${sectorMap.size}`);

  const allRows = [];
  const skippedStocks = [];
  let processed = 0, noSectorCount = 0;
  const PAGE_SIZE = 100;
  for await (const { code, series } of iterateCachedSeries(PAGE_SIZE)) {
    processed++;
    if (processed % 200 === 0) console.log(`  ...${processed}銘柄処理済み`);
    const sector = sectorMap.get(code);
    if (!sector) { noSectorCount++; continue; }
    try {
      if (!series) { skippedStocks.push({ code, reason: 'cache_error' }); continue; }
      const rows = computeStockRows(code, sector, series);
      if (!rows.length) skippedStocks.push({ code, reason: 'insufficient_data' });
      else allRows.push(...rows);
    } catch (e) {
      skippedStocks.push({ code, reason: e.message });
    }
  }
  console.log(`キャッシュから読み込み完了: ${processed}銘柄（業種不明のためスキップ${noSectorCount} / その他スキップ${skippedStocks.length}）`);
  console.log(`観測数: ${allRows.length}件`);

  if (!allRows.length) {
    console.error('有効なデータが1件もありません。');
    process.exit(1);
  }

  console.log('ベンチマーク・業種トレイリングリターン・三分位を計算中...');
  const benchmark = computeBenchmark(allRows);
  const tercileByDate = computeSectorTercilesByDate(allRows);

  const dateStats = buildDateStats(allRows, benchmark, tercileByDate);
  const dateList = [...dateStats.keys()].sort();
  console.log(`対象営業日数: ${dateList.length}日。ブートストラップ実行中（${CONFIG.bootstrapIters}回 × 三分位/スプレッド）...`);

  const tercileResults = {};
  for (const t of TERCILES) {
    const horizons = {};
    for (const hz of CONFIG.horizons) {
      let sum = 0, count = 0;
      for (const s of dateStats.values()) { sum += s.tercile[t][hz].sum; count += s.tercile[t][hz].count; }
      horizons[hz + 'd'] = {
        n: count,
        excessMeanPct: round(count ? sum / count : null, 3),
        excessCI95: bootstrapTercileCI(dateList, dateStats, t, hz, CONFIG.bootstrapIters)
      };
    }
    tercileResults[t] = { tercile: t, horizons };
  }

  const spreadHorizons = {};
  for (const hz of CONFIG.horizons) {
    const vals = [...dateStats.values()].map(s => s.spread[hz]).filter(v => v != null);
    spreadHorizons[hz + 'd'] = { meanPct: round(mean(vals), 3), CI95: bootstrapSpreadCI(dateList, dateStats, hz, CONFIG.bootstrapIters) };
  }
  const spread20 = spreadHorizons['20d'].CI95;

  const means20 = TERCILES.map(t => tercileResults[t].horizons['20d'].excessMeanPct);
  const validIdx = means20.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
  const spearmanRho = validIdx.length >= 2 ? round(pearson(rankOf(validIdx.map(i => i + 1)), rankOf(validIdx.map(i => means20[i]))), 4) : null;

  const n = dateList.length;
  const chunkSize = Math.ceil(n / 3);
  const subPeriods = [0, 1, 2].map(k => {
    const datesInChunk = dateList.slice(k * chunkSize, (k + 1) * chunkSize);
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
    hypothesis: 'セクター相対強度 — 直近3ヶ月のトレイリングリターンが高い業種に属する銘柄は市場平均を上回り続けるか',
    dataLimitation: 'Yahoo Finance(assetProfile)の業種分類を使用。ETF等を除いた普通株のみだが、' +
      '業種粒度はYahooの分類基準に依存し、東証33業種分類とは一致しない。',
    config: CONFIG,
    universe: { stockCount: processed, sectorCount: new Set([...sectorMap.values()]).size },
    coverage: { totalObservations: allRows.length, noSectorCount, skippedStocks: skippedStocks.length },
    tercile: TERCILES.map(t => tercileResults[t]),
    spread: { description: 'top(上位業種)-bottom(下位業種)の超過リターン差', horizons: spreadHorizons },
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
  writeFileSync(`${outDir}/sector-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/sector-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/sector-latest.md`, renderMarkdown(report));

  console.log(`\n完了: backtest/results/sector-${runId}.json を出力しました`);
  console.log(`判定: ${conclusion}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# セクター相対強度 検証結果 (${report.runId})`);
  lines.push('');
  lines.push(`> ${report.dataLimitation}`);
  lines.push('');
  lines.push(`- 対象銘柄: ${report.universe.stockCount}（業種数: ${report.universe.sectorCount}）`);
  lines.push(`- 業種トレイリングリターン算出期間: ${report.config.sectorLookback}営業日`);
  lines.push(`- 観測数: ${report.coverage.totalObservations}件（業種不明でスキップ: ${report.coverage.noSectorCount}）`);
  lines.push('');
  lines.push(`## 判定: ${report.verdict.conclusion}`);
  lines.push('');
  lines.push('| 条件 | 結果 |');
  lines.push('|---|---|');
  lines.push(`| ① top-bottomスプレッド 20日CI95%下限>0 | ${report.verdict.criterion1_spread20dCI95LowerAboveZero ? '✅' : '❌'} (下限=${report.verdict.criterion1_detail.spreadCI95_20d[0]}) |`);
  lines.push(`| ② 三分位の単調性 Spearman ρ≥0.8 | ${report.verdict.criterion2_monotonicitySpearmanAtLeast08 ? '✅' : '❌'} (ρ=${report.verdict.criterion2_detail.rho20d}) |`);
  lines.push(`| ③ 3サブ期間中2つ以上でスプレッド>0 | ${report.verdict.criterion3_signPositiveIn2of3SubPeriods ? '✅' : '❌'} (${report.verdict.criterion3_detail.positiveSubPeriods}/3) |`);
  lines.push('');
  lines.push('## 業種三分位別・20日超過リターン（市場平均比）');
  lines.push('');
  lines.push('| 三分位 | n | 平均(%) | 95%CI |');
  lines.push('|---|---|---|---|');
  for (const t of report.tercile) {
    const h = t.horizons['20d'];
    lines.push(`| ${t.tercile} | ${h.n} | ${h.excessMeanPct} | [${h.excessCI95[0]}, ${h.excessCI95[1]}] |`);
  }
  lines.push('');
  lines.push('## top-bottomスプレッド');
  lines.push('');
  lines.push('| ホライズン | 平均(%) | 95%CI |');
  lines.push('|---|---|---|');
  for (const hz of report.config.horizons) {
    const h = report.spread.horizons[hz + 'd'];
    lines.push(`| ${hz}d | ${h.meanPct} | [${h.CI95[0]}, ${h.CI95[1]}] |`);
  }
  lines.push('');
  lines.push('## サブ期間安定性（top-bottomスプレッド・20日）');
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
