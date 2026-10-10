import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import { after, before, describe, mock, test } from 'node:test';
import { createProxyServer, isPrivateAddress } from '../node.mjs';

const ORIGIN = 'https://site.example';
const KEY = 'secret';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

describe('proxy', () => {
  let target;
  let targetPort;
  const proxies = [];

  async function startProxy(env) {
    const server = createProxyServer({ ALLOWED_ORIGINS: ORIGIN, ...env });
    proxies.push(server);
    return `http://127.0.0.1:${await listen(server)}/`;
  }

  function ask(proxy, url, { origin = ORIGIN, key, method = 'GET', body } = {}) {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (key) headers['X-Ytdlp-Key'] = key;
    return fetch(`${proxy}?url=${encodeURIComponent(url)}`, { method, headers, body, redirect: 'manual' });
  }

  before(async () => {
    target = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/ok' }).end();
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`${req.method} ${req.url} ${Buffer.concat(chunks)}`));
    });
    targetPort = await listen(target);
  });

  after(async () => {
    await close(target);
    await Promise.all(proxies.map(close));
  });

  test('relays a request when private targets are allowed', async () => {
    const proxy = await startProxy({ ALLOW_PRIVATE_TARGETS: 'true' });
    const response = await ask(proxy, `http://127.0.0.1:${targetPort}/ok?a=1`, { method: 'POST', body: 'hello' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ytdlp-status'), '200');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(await response.text(), 'POST /ok?a=1 hello');
  });

  test('returns redirects without following them', async () => {
    const proxy = await startProxy({ ALLOW_PRIVATE_TARGETS: 'true' });
    const response = await ask(proxy, `http://127.0.0.1:${targetPort}/redirect`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ytdlp-status'), '302');
    const headers = Object.fromEntries(JSON.parse(response.headers.get('x-ytdlp-response-headers')));
    assert.equal(headers.location, '/ok');
  });

  test('refuses private targets by default', async () => {
    const proxy = await startProxy({});
    const urls = [
      `http://127.0.0.1:${targetPort}/`,
      'http://10.1.2.3/',
      'http://192.168.0.1/',
      'http://169.254.169.254/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://2130706433/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fd00::1]/',
      `http://localhost:${targetPort}/`,
    ];
    for (const url of urls) {
      const response = await ask(proxy, url);
      assert.equal(response.status, 403, url);
      assert.equal(response.headers.get('x-ytdlp-status'), null, url);
      assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN, url);
      assert.match(response.headers.get('access-control-expose-headers'), /X-Ytdlp-Status/, url);
      assert.match(await response.text(), /Private targets/, url);
    }
  });

  test('refuses a hostname when any address is private', async (t) => {
    const lookup = t.mock.method(dns, 'lookup', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const proxy = await startProxy({});
    const response = await ask(proxy, `http://rebind.test:${targetPort}/`);
    assert.equal(response.status, 403);
    assert.equal(lookup.mock.callCount(), 1);
  });

  test('relays a hostname that resolves to public addresses only', async (t) => {
    t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
    const proxy = await startProxy({});
    const response = await ask(proxy, 'http://unreachable.test:1/');
    assert.notEqual(response.status, 403);
  });

  test('enforces the access key', async () => {
    const proxy = await startProxy({ ACCESS_KEY: KEY, REQUIRE_ACCESS_KEY: true, ALLOW_PRIVATE_TARGETS: 'true' });
    const url = `http://127.0.0.1:${targetPort}/ok`;
    for (const key of [undefined, 'wrong']) {
      const response = await ask(proxy, url, { key });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    }
    assert.equal((await ask(proxy, url, { key: KEY })).status, 200);
  });

  test('refuses every request when a required key is not set', async () => {
    const proxy = await startProxy({ REQUIRE_ACCESS_KEY: true, ALLOW_PRIVATE_TARGETS: 'true' });
    const response = await ask(proxy, `http://127.0.0.1:${targetPort}/ok`);
    assert.equal(response.status, 403);
  });

  test('refuses other origins without CORS headers', async () => {
    const proxy = await startProxy({ ALLOW_PRIVATE_TARGETS: 'true' });
    for (const origin of ['https://evil.example', null]) {
      const response = await ask(proxy, `http://127.0.0.1:${targetPort}/ok`, { origin });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  });

  test('answers preflight requests', async () => {
    const proxy = await startProxy({});
    const response = await fetch(proxy, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('access-control-allow-headers'), /X-Ytdlp-Key/);
  });

  test('checks the origin and key before resolving the target', async (t) => {
    const lookup = t.mock.method(dns, 'lookup', async () => []);
    const proxy = await startProxy({ ACCESS_KEY: KEY });
    await ask(proxy, 'http://probe.test/', { origin: 'https://evil.example' });
    await ask(proxy, 'http://probe.test/', { key: 'wrong' });
    assert.equal(lookup.mock.callCount(), 0);
  });
});

test('isPrivateAddress', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.1.1', '172.16.0.1',
    '172.31.255.255', '192.168.1.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'fc00::1', 'fd12::1', 'fe80::1',
    '64:ff9b::a00:1', '2002:7f00:1::', 'ff02::1',
  ];
  const allowed = ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '93.184.216.34',
    '2606:4700:4700::1111', '::ffff:8.8.8.8', '2001:db8::1'];
  for (const address of blocked) assert.equal(isPrivateAddress(address), true, address);
  for (const address of allowed) assert.equal(isPrivateAddress(address), false, address);
});
