// scripts/fetch-fundamentals.mjs — バリュー・クオリティ系ファクター検証のための
// Point-in-Time 財務データを毎週スナップショットする。
//
// 背景と設計思想は migrations/007_fundamentals_pit.sql の冒頭コメントを参照。
// 要点だけ再掲する:
//   - これまでの検証はOHLCVのみで、テクニカル系10仮説をすべて否定した
//   - 日本株で学術的に最も頑健なのはバリュー・クオリティ系（FF2012の日本HMLは年率約6%規模）
//   - しかし過去時点の財務データは無料では入手できない
//   - よって「今日から記録を開始」し、1〜2年後に本物のPITデータで検証する
//
// 各実行は「観測時点(known_from)のスナップショット」として追記する。
// 既存行は書き換えない（遡及修正も新しい行として残し、過去を破壊しない）。
//
// 必須環境変数: SUPABASE_SERVICE_KEY（GitHub Actionsのrepository secretとして設定すること）

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZocHdtYWZuYnptdGplbWxkbWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxOTA5OTQsImV4cCI6MjA5Nzc2Njk5NH0.DUlD9QbME-ReQY7ujlA172sMObR1JRay7dJAqoPq4-U';
const WORKER_BASE = process.env.BT_WORKER_BASE || 'https://kabu.loveradwimps-s0917s.workers.dev';
const FETCH_DELAY_MS = Math.round(parseFloat(process.env.FD_FETCH_DELAY_MS || '1200'));
const MAX_RETRIES = 4;
const TIME_BUDGET_MS = Math.round(parseFloat(process.env.FD_TIME_BUDGET_MIN || '170')) * 60 * 1000;

if (!SUPABASE_SERVICE_KEY) {
  console.error('エラー: 環境変数 SUPABASE_SERVICE_KEY が未設定です。GitHub Actionsのrepository secretとして設定してください。');
  process.exit(1);
}

// 記録する指標。バリュー系とクオリティ系を中心に、レポートの候補#1〜#13に対応させる。
// [Yahooのモジュール, フィールド名, 保存する指標名]
const METRICS = [
  // --- バリュー系 ---
  ['defaultKeyStatistics', 'priceToBook', 'pbr'],
  ['summaryDetail', 'trailingPE', 'per_trailing'],
  ['summaryDetail', 'forwardPE', 'per_forward'],
  ['defaultKeyStatistics', 'enterpriseToEbitda', 'ev_ebitda'],
  ['defaultKeyStatistics', 'priceToSalesTrailing12Months', 'psr'],
  ['summaryDetail', 'dividendYield', 'dividend_yield'],
  // --- クオリティ系 ---
  ['financialData', 'returnOnEquity', 'roe'],
  ['financialData', 'returnOnAssets', 'roa'],
  ['financialData', 'operatingMargins', 'operating_margin'],
  ['financialData', 'profitMargins', 'profit_margin'],
  ['financialData', 'grossMargins', 'gross_margin'],
  ['financialData', 'currentRatio', 'current_ratio'],
  ['financialData', 'debtToEquity', 'debt_to_equity'],
  ['financialData', 'freeCashflow', 'free_cashflow'],
  ['financialData', 'operatingCashflow', 'operating_cashflow'],
  // --- 成長系 ---
  ['financialData', 'revenueGrowth', 'revenue_growth'],
  ['financialData', 'earningsGrowth', 'earnings_growth'],
  // --- サイズ（ファクター中立化に使う） ---
  ['summaryDetail', 'marketCap', 'market_cap'],
  ['defaultKeyStatistics', 'enterpriseValue', 'enterprise_value'],
  // --- リスク（低ボラ系の補助） ---
  ['defaultKeyStatistics', 'beta', 'beta'],
];
const MODULES = 'defaultKeyStatistics,financialData,summaryDetail';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, options) {
  let res;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === MAX_RETRIES) return res;
    const waitMs = 3000 * 2 ** attempt + Math.random() * 1000;
    console.log(`  HTTP ${res.status}受信 — ${Math.round(waitMs / 1000)}秒待って再試行 (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs);
  }
  return res;
}

async function fetchAllRows(table, select, key) {
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const q = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${table}取得失敗: HTTP ${res.status} ${await res.text()}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// Yahooのフィールドは {raw: number, fmt: string} 形式か生の数値のどちらかで返る
function rawOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && typeof v.raw === 'number') return Number.isFinite(v.raw) ? v.raw : null;
  return null;
}

async function fetchFundamentals(code) {
  const url = `${WORKER_BASE}/yfin/v10/finance/quoteSummary/${code}.T?modules=${MODULES}`;
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${bodyText.slice(0, 160)}`);
  let data;
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error(`JSON解析失敗 — ${bodyText.slice(0, 160)}`); }
  const result = data?.quoteSummary?.result?.[0];
  if (!result) throw new Error('quoteSummary.resultが空');

  // 決算期末日（valid time）。取得できない場合はnullのまま記録する
  const fiscalRaw = rawOf(result?.defaultKeyStatistics?.mostRecentQuarter);
  const fiscalDate = fiscalRaw ? new Date(fiscalRaw * 1000).toISOString().slice(0, 10) : null;

  const out = [];
  for (const [mod, field, name] of METRICS) {
    const v = rawOf(result?.[mod]?.[field]);
    if (v == null) continue;
    out.push({ metric: name, value: v, fiscal_date: fiscalDate });
  }
  return out;
}

