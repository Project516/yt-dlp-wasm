# yt-dlp-wasm

A fork of [yt-dlp](https://github.com/yt-dlp/yt-dlp) that runs in WebAssembly,
in the browser and in Node.js, with no server of its own. The Python code runs
unmodified on [Pyodide](https://pyodide.org). The wasm-specific pieces are a
fetch-based request handler, an ffmpeg bridge to
[ffmpeg.wasm](https://github.com/Project516/ffmpeg.wasm), and a JS challenge
provider that uses the host JS engine.

## Direction

- Behave like upstream yt-dlp. Extraction, format selection, output templates,
  downloading, and postprocessing work the same. A difference is acceptable
  only where the platform cannot do the thing, such as raw sockets, threads,
  subprocesses, or browser-forbidden headers.
- Stay close to upstream so syncs stay cheap. Add new files instead of editing
  upstream ones. When an upstream file has to change, keep the edit small and
  gate it on `sys.platform == 'emscripten'`.
- Run on low-end devices. Avoid copying downloaded media more often than needed
  and keep memory use bounded.

## Tests

Two suites must pass on every PR:

- Upstream's own workflows (`Core Tests`, `Quick Test`, and the rest) on native
  CPython. The fork must not break regular yt-dlp.
- `Wasm Tests`, the same core suite run inside Pyodide by `wasm/run-tests.mjs`.

A test may change for wasm only when it hits a platform limit, for example a
test server started on a thread. Adapt it so it still checks the same behavior
where possible. Otherwise skip it on emscripten with a reason that names the
limit. Never skip a test because a feature is unfinished.

Test HTTP servers cannot run in Pyodide, which has no sockets or threads.
`start_http_server` in `test/helper.py` runs them in the sidecar instead. The
`wasm/test-host.mjs` module starts it with `python3`, or with the interpreter in
`YTDLP_TEST_PYTHON`. That interpreter needs the packages in
`bundle/requirements/test.txt` and `default.txt`.

Heavy builds and full test runs go to GitHub Actions. On the Raspberry Pi,
run single test files only, wrapped in the memguard script.

## Git

- `origin` is Project516/yt-dlp-wasm. `upstream` is yt-dlp/yt-dlp, fetch only.
  Never open a PR or push against upstream.
- Feature PRs target `master` and squash merge.
- Upstream syncs merge `upstream/master` into a branch, and that PR lands with a
  merge commit, not a squash. A squash would make every later sync conflict.
- project516-review-bot reviews every push. Its CHANGES_REQUESTED blocks
  merging. If it fails to review a head, a Sonnet subagent reviews instead.

## Glossary

- **Pyodide**: CPython compiled to wasm with Emscripten. `sys.platform` is
  `emscripten` there.
- **JSPI**: JavaScript Promise Integration. It lets synchronous Python wait on
  a JS promise through `pyodide.ffi.run_sync`. Python must be entered through
  `runPythonAsync` for this to work.
- **Fetch handler**: the `FetchRH` request handler, which sends HTTP requests
  with the host's `fetch`.
- **ffmpeg bridge**: the code that runs `ffmpeg` and `ffprobe` commands on
  ffmpeg.wasm instead of a subprocess.
- **Host**: the JS environment Pyodide runs in, a browser worker or Node.js.
- **Sidecar**: the CPython process that serves the test suite's HTTP servers
  while the tests run in Pyodide.
