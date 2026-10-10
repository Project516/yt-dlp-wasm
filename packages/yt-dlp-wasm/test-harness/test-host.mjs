// The `yt_dlp_test_host` module, registered only by run-tests.mjs. It runs the
// test suite's HTTP servers in a CPython process because Pyodide has no
// sockets or threads. Set YTDLP_TEST_PYTHON to use another interpreter.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-server.py');

// Serves the CORS proxy in-process. Node.js sends no Origin, so `origin`
// stands in for the browser's. The test servers are on loopback.
export function createProxies(root) {
  const servers = new Map();
  let nextId = 0;

  async function start(envJson, origin) {
    const { createProxyServer } = await import(pathToFileURL(path.join(root, 'packages/cors-proxy/node.mjs')));
    const env = { ...JSON.parse(envJson), ALLOW_PRIVATE_TARGETS: true };
    const server = createProxyServer(env, { origin });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const id = nextId++;
    servers.set(id, server);
    return { id, port: server.address().port };
  }

  async function stop(id) {
    const server = servers.get(id);
    servers.delete(id);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  return { start, stop };
}

export function createTestHost(root) {
  const proxies = createProxies(root);
  let child;
  let nextId = 0;
  const pending = new Map();

  function sidecar() {
    if (child) return child;
    child = spawn(process.env.YTDLP_TEST_PYTHON || 'python3', [script, root], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      if (!pending.has(reply?.id)) return;
      const { resolve, reject } = pending.get(reply.id);
      pending.delete(reply.id);
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply);
    });
    child.on('exit', (code) => {
      for (const { reject } of pending.values()) {
        reject(new Error(`test server process exited with code ${code}`));
      }
      pending.clear();
      child = undefined;
    });
    child.on('error', (error) => child.emit('exit', error.message));
    // A write racing the child's exit fails here; the exit handler rejects the request
    child.stdin.on('error', () => {});
    return child;
  }

  function send(command) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      sidecar().stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  process.on('exit', () => child?.kill());

  return {
    start: (module, handler, server, certfile, cafile) =>
      send({ op: 'start', module, handler, server, certfile, cafile }),
    stop: (server) => send({ op: 'stop', server }),
    startProxy: proxies.start,
    stopProxy: proxies.stop,
  };
}
