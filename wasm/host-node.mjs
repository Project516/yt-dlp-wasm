// The `yt_dlp_host` module Python imports under Pyodide in Node.js.
// Each capability here needs a matching browser implementation in host-browser.mjs.
import fs from 'node:fs/promises';
import { coreFactory, createFfmpegRunner } from './ffmpeg-bridge.mjs';

// `FS` is Pyodide's filesystem.
export function createHost({ FS }) {
  let factory;
  const createCore = async (options) => {
    factory ??= (async () => {
      const { default: createFFmpegCore } = await import('@project516/ffmpeg-wasm-core');
      const wasm = await fs.readFile(new URL(import.meta.resolve('@project516/ffmpeg-wasm-core/wasm')));
      return coreFactory(createFFmpegCore, await WebAssembly.compile(wasm));
    })();
    return (await factory)(options);
  };
  return { run_ffmpeg: createFfmpegRunner({ FS, createCore }) };
}
