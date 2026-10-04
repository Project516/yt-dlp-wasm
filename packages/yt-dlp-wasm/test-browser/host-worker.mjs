// Runs the browser host inside a module worker, as the library does
import { createHost } from '/src/host-browser.mjs';

self.onmessage = async ({ data }) => {
  self.postMessage(await createHost({ FS: null }).run_js(data));
};
