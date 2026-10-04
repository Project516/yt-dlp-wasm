// The `yt_dlp_host` module Python imports under Pyodide in a browser.
// Mirrors host-node.mjs.
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

export function createHost() {
  return { run_js: runJs };
}
