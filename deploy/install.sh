#!/usr/bin/env bash
# Installs or updates the counter on this machine. Idempotent. Run as root.
#   deploy/install.sh                          full install (scripts/deploy.sh copies the files and runs it)
#   deploy/install.sh --new-password           new random password for /stats/, shown once (run it yourself:
#                                              ssh -t hetzner bash /opt/counter/deploy/install.sh --new-password)
#   deploy/install.sh --restart-if-node-changed  weekly (counter-update.timer): restart on a new Node patch
#
# Needs from the same machine (robinsout/crema-catalana, deploy/): Node 24 at /opt/node/sync-current and
# Caddy whose /etc/caddy/Caddyfile has "import /etc/caddy/routes.d/*.caddy" in the site block.
# Caddy also serves the sync server: a routes file is kept only if Caddy validates and comes back with it.
set -euo pipefail
shopt -s inherit_errexit

APP=/opt/counter
SERVICE=counter
ETC=/etc/counter
ENV_FILE=$ETC/env
ROUTES_DIR=/etc/caddy/routes.d
ROUTES=$ROUTES_DIR/counter.caddy
NODE=/opt/node/sync-current/bin/node
SYNC_HEALTH=https://188.245.182.47/v1/health

get_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }

set_env() { # set_env NAME VALUE — replaces the line in the root-only env file, atomically
  local tmp
  tmp="$(mktemp "$ETC/.env.XXXXXX")"
  { grep -v "^$1=" "$ENV_FILE" 2>/dev/null || true; printf '%s=%s\n' "$1" "$2"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

secrets() {
  install -d -m 700 -o root -g root "$ETC"
  [ -n "$(get_env STATS_SECRET)" ] || set_env STATS_SECRET "$(openssl rand -hex 32)"
}

imports_routes() { grep -q 'import /etc/caddy/routes.d/' /etc/caddy/Caddyfile; }

caddy_ok() {
  sleep 2
  systemctl is-active --quiet caddy && curl -fsS --max-time 10 "$SYNC_HEALTH" >/dev/null
}

# The Caddy routes of the counter. The secret header is set only on the route of /stats/ and removed on
# the open route /c/*. /stats/ (not /stats): the browser sends the password only below that path.
routes() {
  local secret new backup=""
  secret="$(get_env STATS_SECRET)"
  install -d -m 755 "$ROUTES_DIR"
  new="$(mktemp "$ETC/.routes.XXXXXX")"   # holds the secret: root-only directory, not /tmp
  cat > "$new" <<EOF
# robinsout/counter — imported by /etc/caddy/Caddyfile. Made by /opt/counter/deploy/install.sh: do not edit.
handle /c/* {
	request_body {
		max_size 8KB
	}
	reverse_proxy 127.0.0.1:8788 {
		header_up -X-Counter-Stats
	}
}
redir /stats /stats/ 308
handle /stats/* {
	request_body {
		max_size 1KB
	}
	reverse_proxy 127.0.0.1:8788 {
		header_up X-Counter-Stats "$secret"
	}
}
EOF
  if cmp -s "$new" "$ROUTES"; then rm -f "$new"; echo "    routes unchanged"; return; fi
  if [ -f "$ROUTES" ]; then backup="$(mktemp "$ETC/.routes-old.XXXXXX")"; cp -p "$ROUTES" "$backup"; fi
  install -m 640 -o root -g caddy "$new" "$ROUTES"
  rm -f "$new"
  if ! imports_routes; then
    echo "    !!! /etc/caddy/Caddyfile does not import $ROUTES_DIR yet (crema-catalana deploy/Caddyfile): routes wait"
    rm -f "$backup"
    return
  fi
  if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl restart caddy && caddy_ok; then
    echo "    routes installed, caddy restarted, sync answers"
    rm -f "$backup"
    return
  fi
  echo "!!! Caddy did not accept the routes: putting the old ones back"
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -5 || true
  if [ -n "$backup" ]; then install -m 640 -o root -g caddy "$backup" "$ROUTES"; rm -f "$backup"; else rm -f "$ROUTES"; fi
  systemctl restart caddy
  caddy_ok && echo "    caddy is back with the old routes" || echo "!!! CADDY IS DOWN: check journalctl -u caddy now"
  exit 1
}

health() {
  sleep 2
  if ! systemctl is-active --quiet "$SERVICE"; then
    journalctl -u "$SERVICE" -n 30 --no-pager
    echo "!!! $SERVICE is not running"
    return 1
  fi
  echo "    $SERVICE: active, enabled at boot: $(systemctl is-enabled "$SERVICE")"
  curl -fsS http://127.0.0.1:8788/c/health; echo
}

# The new hash replaces the old one only after the service has started with it: a failed restart
# leaves the old password working.
new_password() {
  secrets
  local password old
  password="$(openssl rand -base64 18 | tr '+/' '-_')"   # 144 random bits
  old="$(get_env STATS_PASSWORD_SHA256)"
  set_env STATS_PASSWORD_SHA256 "$(printf '%s' "$password" | sha256sum | cut -d' ' -f1)"
  systemctl restart "$SERVICE"
  if ! health >/dev/null; then
    health || true
    if [ -n "$old" ]; then set_env STATS_PASSWORD_SHA256 "$old"; systemctl restart "$SERVICE"; fi
    echo "!!! the counter did not start with the new password; the old one still works"
    exit 1
  fi
  cat <<EOF

  New password for https://188.245.182.47/stats/ (any user name):

      $password

  It is shown only now and stored only as a hash. Save it in your password manager.
  Five wrong tries from one address lock that address out for 15 minutes (the right password still works).

EOF
}

restart_if_node_changed() {
  local pid running
  pid="$(systemctl show -p MainPID --value "$SERVICE")"
  running="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
  if [ "$running" != "$(readlink -f "$NODE")" ]; then
    systemctl restart "$SERVICE"
    echo "    restarted on $(readlink -f "$NODE")"
  fi
  health
}

full() {
  [ -x "$NODE" ] || { echo "!!! $NODE is missing: deploy the sync server of crema-catalana first"; exit 1; }
  "$NODE" --version

  echo "==> Code is read-only for everyone but root"
  chown -R root:root "$APP"
  chmod -R go-w "$APP"

  echo "==> Secrets ($ENV_FILE, root only)"
  secrets
  [ -n "$(get_env STATS_PASSWORD_SHA256)" ] || echo "    no stats password yet: ssh -t hetzner bash $APP/deploy/install.sh --new-password"

  echo "==> systemd units"
  for unit in "$SERVICE.service" "$SERVICE-update.service" "$SERVICE-update.timer"; do
    systemd-analyze verify "$APP/deploy/$unit"
    install -m 644 "$APP/deploy/$unit" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null
  systemctl enable --now "$SERVICE-update.timer" >/dev/null
  systemctl restart "$SERVICE"

  echo "==> Health"
  health

  echo "==> Caddy routes ($ROUTES)"
  routes
}

case "${1:-}" in
  --new-password) new_password ;;
  --restart-if-node-changed) restart_if_node_changed ;;
  "") full ;;
  *) echo "usage: install.sh [--new-password | --restart-if-node-changed]"; exit 2 ;;
esac
