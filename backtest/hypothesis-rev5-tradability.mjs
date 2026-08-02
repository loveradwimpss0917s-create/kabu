// backtest/hypothesis-rev5-tradability.mjs — Step3-(5): 短期リバーサル(rev5)の実用性判定
//
// 背景: hypothesis-factors.mjs で事前登録した20日ホライズンの検定では4ファクターとも
// 優位性を確認できなかったが、rev5だけは短いホライズン(1日・5日)でCI95が0を除外し、
// 単調性(ρ=-0.9)・サブ期間3/3一致という「本物らしい」兆候を示した。
//
// 【重要】5日ホライズンで有意だったことは事前登録した検定ではない（事前登録は20日）。
// したがって本スクリプトは「新たな発見の主張」ではなく、既に見えている手がかりが
// 実際に取引可能かどうかを決着させる実用性判定として位置づける。
// 新しいファクターは追加しない（同じデータで試行を重ねるほど偶然の当たりを掴むため）。
//
// 判定したいこと:
//   1. このアプリはロング専用。Q1(直近5日の下落率が大きい銘柄群)を買うだけで
//      市場平均を上回るか？ ロング・ショートのスプレッドではなくロング単独で見る
//   2. 売買コストを差し引いても残るか？ コスト水準を変えた感度分析を行う
//   3. 流動性の高い銘柄に絞っても残るか？ 売買代金の小さい銘柄でしか効かないなら
//      スリッページが想定より大きくなり実用にならない
//
// 統計手法は既存スクリプトと同一（日付単位の事前集計＋移動ブロック・ブートストラップ、
// 異常リターン除外、信頼区間1.5倍の較正）。
//
// 実行: .github/workflows/hypothesis-rev5-tradability.yml から手動実行する

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
  holdBars: 5,              // 保有期間。rev5が有意だった5営業日に固定する
  rev5Lookback: 5,
  turnoverLookback: 20,
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 2000)),
  blockLength: Math.round(num(process.env.BT_BLOCK_LENGTH, 40)),
  ciInflation: num(process.env.BT_CI_INFLATION, 1.5), // 較正根拠はhypothesis-factors.mjsを参照
  periodsPerYear: 50,       // 5営業日保有 ≈ 年50回転
};

// 往復コスト（%）の感度分析。ロング片道ずつの合計。
//   0.30% = 現行前提（片道 手数料5bps+スリッページ10bps）
//   0.10% = 手数料無料・片道スリッページ5bps（国内ネット証券の現実的な下限に近い）
//   0.05% = 極めて楽観的（大型株・板が厚い場合）
//   0.00% = コストゼロ（理論上限。実現不可能だが効果の大きさの参照値）
const COST_SCENARIOS = [
  { key: 'zero', roundTripPct: 0.00, label: 'コストゼロ（理論上限・実現不可）' },
  { key: 'optimistic', roundTripPct: 0.05, label: '極めて楽観的（往復0.05%）' },
  { key: 'realistic', roundTripPct: 0.10, label: '現実的な下限（往復0.10%・手数料無料前提）' },
  { key: 'current', roundTripPct: 0.30, label: '現行前提（往復0.30%）' },
];

