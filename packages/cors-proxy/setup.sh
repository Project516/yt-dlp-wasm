#!/usr/bin/env bash
# Installs the yt-dlp-wasm CORS proxy as a systemd service on Debian or Ubuntu.
# Run as root. Options are listed by --help.
set -euo pipefail

SERVICE=yt-dlp-wasm-proxy
APP_DIR=/opt/$SERVICE
CONFIG_DIR=/etc/$SERVICE
ENV_FILE=$CONFIG_DIR/env
UNIT_FILE=/etc/systemd/system/$SERVICE.service
UPDATE_UNIT_FILE=/etc/systemd/system/$SERVICE-update.service
UPDATE_TIMER_FILE=/etc/systemd/system/$SERVICE-update.timer
RAW_URL=https://raw.githubusercontent.com/Project516/yt-dlp-wasm
DEFAULT_ORIGINS=https://yt-dlp-wasm.project516.dev

tunnel_token=
origins=
port=
ref=
auto_update=
uninstall=false
update=false
tmp_dir=
files_changed=false
access_key=
node_bin=
apt_updated=false

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage: setup.sh [options]
  --tunnel-token TOKEN  install cloudflared and connect it to this tunnel
  --origins LIST        comma-separated allowed origins (default $DEFAULT_ORIGINS)
  --port N              local port (default 8787)
  --ref REF             git ref to download the proxy files from (default master)
  --update              download the latest proxy files from the saved ref and restart
                        the service if they changed. Takes no other option.
  --auto-update         check for updates daily (default)
  --no-auto-update      do not check for updates, and remove the daily check
  --uninstall           remove the proxy service, its files and its config
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --tunnel-token | --origins | --port | --ref)
        [ $# -ge 2 ] || die "$1 needs a value"
        case $1 in
          --tunnel-token) tunnel_token=$2 ;;
          --origins) origins=$2 ;;
          --port) port=$2 ;;
          --ref) ref=$2 ;;
        esac
        shift 2
        ;;
      --uninstall)
        uninstall=true
        shift
        ;;
      --update)
        update=true
        shift
        ;;
      --auto-update)
        auto_update=true
        shift
        ;;
      --no-auto-update)
        auto_update=false
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown option $1"
        ;;
    esac
  done
}

existing_setting() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1
}

# Re-runs keep every setting that no option overrides
load_settings() {
  if [ -f "$ENV_FILE" ]; then
    access_key=$(existing_setting ACCESS_KEY)
    [ -n "$origins" ] || origins=$(existing_setting ALLOWED_ORIGINS)
    [ -n "$port" ] || port=$(existing_setting PORT)
    [ -n "$ref" ] || ref=$(existing_setting SETUP_REF)
    [ -n "$auto_update" ] || auto_update=$(existing_setting SETUP_AUTO_UPDATE)
  fi
  origins=${origins:-$DEFAULT_ORIGINS}
  port=${port:-8787}
  ref=${ref:-master}
  [ "$auto_update" = false ] || auto_update=true

  case $port in
    '' | *[!0-9]*) die "--port must be a number" ;;
  esac
  { [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; } || die "--port must be between 1 and 65535"
  case $origins in
    *[[:space:]\"\'\\]*) die "--origins must be a comma-separated list without spaces or quotes" ;;
  esac
  case $ref in
    *[!A-Za-z0-9._/-]*) die "--ref may only contain letters, digits and . _ / -" ;;
  esac
  case $tunnel_token in
    *[[:space:]]*) die "--tunnel-token must not contain spaces" ;;
  esac
}

remove_service() {
  systemctl disable --now "$SERVICE-update.timer" 2>/dev/null || true
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_FILE" "$UPDATE_UNIT_FILE" "$UPDATE_TIMER_FILE"
  systemctl daemon-reload
  rm -rf "$APP_DIR" "$CONFIG_DIR"
  echo "Removed $SERVICE."
  if command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared is still installed. Remove its service with: sudo cloudflared service uninstall"
  fi
}

