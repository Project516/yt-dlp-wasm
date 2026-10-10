# yt-dlp-wasm

yt-dlp-wasm runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) in the browser and in Node.js through WebAssembly. It has no server of its own. The download logic runs on the user's device, so a web page or a Node.js program can fetch video without a backend that hosts yt-dlp.

It is a fork of yt-dlp. The extractors, format selection, output templates, and options are upstream's code.

## How it works

[Pyodide](https://pyodide.org) is CPython compiled to WebAssembly. It runs the unmodified yt-dlp Python code in a browser worker or in Node.js. Code that depends on something the platform lacks is replaced by a wasm-specific piece:

- **Fetch request handler.** Sends yt-dlp's HTTP requests with the host's `fetch`, since Pyodide has no raw sockets.
- **ffmpeg bridge.** Runs the `ffmpeg` and `ffprobe` commands that yt-dlp issues on [ffmpeg.wasm](https://github.com/Project516/ffmpeg.wasm), a fork maintained alongside this project, instead of starting a subprocess.
- **YouTube JS challenge provider.** Runs the [EJS solver](https://github.com/yt-dlp/ejs) that YouTube needs on the host's own JavaScript engine.
- **CORS proxy.** A small proxy in [`packages/cors-proxy`](packages/cors-proxy) that relays requests for browsers. It runs as a Cloudflare Worker or on a Linux machine at home. It also carries the headers browsers refuse to set, so cookies and redirects work as they do in Node.js.

The wasm code lives in new files and in small changes to upstream files that apply only when `sys.platform == 'emscripten'`. That keeps merges from upstream cheap.

## Try it in your browser

The demo at <https://yt-dlp-wasm.project516.dev> runs yt-dlp in your browser and saves a video or its audio as a file. It needs a browser with JSPI (see below) and sends its requests through a rate limited proxy meant for personal use. The demo may not work from cloud servers, some VPNs, or automated browsers, because the proxy's domain challenges that traffic. If a site asks you to sign in, you can load a cookies.txt file in the demo's Cookies settings. Whoever runs the proxy can see the cookies, so load them only if you trust it. The file stays in memory until you close the page. Its source is in [`apps/demo`](apps/demo).

## Use it as a library

[`@project516/yt-dlp-wasm`](https://www.npmjs.com/package/@project516/yt-dlp-wasm) on npm wraps yt-dlp on Pyodide in a small JavaScript API for browsers and Node.js.

```sh
pnpm add @project516/yt-dlp-wasm
```

In a browser, Pyodide runs in a module worker the library starts, so the page stays responsive.

```js
import { createYtDlp } from '@project516/yt-dlp-wasm';

const ytdlp = await createYtDlp({ corsProxy: 'https://your-proxy.example/' });
const info = await ytdlp.extractInfo('https://example.com/video');
const [file] = await ytdlp.download(info, { format: 'bestaudio' }, {
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

The package also installs a `yt-dlp-wasm` command that takes the arguments of `yt-dlp`.

### Options

`createYtDlp(options)` takes these, all optional:

- `corsProxy`, `corsProxyKey`: URL and access key of a CORS proxy.
- `cookies`: the text of a Netscape `cookies.txt` file. `extractInfo` and `download` use it as `cookiefile` unless their options set one. `run` adds `--cookies` unless the arguments have `--cookies` or `--no-cookies`. The file stays in Pyodide's memory and is never written to disk. In a browser the cookies go through your CORS proxy, and whoever runs it can see them, so use cookies only with a proxy you trust.
- `pyodideIndexURL`: where Pyodide loads from. The default is jsDelivr in browsers and the installed `pyodide` package in Node.js.
- `ffmpegCoreURL`: where the ffmpeg.wasm core loads from in browsers. The default is jsDelivr.
- `wheelURL`: the yt-dlp wheel in browsers. The default is the package's `dist/` folder next to the module, so a bundler has to serve that folder or you pass this.
- `env`: environment variables for Python.
- `onLog(line, stream)`: receives each line yt-dlp writes to stdout or stderr.

The returned object has these methods:

- `run(args)` takes the arguments of `yt-dlp` and resolves with the exit code.
- `extractInfo(url, options)` resolves with the info dict.
- `download(urlOrInfo, options, { onProgress, outputDir })` downloads. Pass the info dict from `extractInfo` so the page is not extracted twice.
- `close()` waits for running calls, and `terminate()` stops at once.

The `options` are the keys of yt-dlp's Python `YoutubeDL` options, as JSON. Calls on one instance run one at a time.

A browser `download` resolves with `{ name, data, mimeType }` for each file, with `data` a `Uint8Array` moved out of the worker without a copy, and frees the file from memory. A Node.js `download` resolves with `{ name, path, size, mimeType }`. Types are in [`src/index.d.ts`](packages/yt-dlp-wasm/src/index.d.ts).

### JSPI and the CORS proxy

yt-dlp makes blocking network and ffmpeg calls. Pyodide waits on them with JavaScript Promise Integration (JSPI), so the runtime must have it: Chrome 137, Firefox 153, Safari 27 or Node.js 25. Without JSPI, `createYtDlp` rejects and names those versions.

A browser blocks a request to another origin unless that origin allows it, and most sites do not. Set `corsProxy` to your own deployment of [`packages/cors-proxy`](packages/cors-proxy). Its README shows how to run one on Cloudflare's free plan, or on an always-on Linux machine at home with about 512 MB of RAM. YouTube often refuses requests from Cloudflare Workers, because they share datacenter IP addresses, so use a proxy at home for YouTube. Node.js sends requests directly and needs no proxy.

## Differences from yt-dlp

Where the platform cannot do what yt-dlp does, yt-dlp-wasm behaves differently:

- In the browser, requests go through the CORS proxy, so sites see the proxy's IP address. Some sites challenge datacenter addresses.
- There is no impersonation, because `curl_cffi` is not available.
- There is no proxy support, no client certificate support, and no websocket support.
- There are no threads, so fragments that yt-dlp downloads concurrently are downloaded one at a time.
- ffmpeg can't open network inputs, so the ffmpeg downloader is unavailable. yt-dlp's own HLS and DASH downloaders are used instead.
- In the browser, downloads live in memory, and `--cookies-from-browser` can't read the browser's cookies.

## Options

The options are the same as yt-dlp's. For the full reference see the [upstream README](https://github.com/yt-dlp/yt-dlp#usage-and-options). Options that depend on a feature listed above, such as `--proxy` or `--impersonate`, do not work here.

## Development

This is a pnpm monorepo. The Python package stays at the root as in upstream. The JavaScript lives in `packages/yt-dlp-wasm` (the library, CLI and Pyodide test harness), `packages/cors-proxy`, and the demo site in `apps/demo`.

```shell
pnpm install
pnpm --filter @project516/yt-dlp-wasm build
pnpm --filter @project516/yt-dlp-wasm test
```

The test harness runs yt-dlp's own test suite inside Pyodide. It needs Node.js 25 or later.

```shell
cd packages/yt-dlp-wasm
node test-harness/run-tests.mjs core
node test-harness/run-tests.mjs test/test_utils.py --pytest-args='-x'
```

The same suite also runs on native CPython with `python -m devscripts.run_tests core`. Both must pass. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Relationship to upstream

This fork tracks the stable releases of `yt-dlp/yt-dlp`. A daily workflow merges each new release tag and publishes a new minor version of the npm package, and the release notes name the yt-dlp version it is based on. Bugs that also happen with regular yt-dlp, such as a broken site or a missing extractor, belong in the [upstream issue tracker](https://github.com/yt-dlp/yt-dlp/issues/new/choose). Bugs that only happen under WebAssembly belong in the [issues of this repository](https://github.com/Project516/yt-dlp-wasm/issues).

Upstream's release builds, installation methods, and update channels do not apply to this fork. Upstream's [Changelog](Changelog.md) is kept as history.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The maintainer is listed in [Maintainers.md](Maintainers.md).

## License

The fork's own changes and additions are licensed under [AGPL-3.0-or-later](LICENSE). Code that comes from yt-dlp keeps upstream's [Unlicense](LICENSE.upstream). The Unlicense is compatible with the AGPL, so the combined work is distributed under the AGPL.

Releases of upstream yt-dlp bundle third-party code under other licenses. See [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

## Credits

yt-dlp-wasm is built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), itself a fork of [youtube-dl](https://github.com/ytdl-org/youtube-dl). Thanks to the people credited in [CONTRIBUTORS](CONTRIBUTORS) for the code it runs.
