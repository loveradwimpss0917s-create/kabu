// functions/yfin/[[path]].js
// Yahoo Finance proxy with crumb authentication

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
      headers: {
        'User-Agent': UA,
        'Cookie': cookie,
        'Accept': 'text/plain,*/*',
        'Referer': 'https://finance.yahoo.com'
      }
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

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  const url = new URL(request.url);
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
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/json',
        ...corsHeaders()
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
