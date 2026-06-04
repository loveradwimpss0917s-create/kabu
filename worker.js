// worker.js — kabu main entry point
// Handles /yfin/* and /gnews proxies; serves static assets for everything else

const YF_BASE = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cachedCrumb = null;
let cachedCookie = null;
let crumbExpiry = 0;

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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/yfin/')) {
      return handleYfin(request, url);
    }

    if (url.pathname === '/gnews') {
      return handleGnews(request, url);
    }

    // Static assets (index.html, manifest.json, sw.js, etc.)
    return env.ASSETS.fetch(request);
  }
};
