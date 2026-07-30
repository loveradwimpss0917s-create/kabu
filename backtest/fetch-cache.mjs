// backtest/fetch-cache.mjs — bt_universeの銘柄について10年分の日足をWorker経由で取得し、
// Supabase(bt_prices_cache)にキャッシュする。GitHub Actions上で実行する。
//
// 既にキャッシュ済み（status='done'）の銘柄はスキップするため、何度実行しても
// 続きから再開できる。1回の実行には時間制限（既定170分）を設け、時間内に終わらなければ
// 途中で打ち切り、次回実行で続きから処理する。
//
// 必須環境変数: SUPABASE_SERVICE_KEY（GitHub Actionsのrepository secretとして設定すること）

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WORKER_BASE = process.env.BT_WORKER_BASE || 'https://kabu.loveradwimps-s0917s.workers.dev';
const RANGE = process.env.BT_RANGE || '10y';
const FETCH_DELAY_MS = Math.round(parseFloat(process.env.BT_FETCH_DELAY_MS || '1500'));
const MAX_RETRIES = 4;
const TIME_BUDGET_MS = Math.round(parseFloat(process.env.BT_TIME_BUDGET_MIN || '170')) * 60 * 1000;

if (!SUPABASE_SERVICE_KEY) {
  console.error('エラー: 環境変数 SUPABASE_SERVICE_KEY が未設定です。GitHub Actionsのrepository secretとして設定してください。');
  process.exit(1);
}

const svcHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, options, maxRetries) {
  maxRetries = maxRetries ?? MAX_RETRIES;
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

async function fetchAllRows(table, select, filter) {
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const q = `${SUPABASE_URL}/rest/v1/${table}?select=${select}${filter ? '&' + filter : ''}&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(q, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${table}取得失敗: HTTP ${res.status} ${await res.text()}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function fetchHistory(code) {
  const params = new URLSearchParams({ interval: '1d', range: RANGE, includeAdjustedClose: 'true' });
  const res = await fetchWithRetry(`${WORKER_BASE}/yfin/v8/finance/chart/${code}.T?${params}`, {
    headers: { Accept: 'application/json' }
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error(`JSON解析失敗 — ${bodyText.slice(0, 300)}`); }
  const chart = data?.chart?.result?.[0];
  if (!chart) {
    const err = data?.chart?.error;
    throw new Error(`chart.resultが空 — ${err ? JSON.stringify(err) : bodyText.slice(0, 300)}`);
  }
  return chart;
}

// Yahoo chart.result[0]と同じ形状のまま保存する（読み出し側がindicators.jsの
// buildAdjustedSeries()をそのまま再利用できるようにするため。独自の中間形式は作らない）
function chartToCacheRow(code, chart) {
  const q = chart.indicators?.quote?.[0] || {};
  const adj = chart.indicators?.adjclose?.[0]?.adjclose || null;
  const timestamps = chart.timestamp || [];
  const series = {
    timestamp: timestamps,
    indicators: {
      quote: [{ open: q.open || [], high: q.high || [], low: q.low || [], close: q.close || [], volume: q.volume || [] }],
      adjclose: [{ adjclose: adj || [] }]
    }
  };
  const validCloses = (q.close || []).filter(c => c != null);
  return {
    code,
    bar_count: validCloses.length,
    start_date: timestamps.length ? new Date(timestamps[0] * 1000).toISOString().slice(0, 10) : null,
    end_date: timestamps.length ? new Date(timestamps[timestamps.length - 1] * 1000).toISOString().slice(0, 10) : null,
    status: 'done',
    error_message: null,
    series
  };
}

async function main() {
  console.log(`ユニバース取得中...`);
  const universe = await fetchAllRows('bt_universe', 'code,name');
  console.log(`ユニバース件数: ${universe.length}`);

  const cached = await fetchAllRows('bt_prices_cache', 'code,status', 'status=eq.done');
  const doneSet = new Set(cached.map(r => r.code));
  const pending = universe.filter(u => !doneSet.has(u.code));
  console.log(`キャッシュ済み: ${doneSet.size}件 / 残り: ${pending.length}件`);

  const t0 = Date.now();
  let processed = 0, okCount = 0, errCount = 0;
  for (const { code, name } of pending) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      console.log(`\n時間予算(${TIME_BUDGET_MS / 60000}分)に到達。ここで打ち切ります。残り${pending.length - processed}件は次回実行で続きから処理されます。`);
      break;
    }
    process.stdout.write(`[${processed + 1}/${pending.length}] ${code} ${name} ... `);
    let row;
    try {
      const chart = await fetchHistory(code);
      row = chartToCacheRow(code, chart);
      console.log(`${row.bar_count}件 (${row.start_date}〜${row.end_date})`);
      okCount++;
    } catch (e) {
      row = { code, bar_count: 0, start_date: null, end_date: null, status: 'error', error_message: e.message, series: null };
      console.log('エラー: ' + e.message);
      errCount++;
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bt_prices_cache`, {
      method: 'POST',
      headers: { ...svcHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([row])
    });
    if (!res.ok) {
      console.error(`  Supabase保存失敗: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    processed++;
    await sleep(FETCH_DELAY_MS);
  }

  console.log(`\n完了: 今回処理${processed}件（成功${okCount} / エラー${errCount}）`);
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
