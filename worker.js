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

// ── BACKTEST ENGINE ──────────────────────────────────────────────────────────
// Cloudflare Workers の1回の実行ではCPU時間・サブリクエストに上限があるため、
// 81銘柄×3年分を一度に計算せず (銘柄インデックス, 銘柄内の評価日オフセット) 単位の
// チャンクに分割し、cron（数分おき）または手動トリガーで少しずつ進める設計にする。

const BACKTEST_DAY_CHUNK = 150; // 1回の実行で評価する営業日数の上限（CPU予算の安全マージン）
const BACKTEST_FEE_PCT_DEFAULT = 0.05;      // 片道手数料(%)
const BACKTEST_SLIPPAGE_PCT_DEFAULT = 0.1;  // 片道スリッページ(%)
const BACKTEST_TAX_PCT_DEFAULT = 20.315;    // 譲渡益税(%)。利益が出た場合のみ適用

// Yahooのadjclose(分割・配当調整後終値)から、O/H/L/Vも同じ比率で調整した系列を作る
// （未調整のcloseのままだと分割時に指標・リターンが歪むため）
function buildAdjustedSeries(chart) {
  const q = chart.indicators?.quote?.[0] || {};
  const adj = chart.indicators?.adjclose?.[0]?.adjclose || null;
  const timestamps = chart.timestamp || [];
  const o = [], h = [], l = [], c = [], v = [], dates = [];
  for (let i = 0; i < timestamps.length; i++) {
    const rawO = q.open?.[i], rawH = q.high?.[i], rawL = q.low?.[i], rawC = q.close?.[i], rawV = q.volume?.[i];
    if (rawO == null || rawH == null || rawL == null || rawC == null || rawV == null || rawC <= 0) continue;
    const adjC = (adj && adj[i] != null) ? adj[i] : rawC;
    const ratio = rawC > 0 ? adjC / rawC : 1;
    o.push(rawO * ratio); h.push(rawH * ratio); l.push(rawL * ratio); c.push(adjC); v.push(rawV);
    dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
  }
  return { o, h, l, c, v, dates };
}

async function fetchN225Series(crumb, cookie) {
  const params = new URLSearchParams({ interval: '1d', range: '5y' });
  if (crumb) params.set('crumb', crumb);
  const url = `${YF_BASE}/v8/finance/chart/%5EN225?${params}`;
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) return {};
  const data = await res.json();
  const chart = data?.chart?.result?.[0];
  if (!chart) return {};
  const q = chart.indicators?.quote?.[0] || {};
  const timestamps = chart.timestamp || [];
  const map = {};
  for (let i = 0; i < timestamps.length; i++) {
    const cl = q.close?.[i];
    if (cl == null) continue;
    map[new Date(timestamps[i] * 1000).toISOString().slice(0, 10)] = cl;
  }
  return map;
}

// 休日ズレを±3日以内で吸収して最も近い日経225終値を探す（TSE個別銘柄と完全一致しない場合がある）
function n225CloseNear(map, dateStr) {
  if (!dateStr) return null;
  if (map[dateStr] != null) return map[dateStr];
  const base = new Date(dateStr + 'T00:00:00Z').getTime();
  for (let d = 1; d <= 3; d++) {
    const after = new Date(base + d * 86400000).toISOString().slice(0, 10);
    if (map[after] != null) return map[after];
    const before = new Date(base - d * 86400000).toISOString().slice(0, 10);
    if (map[before] != null) return map[before];
  }
  return null;
}

function scoreBucket(score) {
  if (score < 30) return '0-30';
  if (score < 50) return '30-50';
  if (score < 75) return '50-75';
  if (score < 90) return '75-90';
  return '90-100';
}

