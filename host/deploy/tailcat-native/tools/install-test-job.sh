#!/bin/bash
# 可选：在不动正式节点的情况下，用独立 Label / 独立 state 目录（test/state）跑一个测试 tailcat，
# 验证 runner.mjs + plist 模板在这台机器上能起来。启动后自己停掉并卸载。
# 前提：$TAILCAT_DIR/test/state/tailcat.json 已存在（可从测试之前的 state 拷一份，或让 helper 自己生成）。
# 用法: host/deploy/tailcat-native/tools/install-test-job.sh
set -euo pipefail
source "$(dirname "$0")/../common.sh"
install_exit_trap
LABEL="dev.rokbot.tailcat-test"
PLIST_TMPL="$REPO_DIR/templates/$LABEL.plist.tmpl"
PLIST_SRC="$DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
job_loaded && die "$LABEL already loaded"
[ -x "$DIR/bin/rokbot-tailcat" ] || die "missing $DIR/bin/rokbot-tailcat"
mkdir -p "$DIR/test/state" "$DIR/test"
render_plist
cp "$PLIST_SRC" "$PLIST_DST"; chmod 644 "$PLIST_DST"
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
trap 'launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true; rm -f "$PLIST_DST"' EXIT
for _ in $(seq 1 40); do
  [ -f "$DIR/test/state/status.json" ] && break; sleep 0.5
done
[ -f "$DIR/test/state/status.json" ] && log "test job produced status: $(jq -c '{state,listening}' "$DIR/test/state/status.json")" || log "WARN: no test status.json"
log "test job unloaded"
