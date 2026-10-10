// CORS proxy for yt-dlp-wasm.
// Request: `?url=<target>`, the target's request headers as a JSON object in
// X-Ytdlp-Headers, and optionally X-Ytdlp-Key.
// Response: the target's body, with its status in X-Ytdlp-Status, its reason in
// X-Ytdlp-Reason and all its headers as JSON [name, value] pairs in
// X-Ytdlp-Response-Headers. Redirects are not followed.
const EXPOSED_HEADERS = 'X-Ytdlp-Status, X-Ytdlp-Reason, X-Ytdlp-Response-Headers';

function originAllowed(origin, env) {
  const patterns = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return patterns.some((pattern) => {
    if (pattern === '*') return Boolean(env.ACCESS_KEY);
    if (!origin) return false;
    if (pattern.endsWith(':*')) return new RegExp(`^${escapeRegExp(pattern.slice(0, -1))}\\d+$`).test(origin);
    return pattern === origin;
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Header values must be ASCII for every client to read them
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function refuse(status, message, cors) {
  return new Response(message, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (!originAllowed(origin, env)) return refuse(403, 'Origin not allowed');
    const cors = {
      'Access-Control-Allow-Origin': origin ?? '*',
      'Access-Control-Expose-Headers': EXPOSED_HEADERS,
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': request.headers.get('Access-Control-Request-Method') ?? '*',
          'Access-Control-Allow-Headers': 'X-Ytdlp-Headers, X-Ytdlp-Key',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (env.REQUIRE_ACCESS_KEY && !env.ACCESS_KEY) return refuse(403, 'ACCESS_KEY is not set', cors);
    if (env.ACCESS_KEY && request.headers.get('X-Ytdlp-Key') !== env.ACCESS_KEY) {
      return refuse(403, 'Invalid access key', cors);
    }
    if (env.RATE_LIMITER) {
      const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!(await env.RATE_LIMITER.limit({ key })).success) return refuse(429, 'Rate limit exceeded', cors);
    }

    let target;
    let headers;
    try {
      target = new URL(new URL(request.url).searchParams.get('url'));
      headers = new Headers(JSON.parse(request.headers.get('X-Ytdlp-Headers') ?? '{}'));
    } catch {
      return refuse(400, 'Invalid url or X-Ytdlp-Headers', cors);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return refuse(400, 'Only http and https targets are allowed', cors);
    }
    // Optional hook that node.mjs sets to refuse private targets
    const refusal = await env.checkTarget?.(target);
    if (refusal) return refuse(403, refusal, cors);
    // The runtime negotiates the encoding itself and decodes the body
    headers.delete('Accept-Encoding');
    // Without it Node.js sends a streamed body chunked, which some servers reject
    const length = request.headers.get('Content-Length');
    if (length) headers.set('Content-Length', length);

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        duplex: 'half',
      });
    } catch (error) {
      return refuse(502, `Fetching the target failed: ${error.message}`, cors);
    }

    return new Response(upstream.body, {
      headers: {
        ...cors,
        'X-Ytdlp-Status': String(upstream.status),
        'X-Ytdlp-Reason': upstream.statusText,
        'X-Ytdlp-Response-Headers': asciiJson([...upstream.headers]),
      },
    });
  },
};