apt_install() {
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  if [ "$apt_updated" = false ]; then
    apt-get update </dev/null
    apt_updated=true
  fi
  apt-get install -y --no-install-recommends "$@" </dev/null
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

install_node() {
  command -v curl >/dev/null 2>&1 || apt_install curl ca-certificates
  if [ "$(node_major)" -lt 18 ]; then
    apt_install nodejs
  fi
  [ "$(node_major)" -ge 18 ] || die "Node.js 18 or newer is required, found $(node -v 2>/dev/null || echo none). Install a newer nodejs, then run this again."
  node_bin=$(readlink -f "$(command -v node)")
  case $node_bin in
    /root/* | /home/*) die "node is at $node_bin, which the service cannot read. Install nodejs with apt." ;;
  esac
}

# Where the proxy files come from: a directory or URL. A checkout installs
# itself. YTDLP_PROXY_SOURCE overrides this, which the CI job uses.
source_base() {
  local dir
  if [ -n "${YTDLP_PROXY_SOURCE:-}" ]; then
    echo "$YTDLP_PROXY_SOURCE"
    return
  fi
  if [ "$update" = false ] && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    if [ "$dir" != "$APP_DIR" ] && [ -f "$dir/worker.js" ] && [ -f "$dir/node.mjs" ] && [ -f "$dir/setup.sh" ]; then
      echo "$dir"
      return
    fi
  fi
  echo "$RAW_URL/$ref/packages/cors-proxy"
}

# Downloads into a temp dir and checks the files before anything is replaced
fetch_files() {
  local base file
  base=$(source_base)
  install -d "$tmp_dir/new" "$tmp_dir/old"
  for file in worker.js node.mjs setup.sh; do
    case $base in
      /*) cp "$base/$file" "$tmp_dir/new/$file" ;;
      *) curl -fsSL --retry 3 --max-time 120 "$base/$file" -o "$tmp_dir/new/$file" ;;
    esac
  done
  # worker.js is an ES module, and Node 18 needs this to load it
  echo '{"type":"module"}' >"$tmp_dir/new/package.json"
  for file in worker.js node.mjs; do
    node --check "$tmp_dir/new/$file" || die "the downloaded $file is not valid JavaScript, nothing was changed"
  done
  bash -n "$tmp_dir/new/setup.sh" || die "the downloaded setup.sh is not valid, nothing was changed"
}

put_file() {
  install -m "$2" "$tmp_dir/new/$1" "$APP_DIR/$1.new"
  mv "$APP_DIR/$1.new" "$APP_DIR/$1"
}

install_files() {
  local file
  fetch_files
  install -d -m 755 "$APP_DIR"
  files_changed=false
  for file in worker.js node.mjs; do
    cmp -s "$tmp_dir/new/$file" "$APP_DIR/$file" 2>/dev/null || files_changed=true
    cp -p "$APP_DIR/$file" "$tmp_dir/old/$file" 2>/dev/null || true
  done
  put_file worker.js 644
  put_file node.mjs 644
  put_file package.json 644
  put_file setup.sh 755
}

restore_files() {
  local file
  for file in worker.js node.mjs; do
    [ ! -f "$tmp_dir/old/$file" ] || cp -p "$tmp_dir/old/$file" "$APP_DIR/$file"
  done
}

write_config() {
  if [ -z "$access_key" ]; then
    access_key=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  fi
  install -d -m 700 "$CONFIG_DIR"
  (
    umask 077
    cat >"$ENV_FILE.tmp" <<CONFIG
ALLOWED_ORIGINS=$origins
ACCESS_KEY=$access_key
REQUIRE_ACCESS_KEY=true
HOST=127.0.0.1
PORT=$port
SETUP_REF=$ref
SETUP_AUTO_UPDATE=$auto_update
CONFIG
  )
  chown root:root "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

# The heap cap and MemoryMax suit a device with 512 MB of RAM. Bodies stream through.
write_unit() {
  cat >"$UNIT_FILE" <<UNIT
[Unit]
Description=yt-dlp-wasm CORS proxy
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$node_bin --max-old-space-size=96 $APP_DIR/node.mjs
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
CapabilityBoundingSet=
MemoryHigh=160M
MemoryMax=192M
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
}

write_update_timer() {
  if [ "$auto_update" = true ]; then
    cat >"$UPDATE_UNIT_FILE" <<UNIT
[Unit]
Description=Update the yt-dlp-wasm CORS proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$APP_DIR/setup.sh --update
TimeoutStartSec=300
PrivateTmp=yes
UNIT
    cat >"$UPDATE_TIMER_FILE" <<UNIT
[Unit]
Description=Update the yt-dlp-wasm CORS proxy daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=3h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
    systemctl daemon-reload
    systemctl enable --now "$SERVICE-update.timer"
  else
    systemctl disable --now "$SERVICE-update.timer" 2>/dev/null || true
    rm -f "$UPDATE_UNIT_FILE" "$UPDATE_TIMER_FILE"
    systemctl daemon-reload
  fi
}

wait_for_proxy() {
  local _
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$port/"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_service() {
  systemctl daemon-reload
  systemctl enable "$SERVICE"
  systemctl restart "$SERVICE"
  if ! wait_for_proxy; then
    journalctl -u "$SERVICE" --no-pager -n 20 >&2 || true
    die "the proxy did not start on port $port"
  fi
}

update_proxy() {
  { [ -f "$ENV_FILE" ] && [ -f "$UNIT_FILE" ]; } || die "$SERVICE is not installed. Run the installer first."
  { [ -z "$tunnel_token" ] && [ -z "$origins" ] && [ -z "$port" ] && [ -z "$ref" ] && [ -z "$auto_update" ]; } ||
    die "--update takes no other option. Run the installer again to change settings."
  load_settings
  [ "$(node_major)" -ge 18 ] || die "Node.js 18 or newer is required"
  install_files
  if [ "$files_changed" = false ]; then
    echo "$SERVICE is up to date."
    return
  fi
  systemctl restart "$SERVICE"
  if ! wait_for_proxy; then
    restore_files
    systemctl restart "$SERVICE" || true
    die "the updated proxy did not start on port $port, the previous files are back"
  fi
  echo "Updated $SERVICE from $ref."
}

install_tunnel() {
  if ! command -v cloudflared >/dev/null 2>&1; then
    install -d -m 755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      >/etc/apt/sources.list.d/cloudflared.list
    apt_updated=false
    apt_install cloudflared
  fi
  # A repeat install fails while the service exists
  cloudflared service uninstall </dev/null >/dev/null 2>&1 || true
  cloudflared service install "$tunnel_token" </dev/null
}

print_summary() {
  local update_note="daily, from ref $ref. Run '$APP_DIR/setup.sh --update' to update now."
  [ "$auto_update" = true ] || update_note="off. Run '$APP_DIR/setup.sh --update' to update."
  cat <<DONE

The proxy is running as the $SERVICE service.
Local URL:  http://127.0.0.1:$port/
Access key: $access_key
Origins:    $origins
Updates:    $update_note

In the demo, open Proxy settings, pick Custom proxy, and set:
  Proxy URL:  the public hostname of your tunnel, such as https://proxy.example.com/
  Access key: the key above
DONE
  if [ -z "$tunnel_token" ]; then
    echo "No tunnel was set up. Run this again with --tunnel-token TOKEN to publish the proxy."
  fi
}

cleanup() {
  [ -z "$tmp_dir" ] || rm -rf "$tmp_dir"
}

main() {
  parse_args "$@"
  [ "$(id -u)" -eq 0 ] || die "run as root, for example with sudo"
  tmp_dir=$(mktemp -d)
  trap cleanup EXIT
  if [ "$uninstall" = true ]; then
    remove_service
    return
  fi
  [ -d /run/systemd/system ] || die "systemd is not running"
  if [ "$update" = true ]; then
    update_proxy
    return
  fi
  command -v apt-get >/dev/null 2>&1 || die "this script needs apt, so Debian, Ubuntu or a system based on them"
  load_settings
  install_node
  install_files
  write_config
  write_unit
  write_update_timer
  start_service
  if [ -n "$tunnel_token" ]; then
    install_tunnel
  fi
  print_summary
}

main "$@"
