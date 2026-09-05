// backtest/simulate-signal-exit.mjs — シグナル退出方式（ヒステリシス）のバックテスト
//
// ## 検証したい仮説
// これまでの検証(docs/検証結果まとめ_2026-08.md)で、スコアには「勝ち銘柄を選ぶ力」の
// 優位性は確認できていない。一方 simulate-signal-strategy.mjs の20営業日固定リバランス
// 方式は、スコアの予測力とは無関係に年12.5回転(250/20)のコストを常に払う構造になっている。
//
//   「スコアに勝ち銘柄選択力が無くても、明らかに悪化した銘柄だけを避けるフィルターとして
//     使い、シグナルが変化した時だけ売買すれば、回転率を下げてベンチマークに近づける
//     （あるいは上回れる）のではないか」
//
// これを検証する。既存の固定リバランス方式(simulate-signal-strategy.mjs)は一切変更しない。
// 本ファイルは完全に独立した別モードとして追加する。
//
// ## ルックアヘッド防止（絶対順守・既存run.mjsと同じ規約）
// シグナルは常に「その日の終値までのデータ」だけで計算する(calcTradeScoreにslice(0,i+1)を渡す)。
// 売買は必ず「シグナルが確定した日の翌営業日の始値」で執行する。エントリー・退出とも同じ規則:
//
//     signal at day i (i日目の終値までのデータで計算) → execution at day i+1 の始値
//
// 「i日目のスコアが75だったのでi日目の始値で買う」という実装は禁止（本ファイルには存在しない）。
// 下の simulateSignalExit() のループで、日 j の売買判断には必ず score[j-1]（前日終値時点の
// シグナル）だけを使い、当日の score[j] は絶対に参照しない。
//
// ## ヒステリシス（エントリー閾値と退出閾値を分ける）
// ENTRY_MIN(既定75)以上でエントリー候補、EXIT_MIN(既定50)未満で退出シグナル。
// 50〜74の間は「新規エントリーはしないが、保有中なら継続」というだけで、
// 75を跨ぐたびに、あるいは50を跨ぐたびに売買するわけではない
// （状態(FLAT/HOLDING)を保持し、状態遷移が起きた時だけ売買する）。
//
// ## ポートフォリオ会計（既存スクリプトと同じ簡略化）
// 保有銘柄は等ウェイト(1/保有銘柄数)とし、値動きによる日々のウェイトのドリフトや
// それを埋めるための毎日のリバランス売買は考慮しない（run.mjs/simulate-signal-strategy.mjsと
// 同じ簡略化。ここにコストは課さない）。実際に売買イベント（エントリー/退出）が発生した
// 銘柄のその日のリターンにのみ、片道コストを課す。
//
// ## コスト前提（run.mjsと完全に同じ）
// feeBpsOneWay=5bps・slippageBpsOneWay=10bps（既定値、run.mjsと同一）。
// 片道コスト = (fee+slippage)/100 = 0.15%。エントリー執行日・退出執行日それぞれに
// 片道コストを1回ずつ課す（往復で0.30%となり、simulate-signal-strategy.mjsの
// roundTripPct既定値と一致）。ベンチマーク（全銘柄Buy&Hold）にはコストを課さない
// （既存スクリプトと同じ比較設計）。
//
// ## 生存バイアス・異常値
// bt_universe/bt_prices_cache（run.mjs・simulate-signal-strategy.mjsと完全に同一の
// データソース・同一ユニバース）のみを使う。上場廃止銘柄を含まない生存バイアスは
// レポートに明記する。異常リターン(|日次リターン|>1000%。分割・併合・上場廃止時の
// 調整後終値不整合等)を検出した銘柄は、その銘柄の全データを丸ごと解析対象から除外する
// （run.mjsと同じMAX_PLAUSIBLE_RET_PCT=1000を使用。部分的に採用すると状態機械の
// 整合性が崩れるため、行単位ではなく銘柄単位で除外する）。
//
// ## 事前登録（結果を見てから変更しないこと）
// - 本命の閾値: ENTRY_MIN=75 / EXIT_MIN=50（環境変数で変更可能）
// - ヒステリシス幅の探索グリッド: entry∈{75,80} × exit∈{30,40,50,60,70} の10通り。
//   これは「どの組み合わせが一番儲かるか」を選ぶためではなく、ヒステリシス幅と
//   回転率・成績の関係を観察するための事前登録グリッドであり、全結果を報告する。
// - 判定基準（4段階A/B/C/D、最終3値の判定式）はcomputeVerdict()にコードとして固定し、
//   結果を見てから変更しない。
// - Exit effectiveness: 退出シグナル発生後20営業日の順方向リターンが有意にマイナスなら
//   「悪化銘柄を避けるフィルター」仮説を支持する証拠、有意にプラスなら逆効果の証拠とする。
//
// 実行: .github/workflows/simulate-signal-exit.yml から手動実行する

import { calcTradeScore, buildAdjustedSeries } from '../indicators.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZocHdtYWZuYnptdGplbWxkbWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxOTA5OTQsImV4cCI6MjA5Nzc2Njk5NH0.DUlD9QbME-ReQY7ujlA172sMObR1JRay7dJAqoPq4-U';

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

