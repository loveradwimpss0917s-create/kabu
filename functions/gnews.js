// functions/gnews.js
// /gnews?code=7203&name=ダイキン → Google News RSS (日本語) をパース

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const name = url.searchParams.get('name') || '';

  if (!code) {
    return new Response(JSON.stringify({ error: 'code required', news: [] }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  // 検索クエリ（会社名がある場合は優先、なければコード）
  const queries = [];
  if (name && name.length > 1) queries.push(name + ' 株');
  queries.push(code + ' 株価');

  let allItems = [];

  for (const q of queries) {
    if (allItems.length >= 8) break;
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;

    try {
      const res = await fetch(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible)',
          'Accept': 'text/xml, application/xml',
        },
      });
      if (!res.ok) continue;

      const xml = await res.text();

      // <item>を正規表現でパース
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && allItems.length < 8) {
        const item = match[1];

        const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                           item.match(/<title>([\s\S]*?)<\/title>/);
        let title = titleMatch ? titleMatch[1] : '';
        title = title
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .trim();
        if (!title || title.length < 5) continue;

        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
        const link = linkMatch ? linkMatch[1].trim() : '#';

        const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        const ts = dateMatch ? Math.floor(new Date(dateMatch[1]).getTime() / 1000) : 0;

        const srcMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/);
        const source = srcMatch ? srcMatch[1].replace(/<[^>]+>/g, '').trim() : 'Google News';

        // 重複除去
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
