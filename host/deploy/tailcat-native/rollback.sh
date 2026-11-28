#!/bin/bash
# 停掉 macOS launchd 上的 Tailcat 节点，把 serve 角色交还 Host 容器。
# 用法: ROKBOT_ADMIN_PASSWORD=... host/deploy/tailcat-native/rollback.sh   （或在终端里运行，会提示输入密码）
# 也支持 ROKBOT_ADMIN_PASSWORD_FILE=/path/to/secret
set -euo pipefail
source "$(dirname "$0")/common.sh"
install_exit_trap
if [ -z "${ROKBOT_ADMIN_PASSWORD:-}" ] && [ -n "${ROKBOT_ADMIN_PASSWORD_FILE:-}" ] && [ -r "$ROKBOT_ADMIN_PASSWORD_FILE" ]; then
  ROKBOT_ADMIN_PASSWORD="$(tr -d '\r\n' < "$ROKBOT_ADMIN_PASSWORD_FILE")"
fi
admin_login          # 先登录，密码错时不会出现两边都停着的空窗
T0=$(date +%s)
native_stop
container_enable
log "rollback done; service gap ~$(( $(date +%s) - T0 ))s"
ok_exit