// ── 設定（実行前に固定。結果を見てから変更しないこと） ──────────────────────
const CONFIG = {
  entryMin: num(process.env.BT_ENTRY_MIN, 75),
  exitMin: num(process.env.BT_EXIT_MIN, 50),
  feeBpsOneWay: num(process.env.BT_FEE_BPS, 5),           // run.mjsと同じ既定値
  slippageBpsOneWay: num(process.env.BT_SLIPPAGE_BPS, 10), // run.mjsと同じ既定値
  warmupBars: 250,
  tradingDaysPerYear: 250,
  fixedRebalanceHoldBars: Math.round(num(process.env.BT_FIXED_HOLD_BARS, 20)), // 比較対象の固定リバランス間隔
  minCandidatesForFixedRebalance: 3, // simulate-signal-strategy.mjsと同じガード
  bootstrapIters: Math.round(num(process.env.BT_BOOTSTRAP_ITERS, 2000)),
  blockLength: Math.round(num(process.env.BT_BLOCK_LENGTH, 40)),
  ciInflation: num(process.env.BT_CI_INFLATION, 1.5), // hypothesis-factors.mjs等と同じ較正済み倍率
  exitEffectivenessHorizonBars: 20,
  // ヒステリシス幅の探索グリッド（事前登録・固定）
  sweepEntries: [75, 80],
  sweepExits: [30, 40, 50, 60, 70],
  // 判定の重要度しきい値（事前登録・固定。結果を見てから変えない）
  materialityCagrImprovementPt: 1.0,   // 固定リバランス比+1.0pt/年以上を「明確な改善」とする
  materialityTurnoverReductionPct: 30, // 回転率-30%以上を「回転率が下がった」とする
};
const MAX_PLAUSIBLE_RET_PCT = 1000; // run.mjsと同一
const oneWayCostPct = (CONFIG.feeBpsOneWay + CONFIG.slippageBpsOneWay) / 100;

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
async function fetchUniverseCount() {
  const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/bt_universe?select=code`, { headers: { ...anonHeaders, Prefer: 'count=exact', Range: '0-0' } });
  const cr = res.headers.get('content-range');
  return cr ? parseInt(cr.split('/')[1], 10) : null;
}

// ── 統計ヘルパー（既存の仮説検証スクリプト群と同一の実装） ──────────────────
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stddev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}
function round(v, d) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }
function percentileCI(values, pLow, pHigh) {
  const valid = values.filter(v => v != null).sort((a, b) => a - b);
  if (!valid.length) return [null, null];
  const lo = valid[Math.floor(pLow * valid.length)];
  const hi = valid[Math.min(valid.length - 1, Math.floor(pHigh * valid.length))];
  return [lo, hi];
}
function ciFrom(bootMeans, pointEstimate, pLow, pHigh) {
  const [lo, hi] = percentileCI(bootMeans, pLow, pHigh);
  if (lo == null || hi == null) return [null, null];
  if (pointEstimate == null) return [round(lo, 3), round(hi, 3)];
  const k = CONFIG.ciInflation;
  return [round(pointEstimate - (pointEstimate - lo) * k, 3), round(pointEstimate + (hi - pointEstimate) * k, 3)];
}
function buildBlockedDateSequence(dayList, blockLength) {
  const n = dayList.length;
  const maxStart = Math.max(0, n - blockLength);
  const seq = [];
  while (seq.length < n) {
    const start = Math.floor(Math.random() * (maxStart + 1));
    for (let i = start; i < Math.min(start + blockLength, n) && seq.length < n; i++) seq.push(dayList[i]);
  }
  return seq;
}

// 日付は内部では「エポック秒÷86400を切り捨てた整数（day number）」で持つ。
// 3,658銘柄×約2,500営業日の系列を全銘柄同時に保持するため、文字列ではなく
// 整数キーにしてメモリを節約する（表示用の "YYYY-MM-DD" への変換は出力直前のみ行う）。
function toDayNum(epochSec) { return Math.floor(epochSec / 86400); }
function dayNumToStr(d) { return new Date(d * 86400 * 1000).toISOString().slice(0, 10); }

// ── 1銘柄分のデータ読み込み・スコア計算（ルックアヘッドなし） ────────────────
// score[i] は「i番目の営業日の終値までのデータ」だけを使って計算する
// （calcTradeScoreには常に slice(0, i+1) を渡す。これより先の未来データは一切渡さない）。
// 返す配列はすべて同じ長さNで、日 j の売買判断は必ず score[j-1] を参照する
// （このファイル内で score[j] を日 j の判断に使っている箇所があってはならない）。
function computeStockSeries(code, chart) {
  const { o, h, l, c, v, dates } = buildAdjustedSeries(chart);
  const N = c.length;
  if (N < CONFIG.warmupBars + 30) return { code, reason: 'insufficient_data' };

  // 異常値検査: 隣接日リターンが非現実的に大きい銘柄は、状態機械の整合性を守るため
  // 銘柄ごと丸ごと除外する（上場廃止時の調整後終値不整合等。run.mjsと同じ閾値・同じ考え方）
  for (let i = 1; i < N; i++) {
    if (!(c[i - 1] > 0) || !(c[i] > 0) || !(o[i] > 0)) continue;
    const dRet = (c[i] - c[i - 1]) / c[i - 1] * 100;
    const oRet = (o[i] - c[i - 1]) / c[i - 1] * 100;
    if (Math.abs(dRet) > MAX_PLAUSIBLE_RET_PCT || Math.abs(oRet) > MAX_PLAUSIBLE_RET_PCT) {
      return { code, reason: 'implausible_return' };
    }
  }

  const dayNum = new Int32Array(N);
  for (let i = 0; i < N; i++) dayNum[i] = toDayNum(dates[i]);

  const score = new Float64Array(N).fill(NaN);
  for (let i = CONFIG.warmupBars; i <= N - 2; i++) {
    const ts = calcTradeScore(
      o.slice(0, i + 1), h.slice(0, i + 1), l.slice(0, i + 1), c.slice(0, i + 1), v.slice(0, i + 1),
      null, '1d'
    );
    score[i] = ts.score;
  }

  return { code, N, dayNum, o: Float64Array.from(o), c: Float64Array.from(c), score };
}

// ── シグナル退出方式のシミュレーション（1つのentry/exit組につき全銘柄分） ────
// 状態機械: FLAT → (score[j-1]>=entryMin) → HOLDING(執行はj日の始値)
//           HOLDING → (score[j-1]<exitMin) → FLAT(執行はj日の始値)
// 日 j の判断に使うのは必ず score[j-1]（前日終値時点のシグナル）。score[j]は使わない。
function simulateSignalExit(series, entryMin, exitMin, collectDetail) {
  const byDay = new Map(); // dayNum -> { sum, count, entries, exits }
  const completedTrades = [];
  const exitFwdByDay = collectDetail ? new Map() : null;   // 退出後horizon営業日のリターン
  const holdFwdByDay = collectDetail ? new Map() : null;   // 継続保有中(退出しなかった)のhorizon営業日リターン
  const holdingCountByDay = new Map(); // 日次の保有銘柄数分布用

  for (const s of series) {
    const { N, dayNum, o, c, score } = s;
    let state = 'FLAT';
    let entryIdx = null;
    let logRet = 0; // 現在のトレードの累積対数リターン（トレード単位の勝率・累積リターン集計用）

    for (let j = CONFIG.warmupBars + 1; j <= N - 1; j++) {
      const scPrev = score[j - 1]; // ← 判断材料は必ず前日終値時点のシグナル
      if (Number.isNaN(scPrev)) continue;

      let ret = null, isEntry = false, isExit = false;
      if (state === 'FLAT') {
        if (scPrev >= entryMin) {
          if (!(o[j] > 0) || !(c[j] > 0)) continue;
          ret = (c[j] - o[j]) / o[j] * 100 - oneWayCostPct;
          isEntry = true;
          state = 'HOLDING'; entryIdx = j; logRet = 0;
        }
      } else { // HOLDING
        if (scPrev < exitMin) {
          if (!(o[j] > 0) || !(c[j - 1] > 0)) continue;
          ret = (o[j] - c[j - 1]) / c[j - 1] * 100 - oneWayCostPct;
          isExit = true;
        } else {
          if (!(c[j] > 0) || !(c[j - 1] > 0)) continue;
          ret = (c[j] - c[j - 1]) / c[j - 1] * 100;
        }
      }
      if (ret == null) continue;

      const d = dayNum[j];
      let bucket = byDay.get(d);
      if (!bucket) { bucket = { sum: 0, count: 0, entries: 0, exits: 0 }; byDay.set(d, bucket); }
      bucket.sum += ret; bucket.count++;
      holdingCountByDay.set(d, (holdingCountByDay.get(d) || 0) + 1);
      logRet += Math.log(1 + ret / 100);

      if (isEntry) {
        bucket.entries++;
      } else if (isExit) {
        bucket.exits++;
        const cumRetPct = (Math.exp(logRet) - 1) * 100;
        completedTrades.push({ code: s.code, holdingDays: j - entryIdx, cumRetPct });
        // Exit effectiveness: 退出「しなければ」その後horizon営業日でどうなっていたか
        // （執行価格 o[j] を起点に、退出せず持ち続けた場合の仮想リターン）
        if (collectDetail) {
          const k = j + CONFIG.exitEffectivenessHorizonBars;
          if (k < N && o[j] > 0 && c[k] > 0) {
            const fwd = (c[k] - o[j]) / o[j] * 100;
            let eb = exitFwdByDay.get(d);
            if (!eb) { eb = { sum: 0, count: 0 }; exitFwdByDay.set(d, eb); }
            eb.sum += fwd; eb.count++;
          }
        }
        state = 'FLAT'; entryIdx = null; logRet = 0;
      } else if (collectDetail) {
        // 継続保有（退出しなかった）銘柄の比較用: この時点からhorizon営業日後どうなったか
        const k = j + CONFIG.exitEffectivenessHorizonBars;
        if (k < N && c[j] > 0 && c[k] > 0) {
          const fwd = (c[k] - c[j]) / c[j] * 100;
          let hb = holdFwdByDay.get(d);
          if (!hb) { hb = { sum: 0, count: 0 }; holdFwdByDay.set(d, hb); }
          hb.sum += fwd; hb.count++;
        }
      }
    }
  }

  return { byDay, completedTrades, exitFwdByDay, holdFwdByDay, holdingCountByDay };
}

// ── 資産推移・年率・最大DD・ボラ・シャープの共通計算 ─────────────────────────
function equityCurveFromDailyMeans(byDay, sortedDays) {
  let equity = 100, peak = 100, maxDD = 0;
  const dailyRets = [];
  const curve = [];
  for (const d of sortedDays) {
    const b = byDay.get(d);
    const r = b && b.count > 0 ? b.sum / b.count : 0;
    dailyRets.push(r);
    equity *= (1 + r / 100);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (1 - equity / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    curve.push({ day: d, equity: round(equity, 4) });
  }
  return { equity, maxDD, dailyRets, curve };
}
function annualizeFromPeriodReturns(periodRets, periodsPerYear) {
  const m = mean(periodRets), sd = stddev(periodRets);
  if (m == null || sd == null || sd === 0) return { annVolPct: null, sharpe: null };
  const annVolPct = sd * Math.sqrt(periodsPerYear);
  const annRetPct = m * periodsPerYear;
  return { annVolPct: round(annVolPct, 2), sharpe: round(annRetPct / annVolPct, 3) };
}
function summarizeCurve(label, sortedDays, byDay, years, winRatePct) {
  const { equity, maxDD, dailyRets, curve } = equityCurveFromDailyMeans(byDay, sortedDays);
  const totalReturnPct = equity - 100;
  const cagrPct = years > 0 && equity > 0 ? (Math.pow(equity / 100, 1 / years) - 1) * 100 : null;
  const { annVolPct, sharpe } = annualizeFromPeriodReturns(dailyRets, CONFIG.tradingDaysPerYear);
  return {
    label, finalEquity: round(equity, 2), totalReturnPct: round(totalReturnPct, 2), cagrPct: round(cagrPct, 2),
    maxDrawdownPct: round(maxDD, 2), annVolPct, sharpe, winRatePct: round(winRatePct, 1),
    curve: curve.filter((_, i) => i % Math.max(1, Math.floor(curve.length / 400)) === 0) // 表示用に間引く
  };
}

// ── ベンチマーク: 全銘柄Buy&Hold（コストなし。ここで初めてtradeableな全銘柄を等加重） ──
function simulateBuyHold(series) {
  const byDay = new Map();
  for (const s of series) {
    const { N, dayNum, o, c } = s;
    const start = CONFIG.warmupBars + 1; // signal-exitの評価開始日と揃える(同一の実行可能範囲)
    if (start >= N) continue;
    for (let j = start; j < N; j++) {
      let ret;
      if (j === start) { if (!(o[j] > 0) || !(c[j] > 0)) continue; ret = (c[j] - o[j]) / o[j] * 100; }
      else { if (!(c[j - 1] > 0) || !(c[j] > 0)) continue; ret = (c[j] - c[j - 1]) / c[j - 1] * 100; }
      const d = dayNum[j];
      let b = byDay.get(d);
      if (!b) { b = { sum: 0, count: 0 }; byDay.set(d, b); }
      b.sum += ret; b.count++;
    }
  }
  return byDay;
}

// ── 固定20営業日リバランス（比較用に本スクリプト内で同一データ・同一手法で再計算） ──
// simulate-signal-strategy.mjsは変更しない。ここではその方式を、本スクリプトが
// 既に持っているscore/価格配列を使って再現し、真に同一ユニバース・同一期間・
// 同一コスト前提での比較を可能にする。選定条件はsignal-exitと同じENTRY_MIN以上
// （「同じ銘柄選定ルールで、回転規律だけを変えたらどうなるか」を見るため）。
function simulateFixedRebalance(series, globalDayNums, entryMin) {
  const H = CONFIG.fixedRebalanceHoldBars;
  const rebalanceDays = [];
  for (let i = 0; i < globalDayNums.length; i += H) rebalanceDays.push(globalDayNums[i]);

  // 銘柄ごとに dayNum→index の索引を作る（初回のみ。O(N)で軽い）
  const indexed = series.map(s => {
    const idxByDay = new Map();
    for (let i = 0; i < s.N; i++) idxByDay.set(s.dayNum[i], i);
    return { ...s, idxByDay };
  });

  const periodRets = [];
  let cashPeriods = 0, tradedPeriods = 0, tradedWins = 0;
  const byDay = new Map(); // 資産曲線用（リバランス日にのみ変化。日次表示に合わせて他日は0%とする）

  for (let k = 0; k < rebalanceDays.length - 1; k++) {
    const dEntrySignal = rebalanceDays[k];
    const dExit = rebalanceDays[k + 1];
    const candRets = [];
    for (const s of indexed) {
      const i = s.idxByDay.get(dEntrySignal);
      if (i == null || i < CONFIG.warmupBars || i > s.N - 2) continue;
      const sc = s.score[i];
      if (Number.isNaN(sc) || !(sc >= entryMin)) continue;
      const entryIdx = i + 1;
      if (entryIdx >= s.N) continue;
      const exitIdx = s.idxByDay.get(dExit);
      if (exitIdx == null) continue;
      const entryPrice = s.o[entryIdx], exitPrice = s.c[exitIdx];
      if (!(entryPrice > 0) || !(exitPrice > 0)) continue;
      const ret = (exitPrice - entryPrice) / entryPrice * 100;
      if (Math.abs(ret) > MAX_PLAUSIBLE_RET_PCT) continue;
      candRets.push(ret);
    }
    let periodRet;
    if (candRets.length < CONFIG.minCandidatesForFixedRebalance) { periodRet = 0; cashPeriods++; }
    else {
      periodRet = mean(candRets) - (CONFIG.feeBpsOneWay + CONFIG.slippageBpsOneWay) * 2 / 100;
      tradedPeriods++;
      if (periodRet > 0) tradedWins++;
    }
    periodRets.push(periodRet);
    byDay.set(dEntrySignal, { sum: periodRet, count: 1 });
  }

  let equity = 100, peak = 100, maxDD = 0;
  for (const r of periodRets) {
    equity *= (1 + r / 100);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (1 - equity / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const years = rebalanceDays.length * H / CONFIG.tradingDaysPerYear;
  const cagrPct = years > 0 && equity > 0 ? (Math.pow(equity / 100, 1 / years) - 1) * 100 : null;
  const { annVolPct, sharpe } = annualizeFromPeriodReturns(periodRets, CONFIG.tradingDaysPerYear / H);
  const winRatePct = tradedPeriods > 0 ? round(tradedWins / tradedPeriods * 100, 1) : null;

  // 実際に入替が発生した回数だけを数える（現金期間はノーカウント）。
  // 固定リバランスは1回の入替で保有銘柄「全体」を入れ替えるため、
  // 銘柄単位のシグナル退出方式の「1保有枠あたりの年間入替回数」と同じ単位で比較できる。
  const annualizedTurnover = years > 0 ? tradedPeriods / years : null;
  return {
    label: `固定${H}営業日リバランス（${entryMin}点以上・参照値）`,
    finalEquity: round(equity, 2), totalReturnPct: round(equity - 100, 2), cagrPct: round(cagrPct, 2),
    maxDrawdownPct: round(maxDD, 2), annVolPct, sharpe, winRatePct: round(winRatePct, 1),
    periods: rebalanceDays.length - 1, tradedPeriods, cashPeriods, annualizedTurnover: round(annualizedTurnover, 2),
    transactionCostPctPaid: round(tradedPeriods * (CONFIG.feeBpsOneWay + CONFIG.slippageBpsOneWay) * 2 / 100, 2)
  };
}

// ── 退出効果分析（Exit effectiveness） ─────────────────────────────────────
function summarizeForwardEffect(fwdByDay, label) {
  const days = [...fwdByDay.keys()].sort((a, b) => a - b);
  if (!days.length) return { label, n: 0, meanPct: null, ci95: [null, null] };
  const totalN = days.reduce((a, d) => a + fwdByDay.get(d).count, 0);
  const pointEstimate = days.reduce((a, d) => a + fwdByDay.get(d).sum, 0) / totalN;
  const bootMeans = [];
  for (let iter = 0; iter < CONFIG.bootstrapIters; iter++) {
    const seq = buildBlockedDateSequence(days, CONFIG.blockLength);
    let sum = 0, count = 0;
    for (const d of seq) { const b = fwdByDay.get(d); sum += b.sum; count += b.count; }
    if (count > 0) bootMeans.push(sum / count);
  }
  return { label, n: totalN, nDays: days.length, meanPct: round(pointEstimate, 3), ci95: ciFrom(bootMeans, pointEstimate, 0.025, 0.975) };
}

// ── 判定（4段階A/B/C/D + 最終3値。事前登録した式をそのまま適用する） ─────────
function computeVerdict(benchmark, fixedRebalance, signalExit) {
  const cagrDeltaVsBenchmark = round(signalExit.cagrPct - benchmark.cagrPct, 2);
  const cagrDeltaVsFixed = round(signalExit.cagrPct - fixedRebalance.cagrPct, 2);
  const turnoverReductionPct = fixedRebalance.annualizedTurnover > 0
    ? round((1 - signalExit.annualizedTurnover / fixedRebalance.annualizedTurnover) * 100, 1)
    : null;

  let category, finalVerdict, reason;
  if (signalExit.cagrPct > benchmark.cagrPct) {
    category = 'A'; finalVerdict = 'SIGNAL_EXIT_BEATS_BENCHMARK';
    reason = `シグナル退出方式の年率(${signalExit.cagrPct}%)がベンチマーク(${benchmark.cagrPct}%)を上回った。`;
  } else if (cagrDeltaVsFixed >= CONFIG.materialityCagrImprovementPt) {
    category = 'B'; finalVerdict = 'SIGNAL_EXIT_IMPROVES_BUT_NOT_BEATS';
    reason = `ベンチマークには届かない(${signalExit.cagrPct}% < ${benchmark.cagrPct}%)が、固定リバランス比+${cagrDeltaVsFixed}pt/年 ` +
      `(基準+${CONFIG.materialityCagrImprovementPt}pt以上)の明確な改善があった。`;
  } else if (turnoverReductionPct != null && turnoverReductionPct >= CONFIG.materialityTurnoverReductionPct) {
    category = 'C'; finalVerdict = 'SIGNAL_EXIT_NO_MEANINGFUL_IMPROVEMENT';
    reason = `回転率は${turnoverReductionPct}%低下した(基準${CONFIG.materialityTurnoverReductionPct}%以上)が、` +
      `年率の改善は固定リバランス比+${cagrDeltaVsFixed}ptにとどまり(基準未達)、ベンチマークにも届かなかった。`;
  } else {
    category = 'D'; finalVerdict = 'SIGNAL_EXIT_NO_MEANINGFUL_IMPROVEMENT';
    reason = `回転率の低下(${turnoverReductionPct}%、基準${CONFIG.materialityTurnoverReductionPct}%未達)も` +
      `年率の改善(固定リバランス比+${cagrDeltaVsFixed}pt、基準未達)も限定的で、シグナルを退出フィルターとして` +
      `使うだけでは効果が確認できなかった。`;
  }
  return { category, finalVerdict, reason, cagrDeltaVsBenchmark, cagrDeltaVsFixed, turnoverReductionPct };
}

// ── メイン処理 ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`設定: ${JSON.stringify(CONFIG)}`);
  console.log('目的: スコアを「悪化銘柄を避けるフィルター」として使うヒステリシス退出方式の検証');

  const universeCount = await fetchUniverseCount().catch(() => null);
  console.log(`ユニバース件数（参考）: ${universeCount ?? '不明'}`);

  const series = [];
  let processed = 0, insufficient = 0, implausible = 0;
  for await (const { code, series: raw } of iterateCachedSeries(100)) {
    processed++;
    if (processed % 400 === 0) console.log(`  ...${processed}銘柄処理済み`);
    try {
      if (!raw) { insufficient++; continue; }
      const r = computeStockSeries(code, raw);
      if (r.reason === 'insufficient_data') { insufficient++; continue; }
      if (r.reason === 'implausible_return') { implausible++; continue; }
      series.push(r);
    } catch (e) { insufficient++; }
  }
  console.log(`読み込み完了: ${processed}銘柄中 有効${series.length} / データ不足${insufficient} / 異常値除外${implausible}`);
  if (!series.length) { console.error('有効なデータがありません。'); process.exit(1); }

  // グローバル営業日カレンダー（固定リバランス参照値・全体の資産曲線表示に使う）
  const dayNumSet = new Set();
  for (const s of series) for (const d of s.dayNum) dayNumSet.add(d);
  const globalDayNums = [...dayNumSet].sort((a, b) => a - b);
  console.log(`対象営業日=${globalDayNums.length}日（${dayNumToStr(globalDayNums[0])} 〜 ${dayNumToStr(globalDayNums[globalDayNums.length - 1])}）`);

  // ── ① ベンチマーク: 全銘柄Buy&Hold（コストなし） ──
  console.log('\nベンチマーク（全銘柄Buy&Hold・コストなし）を計算中...');
  const bhByDay = simulateBuyHold(series);
  const bhDays = [...bhByDay.keys()].sort((a, b) => a - b);
  const bhYears = (bhDays[bhDays.length - 1] - bhDays[0]) / 365;
  const bhWinRatePct = (() => { const rs = bhDays.map(d => bhByDay.get(d).sum / bhByDay.get(d).count); return rs.filter(r => r > 0).length / rs.length * 100; })();
  const benchmark = summarizeCurve('全銘柄を買って持ち続ける（コストなし）', bhDays, bhByDay, bhYears, bhWinRatePct);
  console.log(`  最終資産${benchmark.finalEquity} 年率${benchmark.cagrPct}% 最大DD${benchmark.maxDrawdownPct}% シャープ${benchmark.sharpe}`);

  // ── ② 固定20営業日リバランス（同一データでの参照値。entryMinはCONFIG.entryMinに合わせる） ──
  console.log(`\n固定${CONFIG.fixedRebalanceHoldBars}営業日リバランス（${CONFIG.entryMin}点以上・参照値）を計算中...`);
  const fixedRebalance = simulateFixedRebalance(series, globalDayNums, CONFIG.entryMin);
  console.log(`  最終資産${fixedRebalance.finalEquity} 年率${fixedRebalance.cagrPct}% 最大DD${fixedRebalance.maxDrawdownPct}% 年間回転${fixedRebalance.annualizedTurnover}回`);

  // ── ③ ヒステリシス幅の探索グリッド（事前登録・全結果報告） ──
  const combos = [];
  for (const en of CONFIG.sweepEntries) for (const ex of CONFIG.sweepExits) combos.push({ entry: en, exit: ex });
  if (!combos.some(c => c.entry === CONFIG.entryMin && c.exit === CONFIG.exitMin)) {
    combos.push({ entry: CONFIG.entryMin, exit: CONFIG.exitMin });
  }

  console.log(`\nヒステリシス幅の探索グリッド ${combos.length}通りを計算中...`);
  const sweepResults = [];
  let primary = null;
  for (const { entry, exit } of combos) {
    const isPrimary = entry === CONFIG.entryMin && exit === CONFIG.exitMin;
    const sim = simulateSignalExit(series, entry, exit, isPrimary);
    const days = [...sim.byDay.keys()].sort((a, b) => a - b);
    if (!days.length) {
      sweepResults.push({ entry, exit, n: 0, note: '取引が一度も発生しなかった' });
      continue;
    }
    const years = (days[days.length - 1] - days[0]) / 365;
    const winRatePct = sim.completedTrades.length ? sim.completedTrades.filter(t => t.cumRetPct > 0).length / sim.completedTrades.length * 100 : null;
    const curveSummary = summarizeCurve(`シグナル退出（entry≥${entry}, exit<${exit}）`, days, sim.byDay, years, winRatePct);

    const totalEntries = days.reduce((a, d) => a + sim.byDay.get(d).entries, 0);
    const totalExits = days.reduce((a, d) => a + sim.byDay.get(d).exits, 0);
    const holdCounts = [...sim.holdingCountByDay.values()];
    const avgHoldingCount = mean(holdCounts);
    // 年間回転率 = 年あたりのエントリー件数 ÷ 平均保有銘柄数
    // （固定リバランスの「年 250/H 回、保有銘柄全体を入れ替える」と同じ物差しで比較するため、
    //   ここでは「1つの保有枠が年に何回入れ替わるか」を回転率の定義とする）
    const annualizedTurnover = avgHoldingCount > 0 ? (totalEntries / years) / avgHoldingCount : null;
    const holdingDaysArr = sim.completedTrades.map(t => t.holdingDays);
    const transactionCostPctPaid = round((totalEntries + totalExits) * oneWayCostPct / (avgHoldingCount || 1), 2);

    const result = {
      entry, exit,
      ...curveSummary,
      buyTrades: totalEntries, sellTrades: totalExits, totalTrades: totalEntries + totalExits,
      completedRoundTrips: sim.completedTrades.length,
      avgHoldingDays: round(mean(holdingDaysArr), 1), medianHoldingDays: round(median(holdingDaysArr), 1),
      avgHoldingCount: round(avgHoldingCount, 1), minHoldingCount: Math.min(...holdCounts), maxHoldingCount: Math.max(...holdCounts),
      annualizedTurnover: round(annualizedTurnover, 2),
      transactionCostPctPaidApprox: transactionCostPctPaid
    };
    sweepResults.push(result);
    if (isPrimary) primary = { ...result, sim };
    console.log(`  entry≥${entry}, exit<${exit}: 最終資産${result.finalEquity} 年率${result.cagrPct}% 最大DD${result.maxDrawdownPct}% ` +
      `年間回転${result.annualizedTurnover} 取引${result.totalTrades}件`);
  }

  if (!primary) { console.error('本命の閾値(entry/exit)の結果が計算できませんでした。'); process.exit(1); }

  // ── ④ Exit effectiveness（本命の閾値のみ） ──
  console.log('\nExit effectiveness（退出後20営業日リターン）を計算中...');
  const exitEffect = summarizeForwardEffect(primary.sim.exitFwdByDay, '退出後20営業日の順方向リターン（退出しなければどうなっていたか）');
  const holdEffect = summarizeForwardEffect(primary.sim.holdFwdByDay, '継続保有（退出しなかった）銘柄の20営業日順方向リターン');
  console.log(`  退出後: 平均${exitEffect.meanPct}% CI95[${exitEffect.ci95.join(', ')}] (n=${exitEffect.n})`);
  console.log(`  継続保有: 平均${holdEffect.meanPct}% CI95[${holdEffect.ci95.join(', ')}] (n=${holdEffect.n})`);

  // ── ⑤ 判定 ──
  const verdict = computeVerdict(benchmark, fixedRebalance, primary);
  console.log(`\n判定: ${verdict.finalVerdict} (category=${verdict.category})`);
  console.log(`  ${verdict.reason}`);

  const runId = process.env.BT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId,
    purpose: 'スコアを「悪化銘柄を避けるフィルター」として使い、カレンダーではなくシグナル変化で退出するヒステリシス方式の資産推移と、固定リバランス方式・Buy&Holdベンチマークとの比較',
    lookaheadRule: 'signal at day i (i日終値までのデータ) → execution at day i+1 の始値。エントリー・退出とも同一。',
    caveats: [
      'イン・サンプル（過去データへの事後評価）であり、将来の再現は保証されない。',
      '生存バイアス: ユニバースは現在存在する銘柄の固定リストで、過去に上場廃止となった企業を含まない。結果は構造的に上方バイアスを持つ。',
      'アプリの表示スコアと完全一致しない: バックテストのスコアには地合い調整と決算vetoが含まれていない（run.mjs等と同じ制約）。',
      '等ウェイト配分は日々の値動きによるウェイトのドリフト・それを埋める毎日のリバランス売買コストを考慮していない理論値（simulate-signal-strategy.mjsと同じ簡略化）。',
      'データ終了時点でHOLDING状態のまま残っているポジションは、最終日の終値でのマーク・トゥ・マーケットとして扱い、退出コストは課していない（実現した取引ではないため）。',
      '固定リバランス参照値は既存の backtest/results/strategy-latest.* とは別に、本スクリプト内で同一データ・同一手法により再計算した値であり、厳密に同一の実行ではない（比較可能性を優先し、選定条件をCONFIG.entryMinに揃えている）。',
      '年間回転率は「1つの保有枠が年に何回入れ替わるか」で統一している（シグナル退出=年間エントリー件数÷平均保有銘柄数、固定リバランス=実際に入替が発生した期間数÷経過年数）。定義の考え方は揃えているが、算出方法が異なるため厳密な同一指標ではない。'
    ],
    config: CONFIG,
    coverage: {
      stockCount: processed, insufficientData: insufficient, implausibleReturnExcluded: implausible,
      validStocks: series.length,
      startDate: dayNumToStr(globalDayNums[0]), endDate: dayNumToStr(globalDayNums[globalDayNums.length - 1])
    },
    comparison: {
      benchmark,
      fixedRebalance,
      signalExit: { entry: primary.entry, exit: primary.exit, ...primary }
    },
    sweep: sweepResults,
    exitEffectiveness: { exitEffect, holdEffect },
    verdict
  };
  // sim（生のMap等）はJSON化しない
  delete report.comparison.signalExit.sim;

  const outDir = `${__dirname}/results`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/signal-exit-${runId}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/signal-exit-latest.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/signal-exit-latest.md`, renderMarkdown(report));
  console.log(`\n完了: backtest/results/signal-exit-latest.json / .md を出力しました`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
}

