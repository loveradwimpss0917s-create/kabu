// backtest/hypothesis-holding-period.mjs — 上位スコア帯を「勝てる構造」にできるかの検証
//
// ## なぜこの検証を行うか（新しい仮説探しではない）
//
// backtest/results/latest.md の報告値には往復売買コスト0.30%が最初から
// 差し引かれていた（run.mjsは「コストを払って売買する戦略」対「コストを払わず
// 持ちっぱなしの市場平均」を比較する設計）。コストを戻すと実際にはこうなっている:
//
//   バケット   グロス平均  ベンチマーク  差(コスト前)
//   0-30        1.484%      1.551%      -0.067%
//   30-50       0.965%      1.017%      -0.052%
//   50-75       0.740%      0.773%      -0.033%
//   75-90       0.983%      0.727%      +0.256%   ← 上位帯には優位性がある
//   90-100      0.986%      0.737%      +0.249%
//
// つまり上位帯には20営業日あたり約+0.25%のグロス優位性が存在し、それを
// 往復0.30%のコストが丸ごと食い尽くしている。したがって必要なのは
// 新しいシグナルではなく「0.25%がコストを上回る構造」である。
//
// コストは1往復あたり固定なので、保有期間を延ばせば1回のコストで得られる
// グロスが増える。この検証はその一点だけを問う:
//
//   **保有期間を延ばしたとき、上位帯のグロス優位性はどう変化し、
//     コスト差引後の年率が最大になる保有期間はどこか？**
//
// これは新しい仮説の探索ではなく、コストの数式から直接導かれる構造的な問い。
// 事前登録: 検証する保有期間・コスト水準・判定基準は実行前に固定する。
//
// ## 統計手法
// 既存スクリプトと同一（日付単位の事前集計＋移動ブロック・ブートストラップ、
// 異常リターン除外、信頼区間1.5倍の較正）。ただし保有期間が長いほど
// 前方リターンの窓が重なるため、ブロック長を保有期間に応じて伸ばす
// （blockLength = max(40, 2×保有期間)）。長期ほど有効ブロック数が減るため、
// レポートに有効ブロック数を明示し、検出力の限界を隠さない。
//
// 実行: .github/workflows/hypothesis-holding-period.yml から手動実行する

import { calcTradeScore, buildAdjustedSeries } from '../indicators.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZocHdtYWZuYnptdGplbWxkbWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxOTA5OTQsImV4cCI6MjA5Nzc2Njk5NH0.DUlD9QbME-ReQY7ujlA172sMObR1JRay7dJAqoPq4-U';

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

// 事前登録: 実行後に書き換えないこと
const CONFIG = {
  horizons: [20, 40, 60, 120],   // 検証する保有期間（営業日）
  warmupBars: 250,
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 1000)),
  ciInflation: num(process.env.BT_CI_INFLATION, 1.5),
  tradingDaysPerYear: 250,
};
// 往復コスト(%)。0.30%は現行前提、0.10%は手数料無料の国内ネット証券を想定した現実的な下限
const COST_SCENARIOS = [0.30, 0.20, 0.10, 0.05];
// 「上位帯」の定義。事前登録として75点以上に固定する（結果を見てから閾値を動かさない）
const TOP_BAND_MIN = 75;
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

function dateStr(e) { return new Date(e * 1000).toISOString().slice(0, 10); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function round(v, d) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }
function percentileRaw(values, pLow, pHigh) {
  const valid = values.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return [null, null];
  return [valid[Math.floor(pLow * valid.length)], valid[Math.min(valid.length - 1, Math.floor(pHigh * valid.length))]];
}
function ciFrom(bootMeans, point) {
  const [lo, hi] = percentileRaw(bootMeans, 0.025, 0.975);
  if (lo == null || hi == null || point == null) return [null, null];
  const k = CONFIG.ciInflation;
  return [round(point - (point - lo) * k, 3), round(point + (hi - point) * k, 3)];
}

