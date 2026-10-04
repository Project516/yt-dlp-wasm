// Local servers for the library tests: tiny media files, and the package files for the browser.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, 'fixtures');
export const PACKAGE_ROOT = path.join(here, '..');

const TYPES = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.whl': 'application/octet-stream',
};

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
    }));
  });
}

function sendFile(req, res, file, headers = {}) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return res.writeHead(404).end();
    res.writeHead(200, {
      ...headers,
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

// Serves fixtures/. With `cors`, any origin may read it, as a media host that allows browsers would.
export function startMediaServer({ cors = false } = {}) {
  return listen((req, res) => {
    const headers = cors ? {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
    } : {};
    if (req.method === 'OPTIONS') return res.writeHead(204, headers).end();
    sendFile(req, res, path.join(FIXTURES, path.basename(new URL(req.url, 'http://x').pathname)), headers);
  });
}

// Serves the package directory, so a page can import src/ and fetch dist/
export function startSiteServer() {
  return listen((req, res) => {
    const file = path.join(PACKAGE_ROOT, path.normalize(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(PACKAGE_ROOT + path.sep)) return res.writeHead(403).end();
    sendFile(req, res, file);
  });
}
