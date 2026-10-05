// The browser worker. Pyodide runs here so the page stays responsive.
// browser.mjs starts it and talks to it over postMessage.
import { createEngine } from './engine.mjs';
import { createHost } from './host-browser.mjs';
import { mimeTypeOf } from './mime.mjs';
import { PYODIDE_VERSION } from './versions.mjs';

const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const DEFAULT_CWD = '/home/pyodide';

let engine;
let nextDir = 0;

async function init({ corsProxy, corsProxyKey, cookies, pyodideIndexURL = PYODIDE_INDEX_URL, ffmpegCoreURL, wheelURL, env = {} }) {
  const indexURL = pyodideIndexURL.endsWith('/') ? pyodideIndexURL : `${pyodideIndexURL}/`;
  const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
  const py = await loadPyodide({
    indexURL,
    stdout: (line) => postMessage({ type: 'log', line, stream: 'stdout' }),
    stderr: (line) => postMessage({ type: 'log', line, stream: 'stderr' }),
    env: {
      ...env,
      ...(corsProxy && { YTDLP_CORS_PROXY: corsProxy }),
      ...(corsProxyKey && { YTDLP_CORS_PROXY_KEY: corsProxyKey }),
    },
  });
  const wheel = wheelURL ?? await defaultWheelURL();
  engine = await createEngine({
    py,
    wheel,
    createHost: ({ FS }) => createHost({ FS, coreUrl: ffmpegCoreURL }),
    cookies,
  });
}

async function defaultWheelURL() {
  const manifest = new URL('../dist/wheel.json', import.meta.url);
  const response = await fetch(manifest);
  if (!response.ok) throw new Error(`Could not load ${manifest} (${response.status}). Serve the package's dist/ folder or pass wheelURL.`);
  return new URL((await response.json()).wheel, manifest).href;
}

function listFiles(FS, dir) {
  return FS.readdir(dir).filter((name) => name !== '.' && name !== '..').flatMap((name) => {
    const file = `${dir}/${name}`;
    return FS.isDir(FS.stat(file).mode) ? listFiles(FS, file) : [file];
  });
}

function removeTree(FS, dir) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const child = `${dir}/${name}`;
    if (FS.isDir(FS.stat(child).mode)) removeTree(FS, child);
    else FS.unlink(child);
  }
  FS.rmdir(dir);
}

// MEMFS keeps file contents in a plain array, so they can move to the page without a copy
function contentsOf(FS, file) {
  const { contents, usedBytes } = FS.lookupPath(file, { follow: true }).node;
  return contents instanceof Uint8Array ? contents.subarray(0, usedBytes) : FS.readFile(file);
}

async function download({ id, url, options }) {
  const { FS } = engine;
  const home = `/tmp/yt-dlp-${nextDir++}`;
  FS.mkdirTree(home);
  let files;
  try {
    await engine.call({ op: 'download', url, options, home }, (event) => postMessage({ type: 'progress', id, event }));
    files = listFiles(FS, home).map((file) => {
      const name = file.slice(home.length + 1);
      return { name, data: contentsOf(FS, file), mimeType: mimeTypeOf(name) };
    });
  } finally {
    removeTree(FS, home);
  }
  try {
    postMessage({ type: 'result', id, result: files }, files.map(({ data }) => data.buffer));
  } catch {
    // The buffers cannot move, for example if two files share one
    reply(id, files.map((file) => ({ ...file, data: file.data.slice() })));
  }
}

const reply = (id, result) => postMessage({ type: 'result', id, result });

const fail = (id, error) => postMessage({
  type: 'error',
  id,
  error: { message: String(error?.message ?? error), type: error?.type ?? error?.name, traceback: error?.traceback },
});

const handlers = {
  async init({ id, options }) {
    await init(options);
    reply(id, null);
  },
  async run({ id, args }) {
    reply(id, await engine.call({ op: 'run', argv: args, cwd: DEFAULT_CWD }));
  },
  async extractInfo({ id, url, options }) {
    reply(id, await engine.call({ op: 'extractInfo', url, options }));
  },
  download,
};

self.onmessage = async ({ data }) => {
  try {
    await handlers[data.method](data);
  } catch (error) {
    fail(data.id, error);
  }
};
