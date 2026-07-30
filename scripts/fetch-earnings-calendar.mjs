// scripts/fetch-earnings-calendar.mjs — SCAN_STOCKSの次回決算日をSupabase(earnings_calendar)に
// キャッシュする。GitHub Actionsから低頻度（週次）で実行する。
//
// 日次スキャナー(worker.js)はSubrequest数上限のため決算日を毎回取得できず、
// このテーブルを1回読むだけで「決算まで7日以内」判定を行う。決算日は数ヶ月単位でしか
// 変わらないため、週次更新で十分。
//
// 必須環境変数: SUPABASE_SERVICE_KEY（GitHub Actionsのrepository secretとして設定すること）

import { SCAN_STOCKS } from '../stocks.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WORKER_BASE = process.env.BT_WORKER_BASE || 'https://kabu.loveradwimps-s0917s.workers.dev';
const FETCH_DELAY_MS = Math.round(parseFloat(process.env.EC_FETCH_DELAY_MS || '1000'));
const MAX_RETRIES = 4;

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

async function fetchNextEarningsEpoch(code) {
  const url = `${WORKER_BASE}/yfin/v10/finance/quoteSummary/${code}.T?modules=calendarEvents&lang=ja`;
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${bodyText.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error(`JSON解析失敗 — ${bodyText.slice(0, 200)}`); }
  const result = data?.quoteSummary?.result?.[0];
  const earArr = result?.calendarEvents?.earnings?.earningsDate;
  const raw = earArr && earArr[0] && earArr[0].raw;
  return typeof raw === 'number' ? raw : null;
}

async function main() {
  console.log(`対象: ${SCAN_STOCKS.length}銘柄`);
  const svcHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };

  let okCount = 0, errCount = 0;
  for (const [code, name] of SCAN_STOCKS) {
    process.stdout.write(`${code} ${name} ... `);
    let row;
    try {
      const epoch = await fetchNextEarningsEpoch(code);
      row = { code, next_earnings_epoch: epoch };
      console.log(epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : '決算日情報なし');
      okCount++;
    } catch (e) {
      console.log('エラー: ' + e.message);
      errCount++;
      await sleep(FETCH_DELAY_MS);
      continue;
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/earnings_calendar`, {
      method: 'POST', headers: svcHeaders, body: JSON.stringify([row])
    });
    if (!res.ok) {
      console.error(`  Supabase保存失敗: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(FETCH_DELAY_MS);
  }

  console.log(`\n完了: 成功${okCount} / エラー${errCount}`);
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
