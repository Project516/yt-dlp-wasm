# Run your own proxy for free

Browsers block most requests yt-dlp needs to make. This Cloudflare Worker
fetches them for you and hands the results back to the page, including cookies
and redirects. Cloudflare's free plan is enough for personal use.

You only need this for the browser. In Node.js, `yt-dlp-wasm` makes requests
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

### Deploy from CI

In a fork, the workflow `.github/workflows/cors-proxy.yml` also deploys your
Worker on every push to `master` that changes `packages/cors-proxy`. Add two
repository secrets, next to `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`:

- `PERSONAL_PROXY_HOST`: the custom domain for the Worker, for example
  `proxy.example.com`. The zone must be on your Cloudflare account.
- `PERSONAL_PROXY_ORIGINS`: the `ALLOWED_ORIGINS` value, a comma-separated list.

The job writes a temporary config from them, so the hostname never enters the
repository. It turns workers.dev off, sets `REQUIRE_ACCESS_KEY`, and leaves the
`ACCESS_KEY` secret alone. Set that secret once with step 5 above. Without the
two secrets, the job skips itself.

## Use it

yt-dlp-wasm reads two environment variables inside Pyodide:

- `YTDLP_CORS_PROXY`: the worker URL, for example
  `https://yt-dlp-wasm-proxy.example.workers.dev`.
- `YTDLP_CORS_PROXY_KEY`: your access key. yt-dlp-wasm sends it as the
  `X-Ytdlp-Key` header.

A page that hosts yt-dlp-wasm passes them in the `env` option of `loadPyodide`.
With the key in page code, anyone who can load the page can read it. Keep the
page private, or use a key you can rotate.

## Run it at home

YouTube often answers requests from Cloudflare Workers with "Sign in to
confirm you're not a bot", because Workers fetch from shared datacenter IPs. A
proxy at home uses your residential IP. `node.mjs` runs the same `worker.js`
on Node.js 18 or newer, and `setup.sh` installs it as a systemd service. You
need a machine that is always online, runs Linux with systemd (Debian or
Ubuntu based) on armhf, arm64 or amd64, and has about 512 MB of RAM. Cloudflare Tunnel publishes the proxy, so you open no port on
your router.

1. In the Cloudflare dashboard, go to Zero Trust, Networks, Tunnels and create
   a tunnel. Choose the Cloudflared connector and copy the token.
2. Add a public hostname to the tunnel with the service
   `http://localhost:8787`.
3. On that machine, run the installer with the token:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Project516/yt-dlp-wasm/master/packages/cors-proxy/setup.sh | sudo bash -s -- --tunnel-token TOKEN
   ```

   From a clone, run `sudo packages/cors-proxy/setup.sh --tunnel-token TOKEN`.
4. The script prints an access key. In the demo, open Proxy settings, pick
   Custom proxy, and enter the tunnel's public URL and the key.

The script also takes `--origins LIST` (default
`https://yt-dlp-wasm.project516.dev`), `--port N` (default 8787), `--ref REF`
(the git ref to download from, default `master`) and `--uninstall`. Running it
again keeps the access key and the settings you do not override. The key and
settings, including the ref, are in `/etc/yt-dlp-wasm-proxy/env`, readable by
root only.

### Updates

The installer adds a systemd timer, `yt-dlp-wasm-proxy-update.timer`. Once a
day, at a random time within a few hours, it runs `setup.sh --update`. That
downloads `worker.js`, `node.mjs` and `setup.sh` from the saved ref into a temp
directory, checks them with `node --check` and `bash -n`, and only then
replaces the installed copies in `/opt/yt-dlp-wasm-proxy`. It restarts the
service when the proxy files changed, and puts the old files back if the new
ones do not start. A failed check or download changes nothing. The update keeps
your config and does not touch the tunnel.

- `sudo /opt/yt-dlp-wasm-proxy/setup.sh --update` updates now.
- `--no-auto-update` skips the timer, or removes it on a re-run. The choice is
  saved, so later re-runs keep it off until you pass `--auto-update`.
- A change to the systemd units reaches a machine only when you run the
  installer again.
- `journalctl -u yt-dlp-wasm-proxy-update` shows the last update.

A proxy at home can reach your home network, so `node.mjs` refuses targets that
resolve to loopback, private, link-local or other internal addresses, with a
403. `ALLOW_PRIVATE_TARGETS=true` turns the check off. The check resolves the
name before the fetch does, so a DNS server that changes its answer between
the two lookups can get around it. Keep the access key secret.

The machine must stay online for the proxy to work.

## Settings

| Variable | Meaning |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated list of origins that may use the proxy. Requests from other origins, or without an `Origin` header, get a 403. A port of `*`, as in `http://localhost:*`, matches any port. A bare `*` allows every origin, and only works when `ACCESS_KEY` is set. |
| `ACCESS_KEY` | When set, requests must send it in the `X-Ytdlp-Key` header. Set it as a secret, never in `wrangler.toml`. |
| `REQUIRE_ACCESS_KEY` | When set, requests are refused until `ACCESS_KEY` exists. The `personal` environment sets it. |
| `ALLOW_PRIVATE_TARGETS` | `node.mjs` only. Set to `true` to allow targets on loopback and private networks. Off by default. |
| `HOST`, `PORT` | `node.mjs` only. Where it listens. The defaults are `127.0.0.1` and `8787`. |
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
