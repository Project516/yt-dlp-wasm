# Contributing to yt-dlp-wasm

## Where an issue goes

Open an issue here if the problem comes from running in WebAssembly: the fetch request handler, the ffmpeg bridge, the YouTube JS challenge provider, or anything that works with regular yt-dlp on a desktop and fails under Pyodide.

Report to [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp/issues/new/choose) if the same URL and options fail with regular yt-dlp. That covers broken sites, extractor bugs, new site requests, and bugs in options. This fork runs upstream's code unmodified, so a fix there reaches this fork on the next sync.

If you are not sure, run the same command with regular yt-dlp first.

## Opening an issue

Use one of the templates and fill in every required field. For a bug, include:

- the host (browser and version, or Node.js version)
- the URL and options
- the complete output of the run with `-v`

Keep to one problem per issue.

This fork follows upstream's policy on piracy. It does not support sites that mainly serve copyright-infringing content or only DRM-protected content. See [the upstream policy](https://github.com/yt-dlp/yt-dlp/blob/master/CONTRIBUTING.md#is-the-website-primarily-used-for-piracy).

## Pull requests

Open pull requests against `master` of [Project516/yt-dlp-wasm](https://github.com/Project516/yt-dlp-wasm). They are squash merged.

- Behave like upstream yt-dlp. A difference is acceptable only where the platform cannot do the thing, such as raw sockets, threads, subprocesses, or browser-forbidden headers.
- Add new files instead of editing upstream ones. When an upstream file has to change, keep the edit small and gate it on `sys.platform == 'emscripten'`.
- Keep memory use bounded and avoid copying downloaded media more than needed.
- Send extractor fixes and new extractors to upstream, not here.
- Your changes are released under AGPL-3.0-or-later. See [LICENSE](LICENSE).

## Tests

Two suites must pass:

```shell
# Upstream's tests on native CPython
python -m devscripts.run_tests core

# The same core tests inside Pyodide, with Node.js 25 or later
pnpm install && node packages/yt-dlp-wasm/test-harness/run-tests.mjs core
```

Change a test for wasm only when it hits a platform limit, for example a test server that starts a thread. Adapt it to check the same behavior where possible. Otherwise skip it on emscripten with a reason that names the limit. Do not skip a test because a feature is unfinished.

## Code style

Code style, hatch setup, and the linter settings are the same as upstream. See [upstream's developer instructions](https://github.com/yt-dlp/yt-dlp/blob/master/CONTRIBUTING.md#developer-instructions).
