// Same-origin proxy for the Heeben Python API.
// Set HEEBEN_API_URL in Vercel to the backend origin, e.g. https://heeben-api.onrender.com
// Disable Vercel's automatic body parser so POST/PUT JSON bodies reach the upstream unchanged.
module.exports = async function handler(req, res) {
  const backend = (process.env.HEEBEN_API_URL || '').trim().replace(/\/+$/, '');
  res.setHeader('Cache-Control', 'no-store');

  if (!backend) {
    return res.status(503).json({
      error: 'Heeben backend is not connected. Add HEEBEN_API_URL in Vercel and redeploy.'
    });
  }

  const incomingUrl = req.url || '/api';
  const target = backend + (incomingUrl.startsWith('/') ? incomingUrl : '/' + incomingUrl);
  const headers = {
    accept: req.headers.accept || 'application/json',
    'x-forwarded-proto': (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim(),
    'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers.cookie) headers.cookie = req.headers.cookie;

  const options = { method: req.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(req.method)) {
    // With bodyParser disabled below, the request remains a readable stream.
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    options.body = Buffer.concat(chunks);
  }

  try {
    const upstream = await fetch(target, options);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const setCookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);

    const body = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(body);
  } catch (error) {
    console.error('Heeben API proxy failed:', error);
    return res.status(502).json({
      error: 'Heeben backend could not be reached. Check that the Render service is live and HEEBEN_API_URL is correct.'
    });
  }
};

// Vercel must not consume the JSON request body before the proxy forwards it.
module.exports.config = { api: { bodyParser: false } };
