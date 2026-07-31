// scripts/fetch-sector-map.mjs — bt_universeの各銘柄の業種分類(sector/industry)を
// Yahoo Finance(quoteSummary/assetProfile)からSupabase(sector_map)にキャッシュする。
// Step3-(3) セクター相対強度の検証で使う。業種分類はほぼ変化しないため低頻度実行でよい。
//
// 必須環境変数: SUPABASE_SERVICE_KEY（GitHub Actionsのrepository secretとして設定すること）

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZocHdtYWZuYnptdGplbWxkbWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxOTA5OTQsImV4cCI6MjA5Nzc2Njk5NH0.DUlD9QbME-ReQY7ujlA172sMObR1JRay7dJAqoPq4-U';
const WORKER_BASE = process.env.BT_WORKER_BASE || 'https://kabu.loveradwimps-s0917s.workers.dev';
const FETCH_DELAY_MS = Math.round(parseFloat(process.env.SM_FETCH_DELAY_MS || '1000'));
const MAX_RETRIES = 4;
const TIME_BUDGET_MS = Math.round(parseFloat(process.env.SM_TIME_BUDGET_MIN || '170')) * 60 * 1000;

if (!SUPABASE_SERVICE_KEY) {
  console.error('エラー: 環境変数 SUPABASE_SERVICE_KEY が未設定です。GitHub Actionsのrepository secretとして設定してください。');
  process.exit(1);
}

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

async function fetchAllRows(table, select, filter, key) {
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const q = `${SUPABASE_URL}/rest/v1/${table}?select=${select}${filter ? '&' + filter : ''}&limit=${PAGE}&offset=${offset}`;
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

async function fetchSectorIndustry(code) {
  const url = `${WORKER_BASE}/yfin/v10/finance/quoteSummary/${code}.T?modules=assetProfile`;
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${bodyText.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error(`JSON解析失敗 — ${bodyText.slice(0, 200)}`); }
  const profile = data?.quoteSummary?.result?.[0]?.assetProfile;
  if (!profile) return { sector: null, industry: null };
  return { sector: profile.sector || null, industry: profile.industry || null };
}

async function main() {
  console.log('ユニバース取得中...');
  const universe = await fetchAllRows('bt_universe', 'code', null, SUPABASE_ANON_KEY);
  console.log(`ユニバース件数: ${universe.length}`);

  const cached = await fetchAllRows('sector_map', 'code', null, SUPABASE_ANON_KEY);
  const doneSet = new Set(cached.map(r => r.code));
  const pending = universe.filter(u => !doneSet.has(u.code));
  console.log(`キャッシュ済み: ${doneSet.size}件 / 残り: ${pending.length}件`);

  const svcHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };

  const t0 = Date.now();
  let processed = 0, okCount = 0, errCount = 0;
  for (const { code } of pending) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      console.log(`\n時間予算(${TIME_BUDGET_MS / 60000}分)に到達。残り${pending.length - processed}件は次回実行で続きから処理されます。`);
      break;
    }
    process.stdout.write(`[${processed + 1}/${pending.length}] ${code} ... `);
    let row;
    try {
      const { sector, industry } = await fetchSectorIndustry(code);
      row = { code, sector, industry };
      console.log(sector ? `${sector} / ${industry || '-'}` : '業種情報なし');
      okCount++;
    } catch (e) {
      row = { code, sector: null, industry: null };
      console.log('エラー: ' + e.message);
      errCount++;
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sector_map`, {
      method: 'POST', headers: svcHeaders, body: JSON.stringify([row])
    });
    if (!res.ok) console.error(`  Supabase保存失敗: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    processed++;
    await sleep(FETCH_DELAY_MS);
  }

  console.log(`\n完了: 今回処理${processed}件（成功${okCount} / エラー${errCount}）`);
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
