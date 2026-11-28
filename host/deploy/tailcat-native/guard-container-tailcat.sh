#!/bin/bash
# 部署后防护：重建 host 容器后，若容器内 Host 管理的 Tailcat（serve）又起来了 -> 报警；
# 若提供了 ROKBOT_ADMIN_PASSWORD 或 ROKBOT_ADMIN_PASSWORD_FILE，则直接通过 Host 管理接口把它再关掉
# （与 cutover.sh 里 disable 的调用方式相同；不需要任何本机部署目录里的私有脚本）。
# 本机 tailcat（launchd）没在跑时只报警、不自动关容器，避免两边都断。
# 用法: ROKBOT_ADMIN_PASSWORD_FILE=/path/pw host/deploy/tailcat-native/guard-container-tailcat.sh
#   退出码 0=已关/正常，1=仍在跑或失败。不打印密码。可被任何 ~/rokbot-deploy-*.sh 在 healthy 之后调用。
set -euo pipefail
source "$(dirname "$0")/common.sh"

C="$CONTAINER"
ts() { date '+%F %T %Z'; }
state() {
  EN="$(docker exec "$C" cat /data/tailcat.json 2>/dev/null | jq -r '.enabled' 2>/dev/null || true)"; EN="${EN:-unknown}"
  PIDS="$(container_serve_pids 2>/dev/null || true)"
}

if ! job_loaded; then
  echo "$(ts) GUARD: 本机 $LABEL 未加载 -> 不自动关容器 Tailcat（避免两边都断），请人工处理"; exit 1
fi
state
echo "$(ts) GUARD: container tailcat enabled=$EN serve_pids='${PIDS}'"
if [ "$EN" = false ] && [ -z "$PIDS" ]; then echo "$(ts) GUARD: OK 容器 Tailcat 已关"; exit 0; fi
echo "$(ts) GUARD ALERT: 容器内 Tailcat 又起来了（与原生 launchd 节点同身份冲突）"
osascript -e 'display notification "容器内 Tailcat 又起来了，正在/需要关闭" with title "RokBot 部署防护"' >/dev/null 2>&1 || true

if [ -z "${ROKBOT_ADMIN_PASSWORD:-}" ] && [ -n "${ROKBOT_ADMIN_PASSWORD_FILE:-}" ] && [ -r "$ROKBOT_ADMIN_PASSWORD_FILE" ]; then
  ROKBOT_ADMIN_PASSWORD="$(tr -d '\r\n' < "$ROKBOT_ADMIN_PASSWORD_FILE")"
fi
if [ -z "${ROKBOT_ADMIN_PASSWORD:-}" ]; then
  echo "$(ts) GUARD: 无管理员密码，只报警不自动关闭；请运行 $(dirname "$0")/cutover.sh 重新接管或 rollback.sh 回滚"; exit 1
fi

# 刚重建时容器内 serve helper 可能还没起来：等它出现，最多 60s
if [ "$EN" = true ]; then for _ in $(seq 1 60); do state; [ -n "$PIDS" ] && break; sleep 1; done; fi

JAR="$(mktemp -t rokbot-tailcat-guard)"; chmod 600 "$JAR"
rc=0
FOUT="$(
  admin_login
  admin_set_enabled false
  for _ in $(seq 1 30); do state; [ -z "$PIDS" ] && [ "$EN" = false ] && break; sleep 1; done
  [ "$EN" = false ] && [ -z "$PIDS" ]
)" 2>&1 || rc=$?
unset ROKBOT_ADMIN_PASSWORD
echo "$FOUT" | grep -v '^RokBot admin password' || true
echo "$FOUT" | grep -qE 'unbound variable|ERROR:|syntax error|command not found' && [ $rc -eq 0 ] && rc=1
state
echo "$(ts) GUARD: disable rc=$rc; now enabled=$EN serve_pids='${PIDS}'"
[ $rc -eq 0 ] && [ "$EN" = false ] && [ -z "$PIDS" ] && { echo "$(ts) GUARD: 已自动关闭"; exit 0; }
echo "$(ts) GUARD: 自动关闭失败，需人工处理"; exit 1