// 流動性フィルタ。その日の売買代金の上位何%に絞るか。
// 効果が低流動性銘柄でしか出ないなら、実際のスリッページは想定を大きく超え実用にならない
const LIQUIDITY_TIERS = [
  { key: 'all', topPct: 1.00, label: '全銘柄' },
  { key: 'top50', topPct: 0.50, label: '売買代金 上位50%' },
  { key: 'top20', topPct: 0.20, label: '売買代金 上位20%' },
  { key: 'top10', topPct: 0.10, label: '売買代金 上位10%（大型株中心）' },
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
function percentileRaw(values, pLow, pHigh) {
  const valid = values.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return [null, null];
  return [valid[Math.floor(pLow * valid.length)], valid[Math.min(valid.length - 1, Math.floor(pHigh * valid.length))]];
}
function ciFrom(bootMeans, pointEstimate) {
  const [lo, hi] = percentileRaw(bootMeans, 0.025, 0.975);
  if (lo == null || hi == null) return [null, null];
  if (pointEstimate == null) return [round(lo, 3), round(hi, 3)];
  const k = CONFIG.ciInflation;
  return [round(pointEstimate - (pointEstimate - lo) * k, 3), round(pointEstimate + (hi - pointEstimate) * k, 3)];
}

// ── 1銘柄分: rev5・売買代金・5日先リターンを計算（ルックアヘッドなし） ──────
function computeStockRows(chart) {
  const { o, c, v, dates } = buildAdjustedSeries(chart);
  const hz = CONFIG.holdBars;
  const warmup = Math.max(CONFIG.rev5Lookback, CONFIG.turnoverLookback) + 1;
  if (c.length < warmup + hz + 10) return [];

  const rows = [];
  for (let i = warmup; i <= c.length - 1 - hz - 1; i++) {
    const cPast = c[i - CONFIG.rev5Lookback];
    if (!(c[i] > 0) || !(cPast > 0)) continue;

    const toWindow = [];
    for (let k = i - CONFIG.turnoverLookback + 1; k <= i; k++) {
      if (c[k] > 0 && v[k] > 0) toWindow.push(c[k] * v[k]);
    }
    if (toWindow.length < CONFIG.turnoverLookback * 0.8) continue;
    const avgTurnover = mean(toWindow);
    if (!(avgTurnover > 0)) continue;

    const entry = o[i + 1];
    const exit = c[i + hz];
    if (!(entry > 0) || !(exit > 0)) continue;
    const ret = (exit - entry) / entry * 100;
    if (Math.abs(ret) > MAX_PLAUSIBLE_RET_PCT) continue;

    rows.push({
      date: dateStr(dates[i]),
      rev5: (c[i] - cPast) / cPast * 100,
      turnover: avgTurnover,
      ret
    });
  }
  return rows;
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

// 流動性ティアごとに: その日の売買代金上位X%に絞り、その中でrev5の五分位を作り、
// 各分位の「同ティア内ベンチマーク超過リターン」を日付単位で集計する。
// ベンチマークをティア内平均にするのは、比較対象を揃えるため
// （大型株だけを買う戦略は、大型株全体の平均と比べるべき）
function analyzeTier(allRows, topPct) {
  const byDate = new Map();
  for (const r of allRows) {
    let a = byDate.get(r.date);
    if (!a) { a = []; byDate.set(r.date, a); }
    a.push(r);
  }
  const stats = new Map();
  for (const [date, rowsAll] of byDate) {
    let rows = rowsAll;
    if (topPct < 1.0) {
      const sorted = [...rowsAll].sort((a, b) => b.turnover - a.turnover);
      const keep = Math.max(1, Math.floor(sorted.length * topPct));
      rows = sorted.slice(0, keep);
    }
    if (rows.length < 25) continue; // 五分位を作るのに最低限必要な銘柄数
    const bench = mean(rows.map(r => r.ret));
    const sorted = [...rows].sort((a, b) => a.rev5 - b.rev5);
    const n = sorted.length;
    const s = { quintiles: {} };
    for (let qi = 0; qi < 5; qi++) {
      const from = Math.floor(n * qi / 5), to = Math.floor(n * (qi + 1) / 5);
      const slice = sorted.slice(from, to);
      const m = mean(slice.map(r => r.ret - bench));
      s.quintiles[QUINTILES[qi]] = { excess: m, count: slice.length };
    }
    stats.set(date, s);
  }
  return stats;
}

function bootstrapQuintiles(dateList, stats, iters) {
  const acc = Object.fromEntries(QUINTILES.map(q => [q, []]));
  for (let iter = 0; iter < iters; iter++) {
    const seq = buildBlockedDateSequence(dateList, CONFIG.blockLength);
    const sums = Object.fromEntries(QUINTILES.map(q => [q, { sum: 0, n: 0 }]));
    for (const d of seq) {
      const st = stats.get(d);
      if (!st) continue;
      for (const q of QUINTILES) {
        const g = st.quintiles[q];
        if (g.excess != null) { sums[q].sum += g.excess; sums[q].n++; }
      }
    }
    for (const q of QUINTILES) acc[q].push(sums[q].n ? sums[q].sum / sums[q].n : null);
  }
  return acc;
}

async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log('目的: rev5(短期リバーサル)がロング専用・コスト差引後でも実用になるかの判定');
  console.log('※ 5日ホライズンでの有意性は事前登録した検定ではない（事前登録は20日）。実用性判定として扱う');

  const allRows = [];
  let processed = 0, skipped = 0;
  for await (const { code, series } of iterateCachedSeries(100)) {
    processed++;
    if (processed % 400 === 0) console.log(`  ...${processed}銘柄処理済み`);
    try {
      if (!series) { skipped++; continue; }
      const rows = computeStockRows(series);
      if (!rows.length) skipped++; else allRows.push(...rows);
    } catch (e) { skipped++; }
  }
  console.log(`読み込み完了: ${processed}銘柄（スキップ${skipped}） 観測数=${allRows.length}件`);
  if (!allRows.length) { console.error('有効なデータがありません。'); process.exit(1); }

  const tierResults = [];
  for (const tier of LIQUIDITY_TIERS) {
    console.log(`\n[${tier.key}] ${tier.label} を集計中...`);
    const stats = analyzeTier(allRows, tier.topPct);
    const dateList = [...stats.keys()].sort();
    if (!dateList.length) { console.log(`[${tier.key}] 対象日なし。スキップ`); continue; }
    console.log(`[${tier.key}] 対象営業日数: ${dateList.length}日。ブートストラップ中...`);
    const boots = bootstrapQuintiles(dateList, stats, CONFIG.bootstrapIters);

    const quintiles = {};
    for (const q of QUINTILES) {
      const vals = [...stats.values()].map(s => s.quintiles[q].excess).filter(v => v != null);
      const pt = mean(vals);
      quintiles[q] = { excessMeanPct: round(pt, 3), excessCI95: ciFrom(boots[q], pt) };
    }

    // ロング専用Q1のコスト差引後評価。1回転あたり (Q1超過リターン - 往復コスト)
    const q1pt = quintiles['Q1'].excessMeanPct;
    const q1ci = quintiles['Q1'].excessCI95;
    const costScenarios = COST_SCENARIOS.map(cs => {
      const netPerTrade = q1pt != null ? q1pt - cs.roundTripPct : null;
      const netCI = (q1ci[0] != null && q1ci[1] != null) ? [round(q1ci[0] - cs.roundTripPct, 3), round(q1ci[1] - cs.roundTripPct, 3)] : [null, null];
      return {
        key: cs.key, label: cs.label, roundTripPct: cs.roundTripPct,
        netPerTradePct: round(netPerTrade, 3),
        netCI95: netCI,
        netAnnualizedPct: round(netPerTrade != null ? netPerTrade * CONFIG.periodsPerYear : null, 2),
        // 「確実に勝てる」と言えるのはCI下限がプラスのときのみ
        profitableWithConfidence: netCI[0] != null && netCI[0] > 0
      };
    });

    const anyProfitable = costScenarios.some(cs => cs.profitableWithConfidence);
    console.log(`[${tier.key}] Q1超過=${q1pt}% CI=[${q1ci}] → コスト差引後に有意にプラスとなるシナリオ: ${anyProfitable ? 'あり' : 'なし'}`);

    tierResults.push({
      key: tier.key, label: tier.label, topPct: tier.topPct,
      tradingDays: dateList.length,
      quintiles, costScenarios, anyProfitable
    });
  }

  const anyTierTradable = tierResults.some(t => t.anyProfitable);
  const conclusion = anyTierTradable ? 'TRADABLE_UNDER_SOME_COST_ASSUMPTION' : 'NOT_TRADABLE';

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    purpose: 'rev5(短期リバーサル)の実用性判定 — ロング専用・コスト差引後・流動性別',
    caveat: '5日ホライズンでの有意性は事前登録した検定ではない（事前登録は20日ホライズン）。' +
      'したがって本結果は新たな発見の主張ではなく、既に見えている手がかりの実用性を確認するもの。' +
      '仮に有望に見えても、実運用前に将来データでの追試（アウト・オブ・サンプル検証）が必須である。',
    config: CONFIG,
    coverage: { stockCount: processed, skipped, totalObservations: allRows.length },
    tiers: tierResults,
    verdict: { conclusion, anyTierTradable }
  };

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/rev5-tradability-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/rev5-tradability-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/rev5-tradability-latest.md`, renderMarkdown(report));
  console.log(`\n完了: 判定=${conclusion}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(report) {
  const L = [];
  L.push(`# rev5 短期リバーサル 実用性判定 (${report.runId})`);
  L.push('');
  L.push(`> **注意**: ${report.caveat}`);
  L.push('');
  L.push(`- 対象銘柄: ${report.coverage.stockCount}（スキップ ${report.coverage.skipped}）`);
  L.push(`- 観測数: ${report.coverage.totalObservations}件`);
  L.push(`- 保有期間: ${report.config.holdBars}営業日（年約${report.config.periodsPerYear}回転）`);
  L.push('');
  L.push(`## 総合判定: ${report.verdict.conclusion}`);
  L.push('');
  L.push(report.verdict.anyTierTradable
    ? '一部の流動性ティア・コスト前提で、コスト差引後もプラスが統計的に確認された。'
    : '**すべての流動性ティア・すべてのコスト前提で、コスト差引後にプラスとなることを統計的に確認できなかった。**');
  L.push('');
  for (const t of report.tiers) {
    L.push(`## ${t.label}（対象 ${t.tradingDays}営業日）`);
    L.push('');
    L.push('### rev5五分位別の超過リターン（同ティア内平均比・5日保有・コスト差引前）');
    L.push('');
    L.push('| 分位点 | 超過リターン(%) | 95%CI |');
    L.push('|---|---|---|');
    for (const q of QUINTILES) {
      const qq = t.quintiles[q];
      L.push(`| ${q}${q === 'Q1' ? '（直近5日で最も下落＝買い候補）' : q === 'Q5' ? '（直近5日で最も上昇）' : ''} | ${qq.excessMeanPct} | [${qq.excessCI95[0]}, ${qq.excessCI95[1]}] |`);
    }
    L.push('');
    L.push('### Q1をロングで買った場合のコスト差引後');
    L.push('');
    L.push('| コスト前提 | 往復コスト(%) | 1回転あたり純損益(%) | 95%CI | 年換算(%) | 統計的にプラスと言えるか |');
    L.push('|---|---|---|---|---|---|');
    for (const cs of t.costScenarios) {
      L.push(`| ${cs.label} | ${cs.roundTripPct.toFixed(2)} | ${cs.netPerTradePct} | [${cs.netCI95[0]}, ${cs.netCI95[1]}] | ${cs.netAnnualizedPct} | ${cs.profitableWithConfidence ? '✅' : '❌'} |`);
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