// calcTradeScoreのdetails[]から8項目それぞれの加点をカラム名に対応付けて集計する
// （材料/アナリストは条件付きで別々に加点されるため同一カラムに合算する）
const BACKTEST_ITEM_COLS = {
  '出来高': 'vol_pts', 'EMA配列': 'ema_pts', 'RSI': 'rsi_pts', 'MACD': 'macd_pts',
  'ATRボラ': 'atr_pts', 'GU/GD': 'gap_pts', '52W高値': 'w52_pts',
  '材料': 'material_pts', 'アナリスト': 'material_pts'
};
function extractItemPoints(details) {
  const cols = { vol_pts: 0, ema_pts: 0, rsi_pts: 0, macd_pts: 0, atr_pts: 0, gap_pts: 0, w52_pts: 0, material_pts: 0 };
  for (const d of details) {
    const col = BACKTEST_ITEM_COLS[d.name];
    if (col) cols[col] += d.pts;
  }
  return cols;
}

// 1銘柄・1チャンク分のバックテストを実行する。
// ルックアヘッド防止: スコア計算には slice(0, i+1) （i日目までのデータのみ）しか渡さない。
// エントリーは翌営業日の始値、+1/+5/+20営業日後の終値までの生リターン（コスト・税引前）を記録する。
async function evaluateStockChunk(code, crumb, cookie, n225Map, dayOffset) {
  const params = new URLSearchParams({ interval: '1d', range: '5y', includeAdjustedClose: 'true' });
  if (crumb) params.set('crumb', crumb);
  const url = `${YF_BASE}/v8/finance/chart/${code}.T?${params}`;
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) return { rows: [], evalStart: 0, evalEnd: -1, doneThisStock: true };
  const data = await res.json();
  const chart = data?.chart?.result?.[0];
  if (!chart) return { rows: [], evalStart: 0, evalEnd: -1, doneThisStock: true };
  const { o, h, l, c, v, dates } = buildAdjustedSeries(chart);
  if (c.length < 280) return { rows: [], evalStart: 0, evalEnd: -1, doneThisStock: true }; // warmup+評価+lookaheadに満たない銘柄は対象外

  const evalStart = Math.max(252, c.length - 776); // 直近3年相当を評価対象とし、その手前をEMA200等のwarmupに充てる
  const evalEnd = c.length - 21; // +20営業日後リターンを計算できる範囲まで

  const from = evalStart + dayOffset;
  const to = Math.min(from + BACKTEST_DAY_CHUNK - 1, evalEnd);

  const rows = [];
  for (let i = from; i <= to; i++) {
    const so = o.slice(0, i + 1), sh = h.slice(0, i + 1), sl = l.slice(0, i + 1), sc = c.slice(0, i + 1), sv = v.slice(0, i + 1);
    const ts = calcTradeScore(so, sh, sl, sc, sv, null, '1d');
    const entryPrice = o[i + 1];
    if (!(entryPrice > 0)) continue;
    const fwd1 = (c[i + 1] - entryPrice) / entryPrice * 100;
    const fwd5 = (c[i + 5] - entryPrice) / entryPrice * 100;
    const fwd20 = (c[i + 20] - entryPrice) / entryPrice * 100;
    const mBase = n225CloseNear(n225Map, dates[i]);
    const m1 = n225CloseNear(n225Map, dates[i + 1]);
    const m5 = n225CloseNear(n225Map, dates[i + 5]);
    const m20 = n225CloseNear(n225Map, dates[i + 20]);
    const pts = extractItemPoints(ts.details);
    rows.push({
      code, signal_date: dates[i], score: ts.score, signal: ts.signal, score_bucket: scoreBucket(ts.score),
      entry_price: Math.round(entryPrice * 100) / 100,
      fwd_ret_1: Math.round(fwd1 * 1000) / 1000,
      fwd_ret_5: Math.round(fwd5 * 1000) / 1000,
      fwd_ret_20: Math.round(fwd20 * 1000) / 1000,
      mkt_fwd_ret_1: (mBase && m1) ? Math.round((m1 - mBase) / mBase * 100000) / 1000 : null,
      mkt_fwd_ret_5: (mBase && m5) ? Math.round((m5 - mBase) / mBase * 100000) / 1000 : null,
      mkt_fwd_ret_20: (mBase && m20) ? Math.round((m20 - mBase) / mBase * 100000) / 1000 : null,
      ...pts
    });
  }
  return { rows, evalStart, evalEnd, doneThisStock: to >= evalEnd };
}

