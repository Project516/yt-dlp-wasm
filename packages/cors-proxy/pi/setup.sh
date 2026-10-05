#!/usr/bin/env bash
# Installs the yt-dlp-wasm CORS proxy as a systemd service on Debian or Ubuntu.
# Run as root. Options are listed by --help.
set -euo pipefail

SERVICE=yt-dlp-wasm-proxy
APP_DIR=/opt/$SERVICE
CONFIG_DIR=/etc/$SERVICE
ENV_FILE=$CONFIG_DIR/env
UNIT_FILE=/etc/systemd/system/$SERVICE.service
RAW_URL=https://raw.githubusercontent.com/Project516/yt-dlp-wasm
DEFAULT_ORIGINS=https://yt-dlp-wasm.project516.dev

tunnel_token=
origins=
port=
ref=master
uninstall=false
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
  fi
  origins=${origins:-$DEFAULT_ORIGINS}
  port=${port:-8787}

  case $port in
    '' | *[!0-9]*) die "--port must be a number" ;;
  esac
  { [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; } || die "--port must be between 1 and 65535"
  case $origins in
    *[[:space:]\"\'\\]*) die "--origins must be a comma-separated list without spaces or quotes" ;;
  esac
  case $tunnel_token in
    *[[:space:]]*) die "--tunnel-token must not contain spaces" ;;
  esac
}

remove_service() {
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_FILE"
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

install_files() {
  local script_dir=
  install -d -m 755 "$APP_DIR"
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  fi
  if [ -n "$script_dir" ] && [ -f "$script_dir/../worker.js" ] && [ -f "$script_dir/../node.mjs" ]; then
    install -m 644 "$script_dir/../worker.js" "$script_dir/../node.mjs" "$APP_DIR/"
  else
    local file
    for file in worker.js node.mjs; do
      curl -fsSL "$RAW_URL/$ref/packages/cors-proxy/$file" -o "$APP_DIR/$file.tmp"
      chmod 644 "$APP_DIR/$file.tmp"
      mv "$APP_DIR/$file.tmp" "$APP_DIR/$file"
    done
  fi
  # worker.js is an ES module, and Node 18 needs this to load it
  echo '{"type":"module"}' >"$APP_DIR/package.json"
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
CONFIG
  )
  chown root:root "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

# The heap cap and MemoryMax suit a 512 MB board. Bodies stream through.
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

start_service() {
  local _
  systemctl daemon-reload
  systemctl enable "$SERVICE"
  systemctl restart "$SERVICE"
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$port/"; then
      return 0
    fi
    sleep 1
  done
  journalctl -u "$SERVICE" --no-pager -n 20 >&2 || true
  die "the proxy did not start on port $port"
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
  cat <<DONE

The proxy is running as the $SERVICE service.
Local URL:  http://127.0.0.1:$port/
Access key: $access_key
Origins:    $origins

In the demo, open Proxy settings, pick Custom proxy, and set:
  Proxy URL:  the public hostname of your tunnel, such as https://proxy.example.com/
  Access key: the key above
DONE
  if [ -z "$tunnel_token" ]; then
    echo "No tunnel was set up. Run this again with --tunnel-token TOKEN to publish the proxy."
  fi
}

main() {
  parse_args "$@"
  [ "$(id -u)" -eq 0 ] || die "run as root, for example with sudo"
  if [ "$uninstall" = true ]; then
    remove_service
    return
  fi
  command -v apt-get >/dev/null 2>&1 || die "this script needs apt, so Debian, Raspberry Pi OS or Ubuntu"
  [ -d /run/systemd/system ] || die "systemd is not running"
  load_settings
  install_node
  install_files
  write_config
  write_unit
  start_service
  if [ -n "$tunnel_token" ]; then
    install_tunnel
  fi
  print_summary
}

main "$@"