async function main() {
  console.log('Point-in-Time 財務データのスナップショットを開始します');
  console.log(`記録する指標: ${METRICS.length}種類`);

  const universe = await fetchAllRows('bt_universe', 'code', SUPABASE_ANON_KEY);
  console.log(`ユニバース件数: ${universe.length}`);

  // 同一実行内は同じknown_fromを使い、「このスナップショットはこの時点の観測」であることを明確にする
  const knownFrom = new Date().toISOString();
  const svcHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    // 同一(code, metric, known_from)の重複は上書きする（再実行時の安全性のため）
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };

  const t0 = Date.now();
  let processed = 0, okCount = 0, errCount = 0, rowCount = 0;
  for (const { code } of universe) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      console.log(`\n時間予算(${TIME_BUDGET_MS / 60000}分)に到達。残り${universe.length - processed}件は次回実行で処理されます。`);
      break;
    }
    processed++;
    try {
      const metrics = await fetchFundamentals(code);
      if (metrics.length) {
        const rows = metrics.map(m => ({ code, metric: m.metric, value: m.value, fiscal_date: m.fiscal_date, known_from: knownFrom }));
        const res = await fetch(`${SUPABASE_URL}/rest/v1/fundamentals_pit`, {
          method: 'POST', headers: svcHeaders, body: JSON.stringify(rows)
        });
        if (!res.ok) {
          console.error(`  ${code} Supabase保存失敗: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
          errCount++;
        } else {
          rowCount += rows.length;
          okCount++;
        }
      } else {
        // 財務データが1件も取れない銘柄（新規上場・データ未整備等）はスキップ扱い
        errCount++;
      }
    } catch (e) {
      errCount++;
    }
    if (processed % 100 === 0) {
      console.log(`  ...${processed}/${universe.length}件処理（成功${okCount} / 取得不可${errCount} / 記録${rowCount}行）`);
    }
    await sleep(FETCH_DELAY_MS);
  }

  console.log(`\n完了: ${processed}件処理（成功${okCount} / 取得不可${errCount}）`);
  console.log(`記録した行数: ${rowCount}行（観測時点 known_from=${knownFrom}）`);
  console.log('※ 過去分は遡って取得できません。この蓄積が1〜2年分たまるとバリュー系ファクターの検証が可能になります。');
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