function renderMarkdown(r) {
  const L = [];
  const b = r.comparison.benchmark, f = r.comparison.fixedRebalance, s = r.comparison.signalExit;
  L.push(`# シグナル退出方式（ヒステリシス）のバックテスト (${r.runId})`);
  L.push('');
  L.push('## Executive Summary');
  L.push('');
  L.push(`- ベンチマーク（全銘柄Buy&Hold）年率: **${b.cagrPct}%** / 最大DD ${b.maxDrawdownPct}%`);
  L.push(`- 固定${r.config.fixedRebalanceHoldBars}営業日リバランス年率: **${f.cagrPct}%** / 最大DD ${f.maxDrawdownPct}% / 年間回転 ${f.annualizedTurnover}回`);
  L.push(`- シグナル退出方式（entry≥${s.entry}, exit<${s.exit}）年率: **${s.cagrPct}%** / 最大DD ${s.maxDrawdownPct}% / 年間回転 ${s.annualizedTurnover}回`);
  L.push(`- 回転率削減: 固定リバランス比 ${r.verdict.turnoverReductionPct}%`);
  L.push(`- 売買コスト概算（シグナル退出）: ${s.transactionCostPctPaidApprox}%相当/年`);
  L.push('');
  L.push(`**結論: ${r.verdict.finalVerdict}** (詳細分類: ${r.verdict.category})`);
  L.push('');
  L.push(r.verdict.reason);
  L.push('');
  L.push('## 前提と限界（必ず読むこと）');
  L.push('');
  for (const c of r.caveats) L.push(`- ${c}`);
  L.push('');
  L.push(`- ルックアヘッド防止規則: ${r.lookaheadRule}`);
  L.push(`- 対象: ${r.coverage.validStocks}銘柄（読込${r.coverage.stockCount} / データ不足${r.coverage.insufficientData} / 異常値除外${r.coverage.implausibleReturnExcluded}） / ${r.coverage.startDate} 〜 ${r.coverage.endDate}`);
  L.push(`- コスト前提: 片道手数料${r.config.feeBpsOneWay}bps + 片道スリッページ${r.config.slippageBpsOneWay}bps = 片道${(r.config.feeBpsOneWay + r.config.slippageBpsOneWay) / 100}%（run.mjsと同一）`);
  L.push('');
  L.push('## 3方式比較（本命閾値）');
  L.push('');
  L.push('| 方式 | 最終資産 | 総リターン | 年率 | 最大DD | 年率ボラ | シャープ | 勝率 | 年間回転 | 取引件数 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  L.push(`| ${b.label} | ${b.finalEquity} | ${b.totalReturnPct}% | ${b.cagrPct}% | ${b.maxDrawdownPct}% | ${b.annVolPct}% | ${b.sharpe} | ${b.winRatePct}% | — | — |`);
  L.push(`| ${f.label} | ${f.finalEquity} | ${f.totalReturnPct}% | ${f.cagrPct}% | ${f.maxDrawdownPct}% | ${f.annVolPct}% | ${f.sharpe} | ${f.winRatePct}% | ${f.annualizedTurnover} | ${f.tradedPeriods}回入替 |`);
  L.push(`| シグナル退出（entry≥${s.entry}, exit<${s.exit}） | ${s.finalEquity} | ${s.totalReturnPct}% | ${s.cagrPct}% | ${s.maxDrawdownPct}% | ${s.annVolPct}% | ${s.sharpe} | ${s.winRatePct}% | ${s.annualizedTurnover} | ${s.totalTrades}件(買${s.buyTrades}/売${s.sellTrades}) |`);
  L.push('');
  L.push(`- 平均保有日数: ${s.avgHoldingDays}営業日（中央値${s.medianHoldingDays}） / 完了ラウンドトリップ数: ${s.completedRoundTrips}`);
  L.push(`- 日次の平均保有銘柄数: ${s.avgHoldingCount}（最小${s.minHoldingCount} 〜 最大${s.maxHoldingCount}）`);
  L.push('');
  L.push('## ヒステリシス幅の探索グリッド（事前登録・全結果）');
  L.push('');
  L.push('| Entry | Exit | CAGR | MaxDD | 年間回転 | 取引件数 | 完了RT | 勝率 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const g of r.sweep) {
    if (g.n === 0) { L.push(`| ${g.entry} | ${g.exit} | — | — | — | 0 | 0 | ${g.note} |`); continue; }
    L.push(`| ${g.entry} | ${g.exit} | ${g.cagrPct}% | ${g.maxDrawdownPct}% | ${g.annualizedTurnover} | ${g.totalTrades} | ${g.completedRoundTrips} | ${g.winRatePct}% |`);
  }
  L.push('');
  L.push('> このグリッドは「最も成績が良い組み合わせを本番戦略として選ぶ」ためのものではなく、事前登録した研究計画としてヒステリシス幅と回転率・成績の関係を観察するためのものである。');
  L.push('');
  L.push('## Exit effectiveness（退出シグナルは意味があったか）');
  L.push('');
  const ee = r.exitEffectiveness.exitEffect, he = r.exitEffectiveness.holdEffect;
  L.push('| 集計対象 | n(観測/日数) | 平均リターン(%) | 95%CI |');
  L.push('|---|---|---|---|');
  L.push(`| ${ee.label} | ${ee.n}/${ee.nDays ?? '-'} | ${ee.meanPct} | [${ee.ci95[0]}, ${ee.ci95[1]}] |`);
  L.push(`| ${he.label} | ${he.n}/${he.nDays ?? '-'} | ${he.meanPct} | [${he.ci95[0]}, ${he.ci95[1]}] |`);
  L.push('');
  if (ee.meanPct != null && ee.ci95[1] != null && ee.ci95[1] < 0) {
    L.push('退出後20営業日のリターンは統計的に有意にマイナス（95%CI上限が0未満）。退出しなければ実際に損失が続いていたことを示し、「悪化銘柄を避けるフィルター」仮説を支持する結果。');
  } else if (ee.meanPct != null && ee.ci95[0] != null && ee.ci95[0] > 0) {
    L.push('退出後20営業日のリターンは統計的に有意にプラス（95%CI下限が0超）。退出した銘柄はその後むしろ上昇しており、退出シグナル自体が逆効果（往なきダマシ売り）だった可能性を示す結果。');
  } else {
    L.push('退出後20営業日のリターンは統計的に市場と区別できない（95%CIが0を含む）。「悪化銘柄を避けられている」とも「退出が逆効果」とも言えない。');
  }
  L.push('');
  L.push('## 変更していないもの');
  L.push('');
  L.push('- backtest/simulate-signal-strategy.mjs（固定20営業日リバランス方式）は一切変更していない。');
  L.push('- indicators.js の calcTradeScore・本番アプリのスコアロジックは一切変更していない。');
  return L.join('\n') + '\n';
}

main().catch(e => { console.error('致命的エラー:', e); console.error(e.stack); process.exit(1); });
