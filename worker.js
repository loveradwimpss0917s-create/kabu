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
    // クロスオリジン(Yahoo)へのfetchでは標準のRequestInit `cache`は未サポートで
    // 例外(HTTP 500)になるため使わない。Cloudflare固有の cf.cacheTtl で
    // エッジキャッシュを明示的に無効化する。株価は毎回最新であるべきで、
    // スキャナー結果と食い違う古いデータが返る事故を防ぐ
    const res = await fetch(targetUrl, { headers: fetchHeaders, cf: { cacheTtl: 0, cacheEverything: false } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders()
      }
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

async function scanStock(code, name, crumb, cookie, nextEarningsEpoch) {
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

    // 決算日はearnings_calendarキャッシュから渡された値のみを使う（Subrequest数上限のため
    // ここではquoteSummaryを個別取得しない）。index.htmlのanalyze()と同じ判定になるよう、
    // calcTradeScoreにはYahoo quoteSummary形式と同じ最小構造で渡す
    const summaryData = nextEarningsEpoch
      ? { calendarEvents: { earnings: { earningsDate: [{ raw: nextEarningsEpoch }] } } }
      : null;
    const ts = calcTradeScore(series.o, series.h, series.l, series.c, series.v, summaryData, '1d');
    const last = series.c.length - 1;
    const price = series.rawClose[last];
    const prevClose = series.rawClose[last - 1] || price;
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    return {
      code, name,
      score: ts.score,
      signal: ts.signal,
      signal_class: ts.signalClass,
      earningsVetoActive: ts.earningsVeto.active,
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

// earnings_calendarキャッシュ（週次更新、scripts/fetch-earnings-calendar.mjsが書き込む）を
// 1回のSupabase読み取りで取得する。銘柄ごとに個別取得しないのはSubrequest数上限のため
async function fetchEarningsMap(env) {
  const map = new Map();
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/earnings_calendar?select=code,next_earnings_epoch`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`, Accept: 'application/json' }
    });
    if (!res.ok) return map;
    const rows = await res.json();
    if (Array.isArray(rows)) for (const r of rows) if (r.next_earnings_epoch != null) map.set(r.code, r.next_earnings_epoch);
  } catch (e) {
    console.error('earnings_calendar取得エラー:', e.message);
  }
  return map;
}

