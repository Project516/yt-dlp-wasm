// The `yt_dlp_host` module Python imports under Pyodide in a browser.
// Mirrors host-node.mjs. Pass `coreUrl` to load the core from somewhere else.
import { coreFactory, createFfmpegRunner } from './ffmpeg-bridge.mjs';

const CORE_VERSION = '0.13.1';
const CORE_URL = `https://cdn.jsdelivr.net/npm/@project516/ffmpeg-wasm-core@${CORE_VERSION}/dist/esm`;

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
  return { run_ffmpeg: createFfmpegRunner({ FS, createCore }) };
}
