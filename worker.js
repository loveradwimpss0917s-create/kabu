// worker.js — kabu main entry point

import { calcTradeScore, buildAdjustedSeries } from './indicators.js';
import { SCAN_STOCKS } from './stocks.js';

const YF_BASE = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cachedCrumb = null;
let cachedCookie = null;
let crumbExpiry = 0;

// ── CRUMB ──────────────────────────────────────────────────────────────────

async function getCrumb() {
  const now = Date.now();
  if (cachedCrumb && cachedCookie && now < crumbExpiry) {
    return { crumb: cachedCrumb, cookie: cachedCookie };
  }
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      redirect: 'follow'
    });
    const rawCookie = r1.headers.get('set-cookie') || '';
    const cookie = rawCookie.split(',').map(c => c.trim().split(';')[0]).filter(Boolean).join('; ');
    const r2 = await fetch(`${YF_BASE}/v1/test/getcrumb`, {
      headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/plain,*/*', 'Referer': 'https://finance.yahoo.com' }
    });
    const crumb = (await r2.text()).trim();
    if (crumb && crumb.length > 0 && !crumb.includes('<')) {
      cachedCrumb = crumb;
      cachedCookie = cookie;
      crumbExpiry = now + 3600 * 1000;
      return { crumb, cookie };
    }
  } catch (e) {
    console.error('Crumb fetch error:', e.message);
  }
  return { crumb: null, cookie: null };
}

async function getMarketCondition(crumb, cookie) {
  const symbol = '%5EN225';
  const params = new URLSearchParams({ interval: '1d', range: '1y' });
  if (crumb) params.set('crumb', crumb);
  const targetUrl = `${YF_BASE}/v8/finance/chart/${symbol}?${params}`;
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' };
  if (cookie) headers['Cookie'] = cookie;
  try {
    const res = await fetch(targetUrl, { headers });
    if (!res.ok) return { level: 'NEUTRAL', adj: 0, n225: null, dayChangePct: 0 };
    const data = await res.json();
    const chart = data?.chart?.result?.[0];
    if (!chart) return { level: 'NEUTRAL', adj: 0, n225: null, dayChangePct: 0 };
    const q = chart.indicators?.quote?.[0] || {};
    const closes = (q.close || []).filter(c => c != null);
    if (closes.length < 75) return { level: 'NEUTRAL', adj: 0, n225: null, dayChangePct: 0 };
    const last = closes.length - 1;
    const cur = closes[last];
    const prev = closes[last - 1] || cur;
    const dayChangePct = prev > 0 ? ((cur - prev) / prev) * 100 : 0;
    const ma25 = closes.slice(-25).reduce((a, b) => a + b, 0) / 25;
    const ma75 = closes.slice(-75).reduce((a, b) => a + b, 0) / 75;
    let level, adj;
    if (dayChangePct <= -3) { level = 'CRASH'; adj = -25; }
    else if (cur > ma25 && ma25 > ma75) { level = 'BULL'; adj = 0; }
    else if (cur < ma25 && ma25 < ma75) { level = 'BEAR'; adj = -15; }
    else { level = 'NEUTRAL'; adj = -5; }
    return { level, adj, n225: Math.round(cur), dayChangePct: Math.round(dayChangePct * 100) / 100 };
  } catch (e) {
    console.error('getMarketCondition error:', e.message);
    return { level: 'NEUTRAL', adj: 0, n225: null, dayChangePct: 0 };
  }
}

// ── PROXY HANDLERS ─────────────────────────────────────────────────────────

// /yfin/* が転送してよいYahoo Finance APIパス（前方一致）。
// 新しいYahooエンドポイントを使う機能を追加する場合はここに追記すること。
const YFIN_ALLOWED_PATH_PREFIXES = [
  '/v8/finance/chart/',
  '/v10/finance/quoteSummary/',
  '/v1/finance/search'
];

async function handleYfin(request, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }
  const path = url.pathname.replace(/^\/yfin/, '');
  if (!YFIN_ALLOWED_PATH_PREFIXES.some(p => path.startsWith(p))) {
    return new Response(JSON.stringify({ error: 'このパスは許可されていません' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  const params = new URLSearchParams(url.search);
  params.delete('_t');
  const { crumb, cookie } = await getCrumb();
  if (crumb) params.set('crumb', crumb);
  const targetUrl = `${YF_BASE}${path}?${params.toString()}`;
  const fetchHeaders = {
    'User-Agent': UA,
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com'
  };
  if (cookie) fetchHeaders['Cookie'] = cookie;
  try {
    const res = await fetch(targetUrl, { headers: fetchHeaders });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', ...corsHeaders() }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

async function handleGnews(request, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }
  const code = url.searchParams.get('code') || '';
  const name = url.searchParams.get('name') || '';
  if (!code) {
    return new Response(JSON.stringify({ error: 'code required', news: [] }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  const queries = [];
  if (name && name.length > 1) queries.push(name + ' 株');
  queries.push(code + ' 株価');
  const allItems = [];
  for (const q of queries) {
    if (allItems.length >= 8) break;
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;
    try {
      const res = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'text/xml, application/xml' }
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && allItems.length < 8) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/);
        let title = titleMatch ? titleMatch[1] : '';
        title = title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (!title || title.length < 5) continue;
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
        const link = linkMatch ? linkMatch[1].trim() : '#';
        const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        const ts = dateMatch ? Math.floor(new Date(dateMatch[1]).getTime() / 1000) : 0;
        const srcMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/);
        const source = srcMatch ? srcMatch[1].replace(/<[^>]+>/g, '').trim() : 'Google News';
        if (!allItems.some(x => x.title === title)) {
          allItems.push({ title, url: link, publisher: source, providerPublishTime: ts });
        }
      }
    } catch (e) {
      console.error('RSS fetch error:', e.message);
    }
  }
  return new Response(JSON.stringify({ news: allItems.slice(0, 8) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}

// ── SCANNER LOGIC ──────────────────────────────────────────────────────────

async function scanStock(code, name, crumb, cookie) {
  const symbol = code + '.T';
  const params = new URLSearchParams({ interval: '1d', range: '1y', includeAdjustedClose: 'true' });
  if (crumb) params.set('crumb', crumb);
  const targetUrl = `${YF_BASE}/v8/finance/chart/${symbol}?${params}`;
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' };
  if (cookie) headers['Cookie'] = cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(targetUrl, { headers, signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const chart = data?.chart?.result?.[0];
    if (!chart) return null;

    // 指標計算には分割・配当調整後の系列を使う（未調整のままだと配当落ちが指標に混入するため）。
    // 画面/DBに出す価格・前日比は実際の株価（未調整）を使う
    const series = buildAdjustedSeries(chart);
    if (series.c.length < 60) return null;

    const ts = calcTradeScore(series.o, series.h, series.l, series.c, series.v, null, '1d');
    const last = series.c.length - 1;
    const price = series.rawClose[last];
    const prevClose = series.rawClose[last - 1] || price;
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    return {
      code, name,
      score: ts.score,
      signal: ts.signal,
      signal_class: ts.signalClass,
      price: Math.round(price * 10) / 10,
      change_pct: Math.round(changePct * 100) / 100,
      volume_ratio: Math.round(ts.volRatio * 100) / 100,
      atr_pct: Math.round(ts.atrPct * 100) / 100,
      rsi: Math.round(ts.rsi * 10) / 10,
      macd_gc: ts.macdGc,
      ema_signal: ts.emaSignal,
      near_high52w: ts.nearHigh52w,
      gap_pct: Math.round(ts.gapPct * 100) / 100,
    };
  } catch (e) {
    console.error(`scanStock ${code} error:`, e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// opts.offset/opts.limit で SCAN_STOCKS の部分範囲だけを走査する（日次cronを2本に分割し
// 81銘柄全体を1本あたり50サブリクエスト未満に収めるため）。省略時は全銘柄を対象にする。
async function runScanner(env, opts) {
  const offset = (opts && opts.offset) || 0;
  const limit = opts && opts.limit;

  const { crumb, cookie } = await getCrumb();
  if (!crumb) throw new Error('crumb取得失敗');

  const mc = await getMarketCondition(crumb, cookie);

  const stockList = limit != null ? SCAN_STOCKS.slice(offset, offset + limit) : SCAN_STOCKS.slice(offset);
  const results = [];
  const batchSize = 10;
  const scanStart = Date.now();
  const MAX_SCAN_MS = 24000;
  for (let i = 0; i < stockList.length; i += batchSize) {
    if (Date.now() - scanStart > MAX_SCAN_MS) break;
    const batch = stockList.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map(([code, name]) => scanStock(code, name, crumb, cookie)));
    for (const r of batchRes) {
      if (r) {
        const adjScore = Math.max(0, Math.min(100, r.score + mc.adj));
        let signal, signalClass;
        if (adjScore >= 90) { signal = 'STRONG BUY'; signalClass = 'strong-buy'; }
        else if (adjScore >= 75) { signal = 'BUY'; signalClass = 'buy'; }
        else if (adjScore >= 50) { signal = 'NEUTRAL'; signalClass = 'neutral'; }
        else if (adjScore >= 30) { signal = 'SELL'; signalClass = 'sell'; }
        else { signal = 'STRONG SELL'; signalClass = 'strong-sell'; }
        results.push({ ...r, score: adjScore, signal, signal_class: signalClass });
      }
    }
    if (i + batchSize < stockList.length && Date.now() - scanStart < MAX_SCAN_MS - 500) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  results.sort((a, b) => b.score - a.score);
  // 分割実行のため上位N件に絞らず走査した全件を保存する。表示側の上位選別は
  // handleScanner の order=score.desc&limit=N に委ねる
  const today = new Date().toISOString().split('T')[0];
  const supaUrl = env.SUPABASE_URL;
  const svcKey = env.SUPABASE_SERVICE_KEY;

  if (!svcKey) throw new Error('SUPABASE_SERVICE_KEY が未設定');

  const svcHeaders = {
    'apikey': svcKey,
    'Authorization': `Bearer ${svcKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  const records = results.map(r => ({
    code: r.code, name: r.name, score: r.score, signal: r.signal,
    price: r.price, change_pct: r.change_pct, volume_ratio: r.volume_ratio,
    atr_pct: r.atr_pct, rsi: r.rsi, macd_gc: r.macd_gc,
    ema_signal: r.ema_signal, near_high52w: r.near_high52w,
    gap_pct: r.gap_pct, scan_date: today
  }));

  // upsert: (scan_date, code) にユニーク制約がある前提。事前DELETEは行わない
  // → INSERT失敗時に当日データが失われたまま残る事故を防ぐ（migrations/001_scan_results_unique.sql 適用が必須）
  const insertRes = await fetch(`${supaUrl}/rest/v1/scan_results`, {
    method: 'POST',
    headers: { ...svcHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(records)
  });
  if (!insertRes.ok) {
    const errBody = await insertRes.text();
    throw new Error(`Supabase upsert失敗: ${insertRes.status} ${errBody}（Supabase無料プランが一時停止している可能性があります。ダッシュボードでRestoreしてください）`);
  }

  return { scanned: results.length, saved: records.length, offset, limit: limit ?? null, date: today, market_condition: mc };
}

// ── SCANNER API HANDLERS ───────────────────────────────────────────────────

async function handleScanner(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders() });

  const signal = url.searchParams.get('signal') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const supaUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;

  if (!supaUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Supabase設定なし', results: [] }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  try {
    const anonHeaders = { 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}`, 'Accept': 'application/json' };
    // 最新スキャン日取得
    const dateRes = await fetch(`${supaUrl}/rest/v1/scan_results?select=scan_date&order=scan_date.desc&limit=1`, {
      headers: anonHeaders
    });
    const dateData = await dateRes.json();
    const latestDate = dateData?.[0]?.scan_date;

    if (!latestDate) {
      return new Response(JSON.stringify({ results: [], date: null, message: 'スキャンデータなし' }), {
        status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
      });
    }

    // DB側に(scan_date, code)の重複行が残っている可能性があるため、必要数より多めに取得してから
    // コード単位で重複除去する（score.desc順なので各コードの最高スコア行が残る）
    const fetchLimit = Math.min(limit * 3, 300);
    let q = `${supaUrl}/rest/v1/scan_results?scan_date=eq.${latestDate}&order=score.desc&limit=${fetchLimit}`;
    if (signal) q += `&signal=eq.${encodeURIComponent(signal)}`;

    const res = await fetch(q, { headers: anonHeaders });
    const data = await res.json();
    const rows = Array.isArray(data) ? data : [];
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      deduped.push(r);
      if (deduped.length >= limit) break;
    }
    return new Response(JSON.stringify({ results: deduped, date: latestDate }), {
      status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, results: [] }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// トークンをSHA-256ハッシュ化して固定長バイト列で比較する（文字列長・内容のタイミングリークを避ける）
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a || '')),
    crypto.subtle.digest('SHA-256', enc.encode(b || ''))
  ]);
  const va = new Uint8Array(ha), vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// 同一オリジン専用エンドポイント（CORSヘッダを付与しない = クロスオリジンからの読み取りをブラウザが拒否する）
async function handleScanTrigger(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200 });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }
  const token = request.headers.get('X-Admin-Token') || '';
  if (!env.ADMIN_TOKEN || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const result = await runScanner(env, { offset: 0, limit: 44 });
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleMarketCondition(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders() });
  const { crumb, cookie } = await getCrumb();
  const mc = await getMarketCondition(crumb, cookie);
  return new Response(JSON.stringify(mc), {
    status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}

// ── CORS ───────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

// ── MAIN EXPORT ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/yfin/')) {
      return handleYfin(request, url);
    }
    if (url.pathname === '/gnews') {
      return handleGnews(request, url);
    }
    if (url.pathname === '/api/scanner') {
      return handleScanner(request, env, url);
    }
    if (url.pathname === '/api/scan-trigger') {
      return handleScanTrigger(request, env);
    }
    if (url.pathname === '/api/market-condition') {
      return handleMarketCondition(request, env);
    }

    // index.html はキャッシュさせない
    const assetRes = await env.ASSETS.fetch(request);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const headers = new Headers(assetRes.headers);
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('Pragma', 'no-cache');
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }
    return assetRes;
  },

  async scheduled(event, env, ctx) {
    // 81銘柄を1本のcronで走査すると crumb2+market1+銘柄81+upsert1=85 サブリクエストとなり
    // 無料プランの上限50を超え毎回失敗する。2本のcronに分割し、それぞれ50未満に収める
    const isSecondHalf = event.cron === '10 23 * * *';
    const opts = isSecondHalf ? { offset: 40, limit: 41 } : { offset: 0, limit: 40 };
    ctx.waitUntil(
      runScanner(env, opts).then(r => {
        console.log(`Cron scanner完了 (${isSecondHalf ? '後半' : '前半'}):`, JSON.stringify(r));
      }).catch(e => {
        console.error(`Cron scanner失敗 (${isSecondHalf ? '後半' : '前半'}):`, e.message);
      })
    );
  }
};