// opts.offset/opts.limit で SCAN_STOCKS の部分範囲だけを走査する（日次cronを2本に分割し
// 81銘柄全体を1本あたり50サブリクエスト未満に収めるため）。省略時は全銘柄を対象にする。
async function runScanner(env, opts) {
  const offset = (opts && opts.offset) || 0;
  const limit = opts && opts.limit;

  const { crumb, cookie } = await getCrumb();
  if (!crumb) throw new Error('crumb取得失敗');

  const mc = await getMarketCondition(crumb, cookie);
  const earningsMap = await fetchEarningsMap(env);

  const stockList = limit != null ? SCAN_STOCKS.slice(offset, offset + limit) : SCAN_STOCKS.slice(offset);
  const results = [];
  const batchSize = 10;
  const scanStart = Date.now();
  const MAX_SCAN_MS = 24000;
  for (let i = 0; i < stockList.length; i += batchSize) {
    if (Date.now() - scanStart > MAX_SCAN_MS) break;
    const batch = stockList.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map(([code, name]) => scanStock(code, name, crumb, cookie, earningsMap.get(code))));
    for (const r of batchRes) {
      if (r) {
        // 決算veto中はindex.htmlのanalyze()と同様、地合い調整をスキップして中立表示を維持する
        const adjScore = r.earningsVetoActive ? r.score : Math.max(0, Math.min(100, r.score + mc.adj));
        let signal, signalClass;
        if (adjScore >= 90) { signal = 'STRONG BUY'; signalClass = 'strong-buy'; }
        else if (adjScore >= 75) { signal = 'BUY'; signalClass = 'buy'; }
        else if (adjScore >= 50) { signal = 'NEUTRAL'; signalClass = 'neutral'; }
        else if (adjScore >= 30) { signal = 'SELL'; signalClass = 'sell'; }
        else { signal = 'STRONG SELL'; signalClass = 'strong-sell'; }
        const { earningsVetoActive, ...rest } = r;
        results.push({ ...rest, score: adjScore, signal, signal_class: signalClass });
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

// ── アウトオブサンプル追跡（実運用シグナルの結果を後から記録する） ───────────
// docs/検証結果まとめ_2026-08.md の検証はすべてイン・サンプル（過去データへの
// 事後検証）だった。日次スキャンで実際に出したシグナルについて、20営業日後の
// 株価を後から取得して記録することで、初めてアウト・オブ・サンプルの検証になる。
//
// scan_resultsの各行(scan_date, code)に対し、20営業日以上前で結果未計算(outcome_computed_at
// is null)の最古の日付を1つ選び、その日のシグナルについてrange=3moで株価を取得し、
// 当時の終値から20営業日後の終値までのリターン(ret20)を計算して書き戻す。
// ベンチマーク（同日の他銘柄との比較）は表示側（handleSignalTrack）で都度計算するため、
// ここではret20の生値だけを保存する（書き込みタイミングの調整が不要になる）。
async function computeSignalOutcomes(env, opts) {
  const offset = (opts && opts.offset) || 0;
  const limit = (opts && opts.limit) || 40;
  const supaUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  const svcKey = env.SUPABASE_SERVICE_KEY;
  if (!svcKey) throw new Error('SUPABASE_SERVICE_KEY が未設定');

  const anonHeaders = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json' };

  // 20営業日後の終値が確定しているとみなせるよう、30暦日以上前のシグナルのみ対象にする
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const dateRes = await fetch(
    `${supaUrl}/rest/v1/scan_results?select=scan_date&outcome_computed_at=is.null&scan_date=lte.${cutoff}&order=scan_date.asc&limit=1`,
    { headers: anonHeaders }
  );
  if (!dateRes.ok) throw new Error(`対象日取得失敗: HTTP ${dateRes.status}`);
  const dateRows = await dateRes.json();
  if (!Array.isArray(dateRows) || dateRows.length === 0) {
    return { processed: 0, reason: '未計算のシグナルなし（30日以上前のもの）' };
  }
  const targetDate = dateRows[0].scan_date;

  const rowsRes = await fetch(
    `${supaUrl}/rest/v1/scan_results?select=code&scan_date=eq.${targetDate}&outcome_computed_at=is.null&order=code.asc&offset=${offset}&limit=${limit}`,
    { headers: anonHeaders }
  );
  if (!rowsRes.ok) throw new Error(`対象銘柄取得失敗: HTTP ${rowsRes.status}`);
  const rows = await rowsRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { processed: 0, targetDate, reason: 'このオフセットに対象銘柄なし' };
  }

  const { crumb, cookie } = await getCrumb();
  const updated = [];
  for (const { code } of rows) {
    try {
      const ret20 = await fetchOutcomeReturn(code, targetDate, crumb, cookie);
      updated.push({ code, ret20 });
    } catch (e) {
      console.error(`outcome ${code} error:`, e.message);
      updated.push({ code, ret20: null });
    }
  }

  const now = new Date().toISOString();
  const patchHeaders = {
    apikey: svcKey, Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal'
  };
  // 1件ずつPATCH（scan_date+codeで一意）。件数はoffset/limitで小さく抑えているため
  // Subrequest数上限内に収まる
  for (const u of updated) {
    await fetch(`${supaUrl}/rest/v1/scan_results?scan_date=eq.${targetDate}&code=eq.${u.code}`, {
      method: 'PATCH', headers: patchHeaders,
      body: JSON.stringify({ ret20: u.ret20, outcome_computed_at: now })
    });
  }

  return { processed: updated.length, targetDate, offset, limit };
}

// scan_date時点の終値から20営業日後の終値までのリターン(%)を計算する。
// range=3moなら30日以上前のscan_dateから20営業日後まで十分にカバーできる
async function fetchOutcomeReturn(code, scanDateStr, crumb, cookie) {
  const symbol = code + '.T';
  const params = new URLSearchParams({ interval: '1d', range: '3mo' });
  if (crumb) params.set('crumb', crumb);
  const targetUrl = `${YF_BASE}/v8/finance/chart/${symbol}?${params}`;
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(targetUrl, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  const chart = data?.chart?.result?.[0];
  if (!chart) return null;
  const ts = chart.timestamp || [];
  const closes = chart.indicators?.quote?.[0]?.close || [];
  let idx = -1;
  for (let i = 0; i < ts.length; i++) {
    if (new Date(ts[i] * 1000).toISOString().slice(0, 10) === scanDateStr) { idx = i; break; }
  }
  if (idx < 0 || idx + 20 >= ts.length) return null;
  const base = closes[idx], fut = closes[idx + 20];
  if (!(base > 0) || !(fut > 0)) return null;
  return Math.round((fut - base) / base * 100 * 100) / 100;
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

// アウトオブサンプル追跡結果のスコア帯別集計API（読み取り専用・認証不要）。
// ret20が記録済みの行のみを対象に、同日の全銘柄平均を簡易ベンチマークとして
// 超過リターンを都度計算する（書き込み時にbenchmarkを確定させる必要をなくすため）。
// docs/検証結果まとめ_2026-08.md の3,575銘柄・移動ブロック・ブートストラップとは異なり、
// 実運用の少数サンプルに対する簡易集計（標準誤差ベースのCI）である点に注意
async function handleSignalTrack(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders() });
  const supaUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!supaUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Supabase設定なし' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  try {
    const anonHeaders = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json' };
    const all = [];
    let offset = 0;
    const PAGE = 1000;
    for (;;) {
      const res = await fetch(
        `${supaUrl}/rest/v1/scan_results?select=scan_date,code,score,signal,ret20&ret20=not.is.null&order=scan_date.asc&limit=${PAGE}&offset=${offset}`,
        { headers: anonHeaders }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }

    if (!all.length) {
      return new Response(JSON.stringify({ n: 0, startDate: null, endDate: null, bands: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
      });
    }

    // 同日の全銘柄平均を簡易ベンチマークとする
    const byDate = new Map();
    for (const r of all) {
      if (!byDate.has(r.scan_date)) byDate.set(r.scan_date, []);
      byDate.get(r.scan_date).push(r.ret20);
    }
    const benchmarkOf = new Map();
    for (const [date, rets] of byDate) benchmarkOf.set(date, rets.reduce((a, b) => a + b, 0) / rets.length);

    const BANDS = [
      { min: 90, max: 101, label: '90-100' }, { min: 75, max: 90, label: '75-90' },
      { min: 50, max: 75, label: '50-75' }, { min: 30, max: 50, label: '30-50' },
      { min: 0, max: 30, label: '0-30' }
    ];
    const bands = BANDS.map(b => {
      const excess = all
        .filter(r => r.score >= b.min && r.score < b.max)
        .map(r => r.ret20 - benchmarkOf.get(r.scan_date));
      const n = excess.length;
      if (!n) return { label: b.label, n: 0, meanExcessPct: null, ci95: [null, null] };
      const mean = excess.reduce((a, x) => a + x, 0) / n;
      const variance = n > 1 ? excess.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0;
      const se = Math.sqrt(variance / n);
      // 標準誤差ベースの簡易95%CI。日次の銘柄横断相関を補正していないため、
      // サンプルが少ないうちは実際より狭くなりうる（参考値として扱うこと）
      return {
        label: b.label, n,
        meanExcessPct: Math.round(mean * 100) / 100,
        ci95: [Math.round((mean - 1.96 * se) * 100) / 100, Math.round((mean + 1.96 * se) * 100) / 100]
      };
    });

    const dates = [...byDate.keys()].sort();
    return new Response(JSON.stringify({ n: all.length, startDate: dates[0], endDate: dates[dates.length - 1], bands }), {
      status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
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
    if (url.pathname === '/api/signal-track') {
      return handleSignalTrack(request, env);
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
    // 81銘柄を1本のcronで走査すると crumb2+market1+earnings1+銘柄81+upsert1=86 サブリクエストとなり
    // 無料プランの上限50を超え毎回失敗する。2本のcronに分割し、それぞれ50未満に収める
    if (event.cron === '0 23 * * *' || event.cron === '10 23 * * *') {
      const isSecondHalf = event.cron === '10 23 * * *';
      const opts = isSecondHalf ? { offset: 40, limit: 41 } : { offset: 0, limit: 40 };
      ctx.waitUntil(
        runScanner(env, opts).then(r => {
          console.log(`Cron scanner完了 (${isSecondHalf ? '後半' : '前半'}):`, JSON.stringify(r));
        }).catch(e => {
          console.error(`Cron scanner失敗 (${isSecondHalf ? '後半' : '前半'}):`, e.message);
        })
      );
      return;
    }
    // アウトオブサンプル追跡: 20営業日以上前のシグナルの実際の結果を後から記録する。
    // 同じ日付分を2本のcronに分けて処理し(scanと同じ理由でSubrequest数上限のため)、
    // 未処理分が残っていれば翌日以降も自動的に続きから処理される
    if (event.cron === '20 23 * * *' || event.cron === '25 23 * * *') {
      const isSecondHalf = event.cron === '25 23 * * *';
      const opts = isSecondHalf ? { offset: 40, limit: 41 } : { offset: 0, limit: 40 };
      ctx.waitUntil(
        computeSignalOutcomes(env, opts).then(r => {
          console.log(`Cron outcome追跡完了 (${isSecondHalf ? '後半' : '前半'}):`, JSON.stringify(r));
        }).catch(e => {
          console.error(`Cron outcome追跡失敗 (${isSecondHalf ? '後半' : '前半'}):`, e.message);
        })
      );
    }
  }
};
