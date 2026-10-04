# yt-dlp-wasm

yt-dlp-wasm runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) in the browser and in Node.js through WebAssembly. It has no server of its own. The download logic runs on the user's device, so a web page or a Node.js program can fetch video without a backend that proxies requests or hosts yt-dlp.

It is a fork of yt-dlp. The extractors, format selection, output templates, and options are upstream's code.

## Status

Early. The core test suite runs under Pyodide in Node.js. The request handler and the ffmpeg bridge are in progress. A Node.js command line tool and a browser page are planned and do not exist yet. There is no package to install.

## How it works

[Pyodide](https://pyodide.org) is CPython compiled to WebAssembly. It runs the unmodified yt-dlp Python code in a browser worker or in Node.js. Code that depends on something the platform lacks is replaced by a wasm-specific piece:

- **Fetch request handler** (in progress). Sends yt-dlp's HTTP requests with the host's `fetch`, since Pyodide has no raw sockets.
- **ffmpeg bridge** (in progress). Runs the `ffmpeg` and `ffprobe` commands that yt-dlp issues on [ffmpeg.wasm](https://github.com/Project516/ffmpeg.wasm), a fork maintained alongside this project, instead of starting a subprocess.
- **YouTube JS challenge provider.** Runs the [EJS solver](https://github.com/yt-dlp/ejs) that YouTube needs on the host's own JavaScript engine.

The wasm code lives in new files and in small changes to upstream files that apply only when `sys.platform == 'emscripten'`. That keeps merges from upstream cheap.

## Differences from yt-dlp

Where the platform cannot do what yt-dlp does, yt-dlp-wasm behaves differently:

- In the browser, requests are subject to CORS. The browser also forbids setting the `Cookie`, `User-Agent`, `Referer`, and `Origin` headers. Many sites therefore need a CORS proxy or a browser extension context. Node.js has no such limits.
- There is no impersonation, because `curl_cffi` is not available.
- There is no proxy support and no client certificate support.
- There are no threads, so fragments that yt-dlp downloads concurrently are downloaded one at a time.
- In the browser, downloads live in memory.
- Cookies cannot be read from locally installed browsers in the browser, so `--cookies-from-browser` does not work there.

## Options

The options are the same as yt-dlp's. For the full reference see the [upstream README](https://github.com/yt-dlp/yt-dlp#usage-and-options). Options that depend on a feature listed above, such as `--proxy` or `--impersonate`, do not work here.

## Running the tests under Pyodide

The test harness runs yt-dlp's own test suite inside Pyodide. It needs Node.js 25 or later, for JSPI (JavaScript Promise Integration), which lets synchronous Python code wait on a JavaScript promise.

```shell
cd wasm
pnpm install
node run-tests.mjs core
```

Run a single file or pass pytest arguments:

```shell
node run-tests.mjs test/test_utils.py --pytest-args='-x'
```

The same suite also runs on native CPython with `python -m devscripts.run_tests core`. Both must pass. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Relationship to upstream

This fork tracks `yt-dlp/yt-dlp` master and merges it regularly. Bugs that also happen with regular yt-dlp, such as a broken site or a missing extractor, belong in the [upstream issue tracker](https://github.com/yt-dlp/yt-dlp/issues/new/choose). Bugs that only happen under WebAssembly belong in the [issues of this repository](https://github.com/Project516/yt-dlp-wasm/issues).

Upstream's release builds, installation methods, and update channels do not apply to this fork. Upstream's [Changelog](Changelog.md) is kept as history.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The maintainer is listed in [Maintainers.md](Maintainers.md).

## License

The fork's own changes and additions are licensed under [AGPL-3.0-or-later](LICENSE). Code that comes from yt-dlp keeps upstream's [Unlicense](LICENSE.upstream). The Unlicense is compatible with the AGPL, so the combined work is distributed under the AGPL.

Releases of upstream yt-dlp bundle third-party code under other licenses. See [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

## Credits

yt-dlp-wasm is built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), itself a fork of [youtube-dl](https://github.com/ytdl-org/youtube-dl). Thanks to the people credited in [CONTRIBUTORS](CONTRIBUTORS) for the code it runs.
