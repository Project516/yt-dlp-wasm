# @project516/yt-dlp-wasm

This package runs yt-dlp unmodified on [Pyodide](https://pyodide.org), in browsers and Node.js, behind a small JavaScript API.

```sh
pnpm add @project516/yt-dlp-wasm
```

In a browser, Pyodide runs in a module worker the library starts, so the page stays responsive.

```js
import { createYtDlp } from '@project516/yt-dlp-wasm';

const ytdlp = await createYtDlp({ corsProxy: 'https://your-proxy.workers.dev/' });
const info = await ytdlp.extractInfo('https://example.com/video');
const [file] = await ytdlp.download(info.webpage_url, { format: 'bestaudio' }, {
  onProgress: ({ status, downloadedBytes, totalBytes }) => console.log(status, downloadedBytes, totalBytes),
});
const url = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
ytdlp.close();
```

In Node.js, Pyodide runs in the same process and files are written to disk.

```js
import { createYtDlp } from '@project516/yt-dlp-wasm';

const ytdlp = await createYtDlp();
const [file] = await ytdlp.download('https://example.com/video', { format: 'bestaudio' }, { outputDir: './downloads' });
console.log(file.path);
await ytdlp.close();
```

`yt-dlp-wasm` is also a command that takes the arguments of `yt-dlp`.

### Options

`createYtDlp(options)` takes these, all optional:

- `corsProxy`, `corsProxyKey`: URL and access key of a CORS proxy.
- `pyodideIndexURL`: where Pyodide loads from. The default is jsDelivr in browsers and the installed `pyodide` package in Node.js.
- `ffmpegCoreURL`: where the ffmpeg.wasm core loads from in browsers. The default is jsDelivr.
- `wheelURL`: the yt-dlp wheel in browsers. The default is the package's `dist/` folder next to the module, so a bundler has to serve that folder or you pass this.
- `env`: environment variables for Python.
- `onLog(line, stream)`: receives each line yt-dlp writes to stdout or stderr.

The returned object has `run(args)`, which takes the arguments of `yt-dlp` and resolves with the exit code, `extractInfo(url, options)`, which resolves with the info dict, `download(url, options, { onProgress, outputDir })`, `close()` and `terminate()`. The `options` are the keys of yt-dlp's Python `YoutubeDL` options, as JSON. Calls on one instance run one at a time.

A browser `download` resolves with `{ name, data, mimeType }` for each file, with `data` a `Uint8Array` moved out of the worker without a copy, and frees the file from memory. A Node.js `download` resolves with `{ name, path, size, mimeType }`. Progress events carry `status`, `downloadedBytes`, `totalBytes`, `speed` and `eta`, and postprocessor events carry `postprocessor` and `status`. Types are in `src/index.d.ts`.

### JSPI and the CORS proxy

yt-dlp makes blocking network and ffmpeg calls. Pyodide waits on them with JavaScript Promise Integration (JSPI), so the runtime must have it: Chrome 137, Firefox 153, Safari 27 or Node.js 25. Without JSPI, `createYtDlp` rejects and names those versions.

A browser blocks a request to another origin unless that origin allows it, and most sites do not. Set `corsProxy` to your own deployment of [`packages/cors-proxy`](https://github.com/Project516/yt-dlp-wasm/tree/master/packages/cors-proxy), a Cloudflare Worker that fetches pages for the browser. Node.js sends requests directly and needs no proxy.
