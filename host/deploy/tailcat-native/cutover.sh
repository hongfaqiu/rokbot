#!/bin/bash
# 把 RokBot Host 的 Tailcat *serve* 节点从 Docker 容器挪到 macOS 本机（launchd）。
# 同一身份 => 同一 tailcat:// 链接 => 已配对客户端无需重新配对。
# 这是唯一的切换入口：会停容器内 Tailcat，probe 失败会自动回滚。
# 用法: ROKBOT_ADMIN_PASSWORD=... host/deploy/tailcat-native/cutover.sh   （或在终端里运行，会提示输入密码）
# 可覆盖: TAILCAT_DIR、ROKBOT_CONTAINER、ROKBOT_HOST_URL、ROKBOT_LAN_IP、ROKBOT_ADMIN_PASSWORD_FILE
set -euo pipefail
source "$(dirname "$0")/common.sh"
install_exit_trap

# 支持从文件读取管理员密码（guard 脚本同款约定），读后立即 unset
if [ -z "${ROKBOT_ADMIN_PASSWORD:-}" ] && [ -n "${ROKBOT_ADMIN_PASSWORD_FILE:-}" ] && [ -r "$ROKBOT_ADMIN_PASSWORD_FILE" ]; then
  ROKBOT_ADMIN_PASSWORD="$(tr -d '\r\n' < "$ROKBOT_ADMIN_PASSWORD_FILE")"
fi

log "preflight"
[ -x "$DIR/bin/rokbot-tailcat" ] || die "missing $DIR/bin/rokbot-tailcat"
[ -f "$DIR/runner.mjs" ] || die "missing $DIR/runner.mjs (run install.sh first)"
[ -f "$DIR/probe.py" ] || die "missing $DIR/probe.py (run install.sh first)"
render_plist                       # 按当前机器生成 $DIR/$LABEL.plist
job_loaded && die "$LABEL is already loaded (already cut over?)"
curl -fsS -m 10 "$HOST_URL/health" | jq -e .ok >/dev/null || die "Host not healthy at $HOST_URL"
read -r -a OLD <<<"$(container_serve_pids)"
[ "${#OLD[@]}" -eq 1 ] || die "expected exactly 1 Host-managed serve helper in $CONTAINER, found: ${OLD[*]:-none}"
OLD_PID="${OLD[0]}"
log "container serve helper PID: $OLD_PID"

admin_login
NET="$(admin_network)"
[ "$(printf '%s' "$NET" | jq -r .enabled)" = true ] || die "Host reports Tailcat disabled already"
OLD_LINK_SHA="$(admin_link_sha)"

log "copying identity/state from container (contents not printed)"
STAMP="$(date +%Y%m%d-%H%M%S)"
docker exec "$CONTAINER" cat /data/tailcat.json > "$STATE/container-tailcat.json.bak-$STAMP"
jq '.enabled = true' "$STATE/container-tailcat.json.bak-$STAMP" > "$STATE/tailcat.json.new"
chmod 600 "$STATE/tailcat.json.new" "$STATE/container-tailcat.json.bak-$STAMP"; mv "$STATE/tailcat.json.new" "$STATE/tailcat.json"
EXPECT_PUB="$(jq -r .identity.Public.ServerPublic "$STATE/tailcat.json")"
[ "$(printf '%s' "$NET" | jq -r .relay)" = "$(jq -r .relay "$STATE/tailcat.json")" ] || die "relay mismatch between Host API and tailcat.json"
log "identity public key: $EXPECT_PUB"
rm -f "$STATE/status.json" "$STATE/link"

T0=$(date +%s)
log "disabling Host-managed Tailcat (persisted as enabled=false in /data/tailcat.json; Host SIGTERMs PID $OLD_PID, no respawn)"
admin_set_enabled false || die "could not disable Tailcat via admin API (nothing changed on macOS side)"
for _ in $(seq 1 20); do container_pid_alive "$OLD_PID" || break; sleep 0.5; done
if container_pid_alive "$OLD_PID"; then
  log "PID $OLD_PID still alive after 10s; sending SIGTERM to that PID"
  docker exec "$CONTAINER" kill -TERM "$OLD_PID" || true; sleep 3
  if container_pid_alive "$OLD_PID"; then container_enable || true; die "PID $OLD_PID did not exit; container Tailcat re-enabled"; fi
fi
sleep 2
if [ -n "$(container_serve_pids)" ]; then container_enable || true; die "a serve helper is still running in the container; re-enabled"; fi
[ "$(docker exec "$CONTAINER" cat /data/tailcat.json | jq -r .enabled)" = false ] || log "WARN: /data/tailcat.json not showing enabled=false"
log "container helper stopped (PID $OLD_PID gone, not respawned)"

log "loading launchd job $LABEL"
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"; cp "$PLIST_SRC" "$PLIST_DST"; chmod 644 "$PLIST_DST"
launchctl bootstrap "$DOMAIN" "$PLIST_DST"

ok=""
for _ in $(seq 1 90); do
  if [ -f "$STATE/status.json" ] && [ "$(jq -r '.state + "/" + (.listening|tostring)' "$STATE/status.json")" = "ready/true" ]; then ok=1; break; fi
  sleep 0.5
done
T1=$(date +%s)
if [ -z "$ok" ]; then
  log "native node not ready within 45s -> automatic rollback"; tail -20 "$DIR/logs/tailcat.log" >&2 || true
  native_stop; container_enable; die "cut over aborted and rolled back"
fi
log "native node ready; service gap ~$((T1 - T0))s"
[ "$(jq -r .publicKey "$STATE/status.json")" = "$EXPECT_PUB" ] && log "public key unchanged: OK" || log "WARN: public key differs!"
[ "$(shasum -a 256 "$STATE/link" | cut -c1-64)" = "$OLD_LINK_SHA" ] && log "tailcat link identical to before (clients need no re-pairing): OK" || log "WARN: link differs from the Host's previous link"
for _ in $(seq 1 30); do jq -e --arg ip "$LAN_IP:" '.endpoints | any(startswith($ip))' "$STATE/status.json" >/dev/null 2>&1 && break; sleep 1; done
log "advertised endpoints: $(jq -c .endpoints "$STATE/status.json")"
jq -e --arg ip "$LAN_IP:" '.endpoints | any(startswith($ip))' "$STATE/status.json" >/dev/null && log "LAN endpoint $LAN_IP advertised: OK" || log "WARN: $LAN_IP not advertised yet (set ROKBOT_LAN_IP if this machine uses another LAN address)"
jq -e '.endpoints | any(endswith("(stun)"))' "$STATE/status.json" >/dev/null && log "STUN endpoint advertised: OK" || log "WARN: no STUN endpoint"
log "end-to-end probe through the tunnel (ephemeral client identity):"
/usr/bin/python3 "$DIR/probe.py" "$DIR/bin/rokbot-tailcat" "$STATE/link" 20 || log "WARN: probe failed"
log "done. Rollback: $(dirname "$0")/rollback.sh"
ok_exit