// ── 1銘柄分: スコアと各保有期間の前方リターンを計算（ルックアヘッドなし） ──
// run.mjsと同じ規約: i日目までのデータのみでスコア計算、エントリーは翌営業日の始値
function simulateStock(chart) {
  const { o, h, l, c, v, dates } = buildAdjustedSeries(chart);
  const maxH = Math.max(...CONFIG.horizons);
  if (c.length < CONFIG.warmupBars + maxH + 10) return [];
  const rows = [];
  for (let i = CONFIG.warmupBars; i <= c.length - 1 - maxH; i++) {
    const ts = calcTradeScore(
      o.slice(0, i + 1), h.slice(0, i + 1), l.slice(0, i + 1), c.slice(0, i + 1), v.slice(0, i + 1),
      null, '1d'
    );
    const entry = o[i + 1];
    if (!(entry > 0)) continue;
    const row = { date: dateStr(dates[i]), score: ts.score };
    let ok = true;
    for (const hz of CONFIG.horizons) {
      const exit = c[i + hz];
      if (!(exit > 0)) { ok = false; break; }
      const ret = (exit - entry) / entry * 100;
      if (Math.abs(ret) > MAX_PLAUSIBLE_RET_PCT) { ok = false; break; }
      row['ret' + hz] = ret;
    }
    if (ok) rows.push(row);
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

// 日付ごとに「上位帯の平均リターン」と「全銘柄の平均リターン(ベンチマーク)」を集計し、
// その差＝グロス超過リターンを日次系列として持つ。コストはここでは引かない
// （後段でコスト水準ごとに差し引くため）
function buildDateStats(allRows, hz) {
  const stats = new Map();
  for (const r of allRows) {
    const ret = r['ret' + hz];
    if (ret == null) continue;
    let s = stats.get(r.date);
    if (!s) { s = { top: { sum: 0, n: 0 }, all: { sum: 0, n: 0 } }; stats.set(r.date, s); }
    s.all.sum += ret; s.all.n++;
    if (r.score >= TOP_BAND_MIN) { s.top.sum += ret; s.top.n++; }
  }
  const daily = new Map();
  for (const [date, s] of stats) {
    if (s.top.n === 0 || s.all.n === 0) continue;
    daily.set(date, s.top.sum / s.top.n - s.all.sum / s.all.n);
  }
  return daily;
}

async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log(`上位帯の定義: スコア${TOP_BAND_MIN}点以上（事前登録・固定）`);
  console.log(`検証するコスト水準(往復%): ${COST_SCENARIOS.join(', ')}`);
  console.log('目的: 保有期間を延ばしたとき、上位帯のグロス優位性がコストを上回る構造になるか');

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

  const results = [];
  for (const hz of CONFIG.horizons) {
    const daily = buildDateStats(allRows, hz);
    const dateList = [...daily.keys()].sort();
    if (!dateList.length) { console.log(`[${hz}日] 対象日なし`); continue; }

    // 前方リターンの窓が重なるためブロック長を保有期間に比例させる
    const blockLength = Math.max(40, hz * 2);
    const effectiveBlocks = Math.floor(dateList.length / blockLength);
    const point = mean(dateList.map(d => daily.get(d)));

    const boots = [];
    for (let it = 0; it < CONFIG.bootstrapIters; it++) {
      const seq = buildBlockedDateSequence(dateList, blockLength);
      boots.push(mean(seq.map(d => daily.get(d))));
    }
    const ci = ciFrom(boots, point);

    // 年率換算: 保有期間hz日なら年間 250/hz 回転する
    const turnsPerYear = CONFIG.tradingDaysPerYear / hz;
    const costs = COST_SCENARIOS.map(cost => {
      const netPerTrade = point - cost;
      const netCI = [round(ci[0] - cost, 3), round(ci[1] - cost, 3)];
      return {
        roundTripPct: cost,
        netPerTradePct: round(netPerTrade, 3),
        netCI95: netCI,
        netAnnualPct: round(netPerTrade * turnsPerYear, 2),
        // CI下限がプラスのときのみ「統計的にプラス」と言える
        profitableWithConfidence: netCI[0] != null && netCI[0] > 0
      };
    });

    console.log(`[${hz}日] グロス超過=${round(point, 3)}% CI=[${ci}] 年${turnsPerYear.toFixed(1)}回転 有効ブロック数=${effectiveBlocks}`);
    for (const c of costs) {
      console.log(`   往復${c.roundTripPct.toFixed(2)}% → 1回転${c.netPerTradePct}% 年率${c.netAnnualPct}% ${c.profitableWithConfidence ? '✅' : '❌'}`);
    }

    results.push({
      horizonDays: hz, tradingDays: dateList.length, blockLength, effectiveBlocks,
      turnsPerYear: round(turnsPerYear, 2),
      grossExcessPct: round(point, 3), grossExcessCI95: ci,
      grossSignificant: ci[0] != null && ci[0] > 0,
      costScenarios: costs
    });
  }

  const best = results
    .flatMap(r => r.costScenarios.map(c => ({ hz: r.horizonDays, ...c })))
    .filter(x => x.profitableWithConfidence)
    .sort((a, b) => b.netAnnualPct - a.netAnnualPct)[0] || null;

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    purpose: '上位スコア帯(75点以上)の優位性が、保有期間を延ばすことでコストを上回る構造になるかの検証',
    rationale: 'backtest/results/latest.mdの報告値には往復0.30%のコストが最初から差し引かれていた。' +
      'コストを戻すと上位帯には20営業日あたり約+0.25%のグロス優位性が存在する。' +
      'コストは1往復あたり固定なので、保有期間を延ばせば1回のコストで得られるグロスが増える。' +
      'この検証はその一点だけを問うものであり、新しい仮説の探索ではない。',
    preRegistration: '保有期間・コスト水準・上位帯の定義(75点以上)は実行前に固定した。全結果を良し悪しに関わらず報告する。',
    limitation: '保有期間が長いほど前方リターンの窓が重なるためブロック長を伸ばしており、その分だけ有効ブロック数が減り検出力が落ちる。' +
      '各保有期間のeffectiveBlocksを確認すること。また本検証はイン・サンプルであり、実運用前にアウト・オブ・サンプル検証が必須である。',
    config: CONFIG, topBandMin: TOP_BAND_MIN,
    coverage: { stockCount: processed, skipped, totalObservations: allRows.length },
    horizons: results,
    bestProfitable: best
  };

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/holding-period-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/holding-period-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/holding-period-latest.md`, renderMarkdown(report));
  console.log(`\n完了: ${best ? `最良= 保有${best.hz}日・往復${best.roundTripPct}% → 年率${best.netAnnualPct}%` : 'コスト差引後にプラスとなる組み合わせなし'}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(r) {
  const L = [];
  L.push(`# 上位帯×保有期間 検証結果 (${r.runId})`);
  L.push('');
  L.push(`> **検証の動機**: ${r.rationale}`);
  L.push('');
  L.push(`> **事前登録**: ${r.preRegistration}`);
  L.push('');
  L.push(`> **限界**: ${r.limitation}`);
  L.push('');
  L.push(`- 対象銘柄: ${r.coverage.stockCount}（スキップ ${r.coverage.skipped}） / 観測数: ${r.coverage.totalObservations}件`);
  L.push(`- 上位帯: スコア${r.topBandMin}点以上`);
  L.push('');
  L.push('## 保有期間別のグロス優位性（コスト差引前・市場平均比）');
  L.push('');
  L.push('| 保有期間 | 年間回転数 | グロス超過(%) | 95%CI | 有意 | 有効ブロック数 |');
  L.push('|---|---|---|---|---|---|');
  for (const h of r.horizons) {
    L.push(`| ${h.horizonDays}日 | ${h.turnsPerYear} | ${h.grossExcessPct} | [${h.grossExcessCI95[0]}, ${h.grossExcessCI95[1]}] | ${h.grossSignificant ? '✅' : '❌'} | ${h.effectiveBlocks} |`);
  }
  L.push('');
  L.push('## コスト差引後の年率');
  L.push('');
  L.push('| 保有期間 | 往復コスト | 1回転あたり(%) | 95%CI | 年率(%) | 統計的にプラス |');
  L.push('|---|---|---|---|---|---|');
  for (const h of r.horizons) {
    for (const c of h.costScenarios) {
      L.push(`| ${h.horizonDays}日 | ${c.roundTripPct.toFixed(2)}% | ${c.netPerTradePct} | [${c.netCI95[0]}, ${c.netCI95[1]}] | ${c.netAnnualPct} | ${c.profitableWithConfidence ? '✅' : '❌'} |`);
    }
  }
  L.push('');
  L.push('## 結論');
  L.push('');
  L.push(r.bestProfitable
    ? `統計的にプラスと言える組み合わせのうち最良は **保有${r.bestProfitable.hz}営業日・往復コスト${r.bestProfitable.roundTripPct}% → 年率${r.bestProfitable.netAnnualPct}%** です。ただしイン・サンプルの結果であり、実運用前にアウト・オブ・サンプル検証が必要です。`
    : '**どの保有期間・どのコスト水準でも、コスト差引後にプラスとなることを統計的に確認できませんでした。**');
  return L.join('\n') + '\n';
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
