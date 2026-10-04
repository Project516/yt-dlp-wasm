// Runs the library's Python API on a Pyodide instance. Shared by the Node.js
// entry and the browser worker.
import { installDependencies } from './dependencies.mjs';
import { YtDlpError } from './errors.mjs';
import { PYTHON_API } from './python-api.mjs';

// `wheel` is a URL micropip can install: http(s) in browsers, emfs: in Node.js.
// `createHost` builds the `yt_dlp_host` module for the platform.
export async function createEngine({ py, wheel, createHost }) {
  await installDependencies(py);
  await py.pyimport('micropip').install(wheel);

  let sink = () => {};
  py.registerJsModule('yt_dlp_host', createHost({ FS: py.FS }));
  py.registerJsModule('yt_dlp_wasm_events', { emit: (json) => sink(JSON.parse(json)) });
  py.globals.set('_api_source', PYTHON_API);
  await py.runPythonAsync(`
import sys, types
module = types.ModuleType('yt_dlp_wasm_api')
exec(_api_source, module.__dict__)
sys.modules['yt_dlp_wasm_api'] = module
import yt_dlp_wasm_api
`);

  // Python can run only one entry at a time while it waits on JS
  let queue = Promise.resolve();
  function call(request, onEvent = () => {}) {
    const result = queue.then(async () => {
      sink = onEvent;
      try {
        py.globals.set('_api_request', JSON.stringify(request));
        const reply = JSON.parse(await py.runPythonAsync('yt_dlp_wasm_api.call(_api_request)'));
        if (reply.error) throw new YtDlpError(reply.error.message, reply.error);
        return reply.result;
      } finally {
        sink = () => {};
      }
    });
    queue = result.catch(() => {});
    return result;
  }

  return { FS: py.FS, call, idle: () => queue };
}