async function runBacktestChunk(env) {
  const supaUrl = env.SUPABASE_URL;
  const svcKey = env.SUPABASE_SERVICE_KEY;
  if (!svcKey) throw new Error('SUPABASE_SERVICE_KEY が未設定');
  const svcHeaders = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' };
  const anonReadHeaders = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, Accept: 'application/json' };

  const jobRes = await fetch(`${supaUrl}/rest/v1/backtest_jobs?status=eq.running&order=id.asc&limit=1`, { headers: anonReadHeaders });
  const jobs = await jobRes.json();
  const job = Array.isArray(jobs) ? jobs[0] : null;
  if (!job) return { ok: true, message: '実行中のバックテストジョブはありません' };

  if (job.cursor >= job.total_stocks) {
    await fetch(`${supaUrl}/rest/v1/backtest_jobs?id=eq.${job.id}`, {
      method: 'PATCH', headers: svcHeaders, body: JSON.stringify({ status: 'done', updated_at: new Date().toISOString() })
    });
    return { ok: true, job_id: job.id, done: true };
  }

  const { crumb, cookie } = await getCrumb();
  if (!crumb) throw new Error('crumb取得失敗');
  const n225Map = await fetchN225Series(crumb, cookie);

  const [code, name] = SCAN_STOCKS[job.cursor];
  let result;
  try {
    result = await evaluateStockChunk(code, crumb, cookie, n225Map, job.day_cursor);
  } catch (e) {
    console.error(`backtest ${code} error:`, e.message);
    result = { rows: [], doneThisStock: true }; // 取得失敗銘柄はスキップして次へ進める
  }

  if (result.rows.length) {
    const withJob = result.rows.map(r => ({ ...r, job_id: job.id }));
    for (let i = 0; i < withJob.length; i += 1000) {
      const chunk = withJob.slice(i, i + 1000);
      const insRes = await fetch(`${supaUrl}/rest/v1/backtest_signals`, {
        method: 'POST',
        headers: { ...svcHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk)
      });
      if (!insRes.ok) {
        const errBody = await insRes.text();
        throw new Error(`backtest_signals upsert失敗: ${insRes.status} ${errBody}`);
      }
    }
  }

  const finishedStock = result.doneThisStock !== false;
  const newCursor = finishedStock ? job.cursor + 1 : job.cursor;
  const newDayCursor = finishedStock ? 0 : job.day_cursor + BACKTEST_DAY_CHUNK;
  const done = newCursor >= job.total_stocks;

  await fetch(`${supaUrl}/rest/v1/backtest_jobs?id=eq.${job.id}`, {
    method: 'PATCH', headers: svcHeaders,
    body: JSON.stringify({ cursor: newCursor, day_cursor: newDayCursor, status: done ? 'done' : 'running', updated_at: new Date().toISOString() })
  });

  return { ok: true, job_id: job.id, code, name, rows_saved: result.rows.length, cursor: newCursor, day_cursor: newDayCursor, total_stocks: job.total_stocks, done };
}

