#!/bin/bash
# 安装（不切换）：准备运行时目录、复制 runner/probe 到运行时目录、按当前机器生成 plist 并 lint。
# 不启动 launchd 服务、不碰容器、不改 Host 状态 —— 切换只由 cutover.sh 完成。
# 用法: host/deploy/tailcat-native/install.sh
# 可覆盖: TAILCAT_DIR（默认 $HOME/rokbot-tailcat）、TAILCAT_TARGET、TAILCAT_PORT、TAILCAT_LABEL
set -euo pipefail
source "$(dirname "$0")/common.sh"
install_exit_trap

log "install preflight"
command -v jq >/dev/null || die "jq not found"
command -v docker >/dev/null || die "docker CLI not found"
[ -x "$NODE_BIN" ] || die "node not found (set TAILCAT_NODE)"
log "repo dir: $REPO_DIR"
log "runtime dir: $DIR (label $LABEL, node $NODE_BIN, target $TAILCAT_TARGET, port $TAILCAT_PORT)"

mkdir -p "$STATE" "$DIR/logs"
chmod 700 "$DIR" "$STATE"

# 仓库里的公共文件 -> 运行时目录（本机已有的文件只在内容不同的情况下覆盖，并先留备份）
sync_file() {
  local src="$1" dst="$2"
  if [ ! -f "$dst" ]; then cp "$src" "$dst"; chmod 755 "$dst"; log "installed $(basename "$dst")"
  elif ! cmp -s "$src" "$dst"; then
    cp "$dst" "$dst.bak-$(date +%Y%m%d-%H%M%S)"; cp "$src" "$dst"; chmod 755 "$dst"
    log "updated $(basename "$dst") (old copy kept as .bak-*)"
  else log "$(basename "$dst") already up to date"; fi
}
sync_file "$REPO_DIR/runner.mjs" "$DIR/runner.mjs"
sync_file "$REPO_DIR/probe.py" "$DIR/probe.py"

render_plist

[ -x "$DIR/bin/rokbot-tailcat" ] && log "helper found: $DIR/bin/rokbot-tailcat" \
  || log "WARN: $DIR/bin/rokbot-tailcat 不存在；正式 helper 需另行放置（见 README 安装步骤）"
job_loaded && log "WARN: $LABEL 已加载（本机已在运行）；install 没有改动它，切换/回滚请用 cutover.sh / rollback.sh" || true
log "install done（未启动任何服务）。下一步：cutover.sh（会停容器内 Tailcat）或先用 test/ 下的测试任务验证"
ok_exit
