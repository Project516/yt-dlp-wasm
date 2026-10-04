// The `yt_dlp_host` module Python imports under Pyodide in a browser.
// Mirrors host-node.mjs. Pass `coreUrl` to load the ffmpeg core from somewhere else.
import { coreFactory, createFfmpegRunner } from './ffmpeg-bridge.mjs';

const CORE_VERSION = '0.13.1';
const CORE_URL = `https://cdn.jsdelivr.net/npm/@project516/ffmpeg-wasm-core@${CORE_VERSION}/dist/esm`;
const JS_TIMEOUT_MS = 120_000;

// Captures console.log as stdout and cuts off network access.
const PRELUDE = `
const __stdout = [];
console.log = (...args) => __stdout.push(args.join(' '));
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
  self[name] = undefined;
}
`;
const EPILOGUE = `
;postMessage(__stdout.map((line) => line + '\\n').join(''));
`;

// Runs the script in a throwaway Worker and resolves with what it logged.
function runJs(script) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([PRELUDE, script, EPILOGUE], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const finish = (settle, value) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      settle(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`JS worker timed out after ${JS_TIMEOUT_MS} ms`)), JS_TIMEOUT_MS);
    worker.onmessage = (event) => finish(resolve, event.data);
    worker.onerror = (event) => finish(reject, new Error(`JS worker failed: ${event.message}`));
  });
}

// `FS` is Pyodide's filesystem.
export function createHost({ FS, coreUrl = CORE_URL }) {
  let factory;
  const createCore = async (options) => {
    factory ??= (async () => {
      const [{ default: createFFmpegCore }, module] = await Promise.all([
        import(`${coreUrl}/ffmpeg-core.js`),
        WebAssembly.compileStreaming(fetch(`${coreUrl}/ffmpeg-core.wasm`)),
      ]);
      return coreFactory(createFFmpegCore, module);
    })();
    return (await factory)(options);
  };
  return { run_js: runJs, run_ffmpeg: createFfmpegRunner({ FS, createCore }) };
}
