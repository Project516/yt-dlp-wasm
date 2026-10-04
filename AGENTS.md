# yt-dlp-wasm

A fork of [yt-dlp](https://github.com/yt-dlp/yt-dlp) that runs in WebAssembly,
in the browser and in Node.js, with no server of its own. The Python code runs
unmodified on [Pyodide](https://pyodide.org). The wasm-specific pieces are a
fetch-based request handler, an ffmpeg bridge to
[ffmpeg.wasm](https://github.com/Project516/ffmpeg.wasm), and a JS challenge
provider that uses the host JS engine.

## Layout

A pnpm monorepo. The Python stays at the root so upstream syncs stay cheap.

- `yt_dlp/`, `test/`, `devscripts/`, `pyproject.toml`: upstream's Python.
- `packages/yt-dlp-wasm`: the library `@project516/yt-dlp-wasm`. `src/` is the
  library, `bin/` the CLI, `scripts/build-wheel.mjs` builds the wheel into
  `dist/`, `test/` has the Node.js tests, `test-browser/` the Playwright tests
  and `test-harness/` runs the Python suite in Pyodide.
- `packages/cors-proxy`: the CORS proxy Worker.
- `apps/`: sites built on the library, such as the demo.

Install once at the root with `pnpm install`. One lockfile covers every package.

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

Three suites must pass on every PR:

- Upstream's own workflows (`Core Tests`, `Quick Test`, and the rest) on native
  CPython. The fork must not break regular yt-dlp.
- `Wasm Tests`, the same core suite run inside Pyodide by `packages/yt-dlp-wasm/test-harness/run-tests.mjs`.
- The library tests in `packages/yt-dlp-wasm`. `pnpm test` runs the Node.js ones
  with `node:test`. `pnpm test:browser` runs Playwright on headless Chromium,
  and only CI runs it.

A test may change for wasm only when it hits a platform limit, for example a
test server started on a thread. Adapt it so it still checks the same behavior
where possible. Otherwise skip it on emscripten with a reason that names the
limit. Never skip a test because a feature is unfinished.

Test HTTP servers cannot run in Pyodide, which has no sockets or threads.
`start_http_server` in `test/helper.py` runs them in the sidecar instead. The
`test-harness/test-host.mjs` module starts it with `python3`, or with the interpreter in
`YTDLP_TEST_PYTHON`. That interpreter needs the packages in
`bundle/requirements/test.txt` and `default.txt`.

Build the wheel with `pnpm build` in `packages/yt-dlp-wasm` before running the
library tests or the CLI.

Heavy builds and full test runs go to GitHub Actions. On the Raspberry Pi,
run single test files only, wrapped in the memguard script.

## Git

- `origin` is Project516/yt-dlp-wasm. `upstream` is yt-dlp/yt-dlp, fetch only.
  Never open a PR or push against upstream.
- Feature PRs target `master` and squash merge.
- Upstream syncs land with a merge commit, not a squash. A squash would make
  every later sync conflict. See Sync and release.
- master has the ruleset `master-merge-gate`. A PR needs one approval, and a
  push dismisses approvals. These checks must pass: Check workflows, Run
  zizmor, Core test, Code check, Core tests (Pyodide), Library tests (Node.js)
  and Library tests (Chromium). Admins can bypass it for PRs only, so nothing
  can be pushed to master directly. When a required check is renamed, update
  the ruleset.

## Sync and release

The fork tracks yt-dlp stable releases, not upstream master. Nobody has to act
for a normal release.

1. `upstream-sync.yml` runs daily at 09:17 UTC (03:17 CST, 04:17 CDT) and on
   demand. It reads the latest release tag of yt-dlp/yt-dlp. If master has it,
   the run ends.
2. Otherwise it merges the tag with `git merge --no-ff` on the branch
   `sync/yt-dlp-<tag>` and opens a PR. If a PR for that tag is open already, it
   does nothing. A new sync PR closes older open sync PRs.
3. On a conflict, fork-owned files keep ours: README.md, CONTRIBUTING.md,
   Maintainers.md, LICENSE, LICENSE.upstream, CONTRIBUTORS, the issue
   templates and the PR template. pyproject.toml takes upstream's side of the
   conflict, and `.github/sync/fork-pyproject.py` applies the fork's license,
   sdist and `[project.urls]` edits again. Any other conflict pushes nothing.
   The run opens or updates the issue "Upstream yt-dlp <tag> needs a manual
   merge", lists the files, and fails.
4. `.github/sync/arm-automerge.sh` arms auto-merge with the merge method, but
   only when the master ruleset requires an approving review and status checks.
   GitHub merges the PR when the checks pass and project516-review-bot approves
   the head commit. No person is involved.
5. `sync-release.yml` runs when a `sync/yt-dlp-*` PR merges. It tags the merge
   commit `js-vX.Y.Z`, the next minor version after the highest `js-v*` tag. If
   there is none yet, it starts from the version in `package.json`. The tag
   starts `release-js.yml`, which sets the package version from the tag, runs
   the tests, publishes to npm, and creates a GitHub release that says "Based on
   yt-dlp <version>". The version in `packages/yt-dlp-wasm/package.json` is not
   bumped in the repo. The tag is the version.
6. The merge also pushes to master, so `pages.yml` deploys the demo.

For a wasm-only change, release by hand from master with a tag push. Use the
next patch version:

```sh
git fetch origin && git push origin origin/master:refs/tags/js-vX.Y.Z
```

`SYNC_TOKEN` is a fine-grained PAT with Contents, Pull requests and Workflows
write on this repo. The built-in token cannot push workflow file changes, and
pushes, PRs and tags it creates start no workflows. Check the token with
`gh workflow run upstream-sync.yml -f check_token=true`. The run pushes a
temporary branch, opens and closes a draft PR, deletes the branch, and
reports each permission in the job summary.

The library installs the Python dependencies in `src/pins.json`.
`scripts/update-pins.mjs` writes it from `bundle/requirements/default.txt`, and
both `pnpm build` and the sync run it. A dependency that upstream adds fails
`test/pins.test.mjs` until it is classified in that script.

## Review

project516-review-bot is the review gate. A green CI run is not enough, because
the bot must approve the head commit before it can merge. It runs free models
and can be wrong. When a finding is wrong, answer the thread with evidence, such
as a command output or a link to the code, and push back. When the bot only
comments and does not approve, and you have shown every finding false, an admin
can merge with `gh pr merge <n> --admin`. If the bot fails to review a head, a
Sonnet subagent reviews instead.

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
- **CORS proxy**: a Cloudflare Worker in `packages/cors-proxy` that fetches
  URLs for browsers. When the `YTDLP_CORS_PROXY` environment variable is set to
  its URL, the fetch handler sends every request through it, and
  `YTDLP_CORS_PROXY_KEY` sets the access key. The proxy returns the real status,
  headers and cookies in `X-Ytdlp-*` headers, and the handler follows redirects
  itself.
- **Library**: `@project516/yt-dlp-wasm`. Its `createYtDlp(options)` returns an
  object with `run`, `extractInfo`, `download`, `close` and `terminate`. It
  uses `src/node.mjs` in Node.js and `src/browser.mjs` in browsers.
- **Wheel**: the pure-Python wheel of `yt_dlp/` that `scripts/build-wheel.mjs`
  builds into `dist/`. The library installs it into Pyodide with micropip.
- **Engine**: `src/engine.mjs`, which installs the wheel and runs the Python
  half of the API (`src/python-api.mjs`) for both entries.
- **Worker**: the module Web Worker (`src/worker.mjs`) that holds Pyodide in
  browsers. `src/browser.mjs` proxies calls to it with postMessage.
- **CLI**: `packages/yt-dlp-wasm/bin/cli.mjs`, which runs yt-dlp through the
  library in Node.js with the arguments of the real `yt-dlp`.
- **Host**: the JS environment Pyodide runs in, a browser worker or Node.js.
- **Sidecar**: the CPython process that serves the test suite's HTTP servers
  while the tests run in Pyodide.
- **Sync PR**: the PR from `sync/yt-dlp-<tag>` that merges an upstream release.
  It merges by itself and starts a release.
