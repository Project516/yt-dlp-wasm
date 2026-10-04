# Run your own proxy for free

Browsers block most requests yt-dlp needs to make. This Cloudflare Worker
fetches them for you and hands the results back to the page, including cookies
and redirects. Cloudflare's free plan is enough for personal use.

You only need this for the browser. In Node.js, `wasm/cli.mjs` makes requests
directly.

## Deploy

1. Create a free account at https://dash.cloudflare.com/sign-up.
2. Install the dependencies:

   ```sh
   cd packages/cors-proxy
   pnpm install
   ```

3. Log in to Cloudflare. The first deploy also asks you to pick a workers.dev
   subdomain.

   ```sh
   pnpm wrangler login
   ```

4. Add your site to `ALLOWED_ORIGINS` under `[env.personal.vars]` in
   `wrangler.toml`, then deploy. Wrangler prints the worker URL.

   ```sh
   pnpm wrangler deploy --env personal
   ```

5. Set an access key. Wrangler prompts for the value. Pick a long random one,
   for example the output of `openssl rand -hex 24`.

   ```sh
   pnpm wrangler secret put ACCESS_KEY --env personal
   ```

The `personal` environment refuses every request until `ACCESS_KEY` is set.

## Use it

yt-dlp-wasm reads two environment variables inside Pyodide:

- `YTDLP_CORS_PROXY`: the worker URL, for example
  `https://yt-dlp-wasm-proxy.example.workers.dev`.
- `YTDLP_CORS_PROXY_KEY`: your access key. yt-dlp-wasm sends it as the
  `X-Ytdlp-Key` header.

A page that hosts yt-dlp-wasm passes them in the `env` option of `loadPyodide`.
With the key in page code, anyone who can load the page can read it. Keep the
page private, or use a key you can rotate.

## Settings

| Variable | Meaning |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated list of origins that may use the proxy. Requests from other origins, or without an `Origin` header, get a 403. A port of `*`, as in `http://localhost:*`, matches any port. A bare `*` allows every origin, and only works when `ACCESS_KEY` is set. |
| `ACCESS_KEY` | When set, requests must send it in the `X-Ytdlp-Key` header. Set it as a secret, never in `wrangler.toml`. |
| `REQUIRE_ACCESS_KEY` | When set, requests are refused until `ACCESS_KEY` exists. The `personal` environment sets it. |
| `RATE_LIMITER` | Optional rate limit binding. When present, each client IP is limited by it. The `demo` environment sets one. |

The worker only fetches `http` and `https` URLs.

## Warning

An open proxy lets anyone use your Cloudflare account to fetch any URL, and the
traffic counts against your quota. Keep `ALLOWED_ORIGINS` narrow and set
`ACCESS_KEY` on anything you share a URL for. Never deploy the worker with a
bare `*` origin and no key. The worker refuses that combination.

## Demo deployment

The `demo` environment (`pnpm wrangler deploy --env demo`) serves the public
demo site. It allows one origin, has no access key, and limits each IP to 100
requests per minute. Most people want `personal` instead.

## Protocol

The worker answers with the target's body and its real status, headers and
cookies in `X-Ytdlp-*` headers, so redirects and cookies behave the same as in
Node.js. Response headers travel in one header, so a response with a very large
set of cookies can exceed header size limits. `worker.js` describes the
protocol.
