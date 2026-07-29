// worker.js — kabu main entry point

import { calcTradeScore } from './indicators.js';

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

async function handleYfin(request, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }
  const path = url.pathname.replace(/^\/yfin/, '');
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

// ── STOCK LIST (TSE major stocks) ──────────────────────────────────────────

const SCAN_STOCKS = [
  ['7203','トヨタ自動車'],['6758','ソニーグループ'],['9984','ソフトバンクグループ'],
  ['8306','三菱UFJ FG'],['6861','キーエンス'],['9433','KDDI'],
  ['7974','任天堂'],['8058','三菱商事'],['4519','中外製薬'],
  ['6098','リクルートHD'],['4063','信越化学工業'],['8035','東京エレクトロン'],
  ['4661','オリエンタルランド'],['7267','ホンダ'],['8316','三井住友FG'],
  ['6367','ダイキン工業'],['4502','武田薬品工業'],['9432','NTT'],
  ['7751','キヤノン'],['8001','伊藤忠商事'],['6954','ファナック'],
  ['2914','JT'],['6301','コマツ'],['4568','第一三共'],
  ['9020','JR東日本'],['3382','セブン&アイHD'],['4543','テルモ'],
  ['6503','三菱電機'],['5108','ブリヂストン'],['8766','東京海上HD'],
  ['7741','HOYA'],['9983','ファーストリテイリング'],['6971','京セラ'],
  ['7832','バンダイナムコHD'],['6273','SMC'],['2802','味の素'],
  ['6902','デンソー'],['8411','みずほFG'],['7733','オリンパス'],
  ['4704','トレンドマイクロ'],['6645','オムロン'],['5401','日本製鉄'],
  ['9613','NTTデータ'],['6869','シスメックス'],['6501','日立製作所'],
  ['7269','スズキ'],['6723','ルネサスエレクトロニクス'],['9766','コナミHD'],
  ['6326','クボタ'],['5020','ENEOSホールディングス'],['4901','富士フイルムHD'],
  ['9104','商船三井'],['9107','川崎汽船'],['9101','日本郵船'],
  ['4507','塩野義製薬'],['6762','TDK'],['6752','パナソニックHD'],
  ['3436','SUMCO'],['9735','セコム'],['8015','豊田通商'],
  ['1925','大和ハウス工業'],['8802','三菱地所'],['9602','東宝'],
  ['4324','電通グループ'],['9021','JR西日本'],['4755','楽天グループ'],
  ['3697','SHIFT'],['4385','メルカリ'],['3659','ネクソン'],
  ['2371','カカクコム'],['4452','花王'],['7012','川崎重工業'],
  ['6302','住友重機械工業'],['3289','東急不動産HD'],['4151','協和キリン'],
  ['9843','ニトリHD'],['8267','イオン'],['3088','マツキヨコクミン'],
  ['9201','日本航空'],['9202','ANAホールディングス'],['8591','オリックス'],
];

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

    const q = chart.indicators?.quote?.[0] || {};
    const raw = { o: q.open || [], h: q.high || [], l: q.low || [], c: q.close || [], v: q.volume || [] };

    const valid = { o: [], h: [], l: [], c: [], v: [] };
    for (let i = 0; i < raw.c.length; i++) {
      if (raw.c[i] != null && raw.o[i] != null && raw.h[i] != null && raw.l[i] != null && raw.v[i] != null) {
        valid.o.push(raw.o[i]); valid.h.push(raw.h[i]); valid.l.push(raw.l[i]);
        valid.c.push(raw.c[i]); valid.v.push(raw.v[i]);
      }
    }
    if (valid.c.length < 60) return null;

    const ts = calcTradeScore(valid.o, valid.h, valid.l, valid.c, valid.v, null, '1d');
    const last = valid.c.length - 1;
    const price = valid.c[last];
    const prevClose = valid.c[last - 1] || price;
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

async function runScanner(env, maxStocks) {
  const { crumb, cookie } = await getCrumb();
  if (!crumb) throw new Error('crumb取得失敗');

  const mc = await getMarketCondition(crumb, cookie);

  const stockList = maxStocks ? SCAN_STOCKS.slice(0, maxStocks) : SCAN_STOCKS;
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
  const top50 = results.slice(0, 50);

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

  const records = top50.map(r => ({
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

  return { scanned: results.length, saved: top50.length, date: today, market_condition: mc };
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

    let q = `${supaUrl}/rest/v1/scan_results?scan_date=eq.${latestDate}&order=score.desc&limit=${limit}`;
    if (signal) q += `&signal=eq.${encodeURIComponent(signal)}`;

    const res = await fetch(q, { headers: anonHeaders });
    const data = await res.json();
    return new Response(JSON.stringify({ results: Array.isArray(data) ? data : [], date: latestDate }), {
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
    const result = await runScanner(env, 44);
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
    ctx.waitUntil(
      runScanner(env).then(r => {
        console.log('Cron scanner完了:', JSON.stringify(r));
      }).catch(e => {
        console.error('Cron scanner失敗:', e.message);
      })
    );
  }
};
