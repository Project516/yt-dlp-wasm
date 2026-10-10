// The browser entry. Pyodide runs in a module worker, and this side proxies to it.
import { assertCookies } from './cookies.mjs';
import { YtDlpError } from './errors.mjs';
import { assertJspi } from './jspi.mjs';

export { YtDlpError };

// Relative URLs would resolve against the worker's location, not the page's
const absolute = (url) => (url === undefined ? undefined : new URL(url, globalThis.location?.href).href);

export async function createYtDlp(options = {}) {
  assertJspi();
  const { onLog, pyodideIndexURL, ffmpegCoreURL, wheelURL, ...rest } = options;
  assertCookies(rest.cookies);
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map();
  let nextId = 0;
  let closed = false;

  function rejectAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  worker.onmessage = ({ data }) => {
    if (data.type === 'log') return onLog?.(data.line, data.stream);
    const call = pending.get(data.id);
    if (!call) return;
    if (data.type === 'progress') return call.onProgress?.(data.event);
    pending.delete(data.id);
    if (data.type === 'error') call.reject(new YtDlpError(data.error.message, data.error));
    else call.resolve(data.result);
  };
  worker.onerror = (event) => terminate(new Error(`The yt-dlp worker failed: ${event.message || 'could not start'}`));

  function request(method, params = {}, onProgress) {
    if (closed) return Promise.reject(new Error('This yt-dlp instance is closed'));
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress, promise: undefined });
      worker.postMessage({ method, id, ...params });
    });
    pending.get(id).promise = promise;
    return promise;
  }

  function terminate(error = new Error('This yt-dlp instance was terminated')) {
    closed = true;
    worker.terminate();
    rejectAll(error);
  }

  try {
    await request('init', {
      options: {
        ...rest,
        pyodideIndexURL: absolute(pyodideIndexURL),
        ffmpegCoreURL: absolute(ffmpegCoreURL),
        wheelURL: absolute(wheelURL),
      },
    });
  } catch (error) {
    terminate();
    throw error;
  }

  return {
    run: (args) => request('run', { args }),
    extractInfo: (url, ytdlOptions = {}) => request('extractInfo', { url, options: ytdlOptions }),
    download: (url, ytdlOptions = {}, { onProgress } = {}) => request('download', { url, options: ytdlOptions }, onProgress),
    async close() {
      closed = true;
      await Promise.allSettled([...pending.values()].map(({ promise }) => promise));
      terminate();
    },
    terminate: () => terminate(),
  };
}
