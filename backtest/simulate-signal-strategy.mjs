// backtest/simulate-signal-strategy.mjs — 「スコア通りにトレードしたら資産はどう推移したか」
//
// これまでの検証はスコア帯別の平均リターンや統計的有意性を出してきたが、
// 「実際に資金を投じたら資産がどう推移したか」という形では一度も示していない。
// このスクリプトはそれを資産推移カーブとして出力し、アプリ内で表示できるようにする。
//
// ## シミュレーションの規則
// - 保有期間H営業日ごとにリバランスする（期間が重複しないため二重計上が起きない）
// - リバランス日に条件を満たす銘柄を等金額で買い、H営業日後に全て売る
// - エントリーは判定日の翌営業日の始値、エグジットはH営業日後の終値（run.mjsと同じ規約）
// - 売買のたびに往復コストを差し引く
// - ベンチマークは「全銘柄を等金額で買って持ち続ける」ケース（コストなし）。
//   アクティブに売買する戦略と、何もしない場合を比較するため
//
// ## 正直に併記すべき限界（レポートにも出力する）
// 1. イン・サンプル。過去データへの事後評価であり、将来の再現は保証されない
// 2. 生存バイアス。ユニバースは現在存在する銘柄の固定リストで、
//    過去に上場廃止になった企業を含まない。結果は構造的に上方バイアスを持つ
// 3. アプリの表示スコアとは完全一致しない。バックテストのスコアには
//    地合い調整（日経225の状態による-5〜-25点）と決算veto（決算7日前は中立化）が
//    含まれていない。実際のアプリはこれらを適用するため、同じ日に同じ銘柄でも
//    表示スコアはずれうる
// 4. 分割不可能性を無視している。等金額配分は端株を前提とした理論値であり、
//    単元100株の制約や少額資金での実現可能性は考慮していない
//
// 実行: .github/workflows/simulate-signal-strategy.yml から手動実行する

import { calcTradeScore, buildAdjustedSeries } from '../indicators.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZocHdtYWZuYnptdGplbWxkbWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxOTA5OTQsImV4cCI6MjA5Nzc2Njk5NH0.DUlD9QbME-ReQY7ujlA172sMObR1JRay7dJAqoPq4-U';

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

const CONFIG = {
  holdBars: Math.round(num(process.env.BT_HOLD_BARS, 20)),  // リバランス間隔＝保有期間
  warmupBars: 250,
  roundTripPct: num(process.env.BT_ROUND_TRIP_PCT, 0.30),   // 往復コスト（既定0.30%＝現行前提）
  tradingDaysPerYear: 250,
  minStocksPerRebalance: 3,  // これ未満しか候補がない日はその期間を現金保有として扱う
};
const MAX_PLAUSIBLE_RET_PCT = 1000;

// 比較する戦略。アプリのシグナル表示と対応させる
const STRATEGIES = [
  { key: 'strongbuy', label: '最上位帯のみ買う（90点以上）', min: 90, max: 101 },
  { key: 'buyplus', label: '上位帯以上を買う（75点以上）', min: 75, max: 101 },
  { key: 'neutralplus', label: '劣後帯中位以上を買う（50点以上）', min: 50, max: 101 },
  { key: 'worst', label: '【対照】最下位帯のみ買う（30点未満）', min: 0, max: 30 },
];

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

function dateStr(e) { return new Date(e * 1000).toISOString().slice(0, 10); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function round(v, d) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }

function simulateStock(chart) {
  const { o, h, l, c, v, dates } = buildAdjustedSeries(chart);
  const H = CONFIG.holdBars;
  if (c.length < CONFIG.warmupBars + H + 10) return [];
  const rows = [];
  for (let i = CONFIG.warmupBars; i <= c.length - 1 - H; i++) {
    const ts = calcTradeScore(
      o.slice(0, i + 1), h.slice(0, i + 1), l.slice(0, i + 1), c.slice(0, i + 1), v.slice(0, i + 1),
      null, '1d'
    );
    const entry = o[i + 1];
    const exit = c[i + H];
    if (!(entry > 0) || !(exit > 0)) continue;
    const ret = (exit - entry) / entry * 100;
    if (Math.abs(ret) > MAX_PLAUSIBLE_RET_PCT) continue;
    rows.push({ date: dateStr(dates[i]), score: ts.score, ret });
  }
  return rows;
}

