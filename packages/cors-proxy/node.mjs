// Runs worker.js on Node's http server. Needs Node 18 or newer.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import worker from './worker.js';

const flag = (value) => ['1', 'true'].includes(String(value).toLowerCase());

function privateIPv4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b < 128)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function ipv6Bytes(address) {
  let text = address.split('%')[0].toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const groups = [...left, ...Array(rest === undefined ? 0 : 8 - left.length - right.length).fill('0'), ...right];
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 255];
  });
}

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) return privateIPv4(address.split('.').map(Number));
  const bytes = ipv6Bytes(address);
  const embedded = (offset) => privateIPv4(bytes.slice(offset, offset + 4));
  const startsWith = (...prefix) => prefix.every((byte, index) => bytes[index] === byte);
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return embedded(12); // ::, ::1, IPv4-compatible
  if (startsWith(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255)) return embedded(12); // IPv4-mapped
  if (startsWith(0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0)) return embedded(12); // NAT64
  if (startsWith(0x20, 0x02)) return embedded(2); // 6to4
  return (bytes[0] & 0xfe) === 0xfc // fc00::/7
    || (bytes[0] === 0xfe && (bytes[1] & 0x80) !== 0) // fe80::/10 and fec0::/10
    || bytes[0] === 0xff;
}

export async function refusePrivateTarget(target) {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return undefined; // the fetch fails with its own error
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) return 'Private targets are not allowed';
  return undefined;
}

// `origin` stands in for the browser's Origin header when a request has none
export function createProxyServer(env, { origin } = {}) {
  const workerEnv = flag(env.ALLOW_PRIVATE_TARGETS) ? env : { ...env, checkTarget: refusePrivateTarget };
  const server = http.createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) headers.set(name, value);
      if (origin && !headers.has('Origin')) headers.set('Origin', origin);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const response = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
      }), workerEnv);
      res.writeHead(response.status, [...response.headers]);
      if (!response.body) return res.end();
      const body = Readable.fromWeb(response.body);
      body.on('error', () => res.destroy());
      res.on('close', () => body.destroy());
      body.pipe(res);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  // Keep idle connections longer than a tunnel's, which would otherwise reset them
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const env = {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    ACCESS_KEY: process.env.ACCESS_KEY || undefined,
    REQUIRE_ACCESS_KEY: flag(process.env.REQUIRE_ACCESS_KEY),
    ALLOW_PRIVATE_TARGETS: process.env.ALLOW_PRIVATE_TARGETS,
  };
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  createProxyServer(env).listen(port, host, () => console.log(`CORS proxy listening on http://${host}:${port}/`));
}