async function handleBacktestStart(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200 });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  const token = request.headers.get('X-Admin-Token') || '';
  if (!env.ADMIN_TOKEN || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const supaUrl = env.SUPABASE_URL, svcKey = env.SUPABASE_SERVICE_KEY;
  if (!svcKey) return new Response(JSON.stringify({ error: 'SUPABASE_SERVICE_KEY未設定' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const svcHeaders = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const res = await fetch(`${supaUrl}/rest/v1/backtest_jobs`, {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify([{ status: 'running', cursor: 0, day_cursor: 0, total_stocks: SCAN_STOCKS.length, period_days: 756 }])
  });
  if (!res.ok) {
    const errBody = await res.text();
    return new Response(JSON.stringify({ error: `ジョブ作成失敗: ${res.status} ${errBody}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  const created = await res.json();
  return new Response(JSON.stringify({ ok: true, job: created[0] }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function handleBacktestTrigger(request, env) {
  // cronを待たずに手動で1チャンク進める（scan-triggerと同じ管理者トークン方式）
  if (request.method === 'OPTIONS') return new Response(null, { status: 200 });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  const token = request.headers.get('X-Admin-Token') || '';
  if (!env.ADMIN_TOKEN || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const result = await runBacktestChunk(env);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleBacktestStatus(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders() });
  const supaUrl = env.SUPABASE_URL, anonKey = env.SUPABASE_ANON_KEY;
  const jobId = url.searchParams.get('job_id');
  const anonHeaders = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json' };
  const q = jobId
    ? `${supaUrl}/rest/v1/backtest_jobs?id=eq.${jobId}`
    : `${supaUrl}/rest/v1/backtest_jobs?order=id.desc&limit=1`;
  const res = await fetch(q, { headers: anonHeaders });
  const data = await res.json();
  return new Response(JSON.stringify({ job: data?.[0] || null }), {
    status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}

// ── BACKTEST REPORT（集計） ───────────────────────────────────────────────────

function btMean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function btMedian(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function btStddev(arr) {
  if (arr.length < 2) return null;
  const m = btMean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function btPearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = btMean(xs), my = btMean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}
function btRound(v, d) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }
// 往復（エントリー・エグジット双方）の手数料・スリッページを控除し、利益が出た場合のみ譲渡益税を適用する
function btNetReturn(grossRetPct, feePct, slipPct, taxPct) {
  const frictionPct = 2 * (feePct + slipPct);
  const beforeTax = grossRetPct - frictionPct;
  return beforeTax > 0 ? beforeTax * (1 - taxPct / 100) : beforeTax;
}
// 時系列順の単純複利カーブによる近似（同時多重ポジションは考慮しない簡易指標）
function btEquityStats(retsPct) {
  let equity = 1, peak = 1, maxDD = 0, grossProfit = 0, grossLoss = 0;
  for (const r of retsPct) {
    equity *= (1 + r / 100);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
    if (r > 0) grossProfit += r; else grossLoss += -r;
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : null);
  return { maxDrawdownPct: btRound(maxDD * 100, 2), profitFactor: btRound(profitFactor, 2) };
}

async function fetchAllBacktestSignals(env, jobId) {
  const supaUrl = env.SUPABASE_URL, svcKey = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, Accept: 'application/json' };
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const q = `${supaUrl}/rest/v1/backtest_signals?job_id=eq.${jobId}&select=*&order=signal_date.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(q, { headers });
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

const BACKTEST_BUCKETS = ['0-30', '30-50', '50-75', '75-90', '90-100'];
const BACKTEST_HORIZONS = ['1', '5', '20'];
const BACKTEST_ITEM_COL_LIST = ['vol_pts', 'ema_pts', 'rsi_pts', 'macd_pts', 'atr_pts', 'gap_pts', 'w52_pts', 'material_pts'];

async function handleBacktestReport(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders() });
  const jobIdParam = url.searchParams.get('job_id');
  const feePct = parseFloat(url.searchParams.get('fee') || String(BACKTEST_FEE_PCT_DEFAULT));
  const slipPct = parseFloat(url.searchParams.get('slippage') || String(BACKTEST_SLIPPAGE_PCT_DEFAULT));
  const taxPct = parseFloat(url.searchParams.get('tax') || String(BACKTEST_TAX_PCT_DEFAULT));
  const supaUrl = env.SUPABASE_URL, svcKey = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, Accept: 'application/json' };

  let jobId = jobIdParam;
  if (!jobId) {
    const jr = await fetch(`${supaUrl}/rest/v1/backtest_jobs?order=id.desc&limit=1`, { headers });
    const jd = await jr.json();
    jobId = jd?.[0]?.id;
  }
  if (!jobId) {
    return new Response(JSON.stringify({ error: 'バックテストジョブがありません' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  const rows = await fetchAllBacktestSignals(env, jobId);
  if (!rows.length) {
    return new Response(JSON.stringify({ job_id: jobId, message: 'まだシグナルデータがありません（ジョブ進行中の可能性があります）', row_count: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
    });
  }

  const byBucket = {};
  for (const b of BACKTEST_BUCKETS) {
    const bucketRows = rows.filter(r => r.score_bucket === b);
    const entry = { count: bucketRows.length, horizons: {} };
    for (const hz of BACKTEST_HORIZONS) {
      const grossKey = `fwd_ret_${hz}`, mktKey = `mkt_fwd_ret_${hz}`;
      const gross = bucketRows.map(r => r[grossKey]).filter(v => v != null);
      const net = gross.map(v => btNetReturn(v, feePct, slipPct, taxPct));
      const mktVals = bucketRows.map(r => r[mktKey]).filter(v => v != null);
      const excess = bucketRows.filter(r => r[grossKey] != null && r[mktKey] != null).map(r => r[grossKey] - r[mktKey]);
      const winRate = gross.length ? gross.filter(v => v > 0).length / gross.length * 100 : null;
      const netWinRate = net.length ? net.filter(v => v > 0).length / net.length * 100 : null;
      const eq = btEquityStats(net);
      entry.horizons[hz + 'd'] = {
        n: gross.length,
        gross_mean_pct: btRound(btMean(gross), 3), gross_median_pct: btRound(btMedian(gross), 3),
        gross_std_pct: btRound(btStddev(gross), 3), gross_win_rate_pct: btRound(winRate, 1),
        net_mean_pct: btRound(btMean(net), 3), net_win_rate_pct: btRound(netWinRate, 1),
        market_mean_pct: btRound(btMean(mktVals), 3), excess_vs_market_mean_pct: btRound(btMean(excess), 3),
        max_drawdown_pct: eq.maxDrawdownPct, profit_factor: eq.profitFactor
      };
    }
    byBucket[b] = entry;
  }

  const itemAnalysis = {};
  for (const col of BACKTEST_ITEM_COL_LIST) {
    const withRet = rows.filter(r => r[col] != null && r.fwd_ret_20 != null);
    const withPts = withRet.filter(r => r[col] > 0);
    const withoutPts = withRet.filter(r => r[col] <= 0);
    itemAnalysis[col] = {
      n_positive: withPts.length, n_zero_or_negative: withoutPts.length,
      avg_fwd_ret_20_when_positive: btRound(btMean(withPts.map(r => r.fwd_ret_20)), 3),
      avg_fwd_ret_20_when_not_positive: btRound(btMean(withoutPts.map(r => r.fwd_ret_20)), 3),
      correlation_pts_vs_fwd_ret_20: btRound(btPearson(withRet.map(r => r[col]), withRet.map(r => r.fwd_ret_20)), 4)
    };
  }

  return new Response(JSON.stringify({
    job_id: jobId, row_count: rows.length,
    params: { fee_pct_one_way: feePct, slippage_pct_one_way: slipPct, tax_pct_on_gains: taxPct },
    by_score_bucket: byBucket,
    item_analysis: itemAnalysis
  }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() } });
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
    if (url.pathname === '/api/backtest-start') {
      return handleBacktestStart(request, env);
    }
    if (url.pathname === '/api/backtest-trigger') {
      return handleBacktestTrigger(request, env);
    }
    if (url.pathname === '/api/backtest-status') {
      return handleBacktestStatus(request, env, url);
    }
    if (url.pathname === '/api/backtest-report') {
      return handleBacktestReport(request, env, url);
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
    if (event.cron === '*/2 * * * *') {
      // バックテスト継続用（数分おき）。実行中ジョブが無ければ何もしない
      ctx.waitUntil(
        runBacktestChunk(env).then(r => {
          console.log('Cron backtest チャンク完了:', JSON.stringify(r));
        }).catch(e => {
          console.error('Cron backtest失敗:', e.message);
        })
      );
      return;
    }
    // 日次スキャナー（既存）
    // maxStocks指定なしだと81銘柄フルスキャンでサブリクエスト上限(50)を超え毎回失敗するため、
    // 手動トリガーと同じ44銘柄上限を明示する
    ctx.waitUntil(
      runScanner(env, 44).then(r => {
        console.log('Cron scanner完了:', JSON.stringify(r));
      }).catch(e => {
        console.error('Cron scanner失敗:', e.message);
      })
    );
  }
};