// 最大ドローダウン（資産推移の高値からの最大下落率）
function maxDrawdownPct(equityCurve) {
  let peak = -Infinity, maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (1 - p.equity / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function runStrategy(byDate, rebalanceDates, strat, applyCost) {
  let equity = 100;
  const curve = [{ date: rebalanceDates[0], equity: 100 }];
  let periods = 0, winPeriods = 0, cashPeriods = 0;
  for (const d of rebalanceDates) {
    const rows = byDate.get(d) || [];
    const picks = strat
      ? rows.filter(r => r.score >= strat.min && r.score < strat.max)
      : rows; // strat=null はベンチマーク（全銘柄）
    let periodRet;
    if (picks.length < CONFIG.minStocksPerRebalance) {
      // 候補が足りない期間は現金保有（リターン0）。無理に少数銘柄へ集中させない
      periodRet = 0;
      cashPeriods++;
    } else {
      periodRet = mean(picks.map(r => r.ret));
      if (applyCost) periodRet -= CONFIG.roundTripPct;
      periods++;
      if (periodRet > 0) winPeriods++;
    }
    equity *= (1 + periodRet / 100);
    curve.push({ date: d, equity: round(equity, 3) });
  }
  const years = rebalanceDates.length * CONFIG.holdBars / CONFIG.tradingDaysPerYear;
  const totalReturnPct = equity - 100;
  const cagrPct = years > 0 && equity > 0 ? (Math.pow(equity / 100, 1 / years) - 1) * 100 : null;
  return {
    finalEquity: round(equity, 2),
    totalReturnPct: round(totalReturnPct, 2),
    cagrPct: round(cagrPct, 2),
    maxDrawdownPct: round(maxDrawdownPct(curve), 2),
    periodWinRatePct: periods > 0 ? round(winPeriods / periods * 100, 1) : null,
    periods, cashPeriods,
    curve
  };
}

async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log('目的: スコア通りにトレードした場合の資産推移を算出する');

  const allRows = [];
  let processed = 0, skipped = 0;
  for await (const { code, series } of iterateCachedSeries(100)) {
    processed++;
    if (processed % 400 === 0) console.log(`  ...${processed}銘柄処理済み`);
    try {
      if (!series) { skipped++; continue; }
      const rows = simulateStock(series);
      if (!rows.length) skipped++; else allRows.push(...rows);
    } catch (e) { skipped++; }
  }
  console.log(`読み込み完了: ${processed}銘柄（スキップ${skipped}） 観測数=${allRows.length}件`);
  if (!allRows.length) { console.error('有効なデータがありません。'); process.exit(1); }

  const byDate = new Map();
  for (const r of allRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const allDates = [...byDate.keys()].sort();
  // 保有期間ごとに区切ったリバランス日（期間が重複しないので二重計上が起きない）
  const rebalanceDates = [];
  for (let i = 0; i < allDates.length; i += CONFIG.holdBars) rebalanceDates.push(allDates[i]);
  console.log(`対象営業日=${allDates.length}日 → リバランス回数=${rebalanceDates.length}回（${CONFIG.holdBars}営業日ごと）`);

  const benchmark = runStrategy(byDate, rebalanceDates, null, false);
  console.log(`ベンチマーク（全銘柄を買って持ち続ける・コストなし）: 最終資産${benchmark.finalEquity} 年率${benchmark.cagrPct}% 最大DD${benchmark.maxDrawdownPct}%`);

  const strategies = STRATEGIES.map(s => {
    const r = runStrategy(byDate, rebalanceDates, s, true);
    console.log(`${s.label}: 最終資産${r.finalEquity} 年率${r.cagrPct}% 最大DD${r.maxDrawdownPct}% 期間勝率${r.periodWinRatePct}% (現金期間${r.cashPeriods}回)`);
    return { ...s, ...r, vsBenchmarkCagrPct: round((r.cagrPct != null && benchmark.cagrPct != null) ? r.cagrPct - benchmark.cagrPct : null, 2) };
  });

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    purpose: 'スコア通りにトレードした場合の資産推移（元本100として表示）',
    caveats: [
      'イン・サンプル（過去データへの事後評価）であり、将来の再現は保証されない。',
      '生存バイアス: ユニバースは現在存在する銘柄の固定リストで、過去に上場廃止となった企業を含まない。結果は構造的に上方バイアスを持つ。',
      'アプリの表示スコアと完全一致しない: バックテストのスコアには地合い調整（-5〜-25点）と決算veto（決算7日前は中立化）が含まれていない。',
      '等金額配分は端株を前提とした理論値であり、単元100株の制約や少額資金での実現可能性は考慮していない。',
      'ベンチマークは売買コストを払わない「全銘柄を買って持ち続ける」ケース。アクティブに売買する戦略と何もしない場合の比較になっている。'
    ],
    config: CONFIG,
    coverage: {
      stockCount: processed, skipped, totalObservations: allRows.length,
      startDate: allDates[0], endDate: allDates[allDates.length - 1],
      rebalanceCount: rebalanceDates.length
    },
    benchmark: { key: 'benchmark', label: '全銘柄を買って持ち続ける（コストなし）', ...benchmark },
    strategies
  };

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/strategy-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/strategy-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/strategy-latest.md`, renderMarkdown(report));
  console.log(`\n完了: backtest/results/strategy-latest.json を出力しました`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(r) {
  const L = [];
  L.push(`# スコア通りにトレードした場合の資産推移 (${r.runId})`);
  L.push('');
  L.push('## 前提と限界（必ず読むこと）');
  L.push('');
  for (const c of r.caveats) L.push(`- ${c}`);
  L.push('');
  L.push(`- 対象: ${r.coverage.stockCount}銘柄 / ${r.coverage.startDate} 〜 ${r.coverage.endDate}`);
  L.push(`- 保有期間: ${r.config.holdBars}営業日ごとにリバランス（計${r.coverage.rebalanceCount}回）`);
  L.push(`- 往復売買コスト: ${r.config.roundTripPct}%`);
  L.push('');
  L.push('## 結果（元本100が最終いくらになったか）');
  L.push('');
  L.push('| 戦略 | 最終資産 | 総リターン | 年率 | 最大DD | 期間勝率 | 年率(ベンチ比) |');
  L.push('|---|---|---|---|---|---|---|');
  const b = r.benchmark;
  L.push(`| ${b.label} | ${b.finalEquity} | ${b.totalReturnPct}% | ${b.cagrPct}% | ${b.maxDrawdownPct}% | ${b.periodWinRatePct}% | — |`);
  for (const s of r.strategies) {
    L.push(`| ${s.label} | ${s.finalEquity} | ${s.totalReturnPct}% | ${s.cagrPct}% | ${s.maxDrawdownPct}% | ${s.periodWinRatePct}% | ${s.vsBenchmarkCagrPct > 0 ? '+' : ''}${s.vsBenchmarkCagrPct}% |`);
  }
  L.push('');
  const beat = r.strategies.filter(s => s.vsBenchmarkCagrPct != null && s.vsBenchmarkCagrPct > 0);
  L.push('## 結論');
  L.push('');
  L.push(beat.length
    ? `ベンチマーク（何もせず全銘柄を持ち続ける）を年率で上回った戦略: ${beat.map(s => s.label).join(' / ')}。ただし上記の限界（特に生存バイアスとイン・サンプル）を踏まえて解釈すること。`
    : '**どの戦略もベンチマーク（何もせず全銘柄を持ち続ける）を年率で上回りませんでした。** 売買コストを払ってスコアに従って売買するより、何もしない方が結果が良かったことを意味します。');
  return L.join('\n') + '\n';
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
