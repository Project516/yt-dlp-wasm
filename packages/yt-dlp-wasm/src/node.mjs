// The Node.js entry. Runs Pyodide in this process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCookies } from './cookies.mjs';
import { createEngine } from './engine.mjs';
import { createHost } from './host-node.mjs';
import { assertJspi } from './jspi.mjs';
import { mimeTypeOf } from './mime.mjs';

export { YtDlpError } from './errors.mjs';

const DIST = new URL('../dist/', import.meta.url);
const WHEEL_MOUNT = '/yt-dlp-wasm-dist';

async function wheelName() {
  try {
    return JSON.parse(await fs.readFile(new URL('wheel.json', DIST), 'utf8')).wheel;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('The yt-dlp wheel is missing. Run `pnpm build` in packages/yt-dlp-wasm.');
  }
}

const isInside = (dir, parent) => dir === parent || dir.startsWith(parent + path.sep);

// Only outputDir is mounted, so a file yt-dlp writes elsewhere would stay in Pyodide's memory
function assertInside(home, { outtmpl, paths = {} }) {
  const templates = typeof outtmpl === 'object' && outtmpl !== null ? Object.values(outtmpl) : [outtmpl];
  const targets = [...templates, ...Object.entries(paths).filter(([key]) => key !== 'home').map(([, value]) => value)];
  for (const target of targets) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) continue;
    // The fixed part of the template, up to the first field
    const fixed = path.dirname(target.split('%(')[0] + 'x');
    if (fixed !== home && !fixed.startsWith(home + path.sep)) {
      throw new TypeError(`${target} is outside outputDir (${home}); use a relative template or a path inside it`);
    }
  }
}

export async function createYtDlp(options = {}) {
  assertJspi();
  const { corsProxy, corsProxyKey, cookies, pyodideIndexURL, onLog, env = {} } = options;
  assertCookies(cookies);
  const { loadPyodide } = await import('pyodide');
  const py = await loadPyodide({
    ...(pyodideIndexURL && { indexURL: pyodideIndexURL }),
    ...(onLog && {
      stdout: (line) => onLog(line, 'stdout'),
      stderr: (line) => onLog(line, 'stderr'),
    }),
    env: {
      ...env,
      ...(corsProxy && { YTDLP_CORS_PROXY: corsProxy }),
      ...(corsProxyKey && { YTDLP_CORS_PROXY_KEY: corsProxyKey }),
    },
  });

  const wheel = await wheelName();
  py.FS.mkdirTree(WHEEL_MOUNT);
  py.mountNodeFS(WHEEL_MOUNT, fileURLToPath(DIST));
  const engine = await createEngine({ py, wheel: `emfs:${WHEEL_MOUNT}/${wheel}`, createHost, cookies });

  // Files written by Python land on the real filesystem through a mount at the same path
  const mounted = [];
  function mount(dir) {
    if (mounted.some((parent) => isInside(dir, parent))) return;
    py.FS.mkdirTree(dir);
    py.mountNodeFS(dir, dir);
    mounted.push(dir);
  }

  let closed = false;
  function call(request, onEvent) {
    if (closed) return Promise.reject(new Error('This yt-dlp instance is closed'));
    return engine.call(request, onEvent);
  }

  return {
    run(args) {
      const cwd = process.cwd();
      mount(cwd);
      return call({ op: 'run', argv: args, cwd });
    },
    extractInfo: (url, ytdlOptions = {}) => call({ op: 'extractInfo', url, options: ytdlOptions }),
    async download(url, ytdlOptions = {}, { onProgress, outputDir = process.cwd() } = {}) {
      const home = path.resolve(outputDir);
      assertInside(home, ytdlOptions);
      await fs.mkdir(home, { recursive: true });
      mount(home);
      const paths = await call({ op: 'download', url, options: ytdlOptions, home }, onProgress);
      return Promise.all(paths.map(async (file) => ({
        name: path.basename(file),
        path: file,
        size: (await fs.stat(file)).size,
        mimeType: mimeTypeOf(file),
      })));
    },
    async close() {
      closed = true;
      await engine.idle();
    },
    // Python cannot be interrupted in process. This stops accepting calls.
    terminate() {
      closed = true;
    },
  };
}
