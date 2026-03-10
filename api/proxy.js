// Vercel serverless function — mirrors the /api/proxy route in server.js

const ALLOWED = new Set([
  'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
  'feeds.bbci.co.uk', 'www.aljazeera.com', 'rss.cnn.com',
  'feeds.reuters.com', 'feeds.npr.org', 'feeds.skynews.com',
  'www.whitehouse.gov', 'en.kremlin.ru', 'kremlin.ru',
  'www.vaticannews.va', 'pib.gov.in', 'www.xinhuanet.com',
  'nitter.privacydev.net', 'nitter.poast.org', 'nitter.1d4.us', 'nitter.net',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Module-level crumb cache (persists across warm invocations on Vercel)
let yfCache = { cookies: '', crumb: '', exp: 0 };

async function getYFCrumb() {
  if (Date.now() < yfCache.exp) return yfCache;
  try {
    const r1 = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    const raw = typeof r1.headers.getSetCookie === 'function'
      ? r1.headers.getSetCookie()
      : [r1.headers.get('set-cookie') || ''];
    const cookies = raw.map(c => c.split(';')[0]).join('; ');

    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookies },
      signal: AbortSignal.timeout(8000),
    });
    const crumb = (await r2.text()).trim();
    yfCache = { cookies, crumb, exp: Date.now() + 3_600_000 };
  } catch (_) {}
  return yfCache;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  if (!ALLOWED.has(parsed.hostname)) {
    return res.status(403).json({ error: `Domain not in allowlist: ${parsed.hostname}` });
  }

  const isYahoo = parsed.hostname.endsWith('yahoo.com');

  try {
    let fetchUrl = url;
    let headers  = { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' };

    if (isYahoo) {
      const { cookies, crumb } = await getYFCrumb();
      if (crumb) {
        const sep = url.includes('?') ? '&' : '?';
        fetchUrl = url + sep + 'crumb=' + encodeURIComponent(crumb);
        headers  = { ...headers, Cookie: cookies, Referer: 'https://finance.yahoo.com/' };
      }
    }

    const upstream = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(12000) });
    const ct   = upstream.headers.get('content-type') || 'application/octet-stream';
    const body = await upstream.arrayBuffer();
    res.setHeader('Content-Type', ct).status(upstream.status).send(Buffer.from(body));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
