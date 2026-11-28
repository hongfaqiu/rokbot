# shared helper。源码打包不是本文件；这是 bash 片段，不要期望 -x 能直接跑。
# 由 cutover.sh / rollback.sh / install.sh 通过 source 加载，也可只 source 来调用函数。
# 不打印密钥、身份、链接或管理员密码。
set -euo pipefail
export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
umask 077

# ---- 本机路径（没有硬编码的家目录；一律从 $HOME / 脚本位置推导） ----
# 本仓库内该目录的绝对路径（用于找 runner.mjs / probe.py / plist 模板）
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 运行时目录：state/、bin/rokbot-tailcat、logs/ 都放在这里。默认 $HOME/rokbot-tailcat，可用 TAILCAT_DIR 覆盖。
DIR="${TAILCAT_DIR:-$HOME/rokbot-tailcat}"
LABEL="${TAILCAT_LABEL:-dev.rokbot.tailcat}"
PLIST_TMPL="$REPO_DIR/templates/$LABEL.plist.tmpl"
PLIST_SRC="$DIR/$LABEL.plist"                                   # 安装时生成的本机 plist（不入库）
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"             # launchd 实际加载的位置
DOMAIN="gui/$(id -u)"
STATE="$DIR/state"
JAR=""
NODE_BIN="${TAILCAT_NODE:-$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)}"

# ---- 可配置项：以下默认值来自这台机器当时的部署，换机器/换域名都必须显式覆盖 ----
# 容器名
CONTAINER="${ROKBOT_CONTAINER:-rokbot-live-host-1}"
# Host 管理接口地址（本机 Host 的 admin API）
HOST_URL="${ROKBOT_HOST_URL:-http://127.0.0.1:18080}"
# 本机 tailcat 期望通告的局域网地址，仅用于切换后的自检（不参与启动逻辑）
LAN_IP="${ROKBOT_LAN_IP:-192.168.31.147}"
# 安装时写入 plist 的运行参数；与 runner.mjs 的默认值一致
TAILCAT_TARGET="${TAILCAT_TARGET:-127.0.0.1:18080}"
TAILCAT_PORT="${TAILCAT_PORT:-8000}"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
# 正常结束必须调用 ok_exit。bash 3.2 下 set -u 触发的 "unbound variable" 进入 EXIT trap 时 $? 为 0，
# 所以未经 ok_exit 的退出一律按失败(1)处理，避免脚本出错却 exit=0。
_RB_OK=""
ok_exit() { _RB_OK=1; exit 0; }
cleanup() {
  local rc=$?
  if [ -n "$JAR" ] && [ -f "$JAR" ]; then
    curl -sS -m 5 -o /dev/null -b "$JAR" -X POST -H 'x-rokbot-csrf: 1' "$HOST_URL/admin/api/logout" || true
    rm -f "$JAR"
  fi
  if [ "$rc" -eq 0 ] && [ -z "$_RB_OK" ]; then log "ERROR: 脚本未到达正常结束点就退出（可能是 set -u/-e 触发），按失败处理"; rc=1; fi
  exit "$rc"
}
# 由可执行脚本（cutover/rollback/install）调用；只 source 本文件时不要装 trap。
install_exit_trap() { trap cleanup EXIT; }

job_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# 由模板生成当前机器适用的 plist（替换 __LABEL__ / __NODE__ / __TAILCAT_DIR__ / __TAILCAT_TARGET__ / __TAILCAT_PORT__）。
# 生成物只写到 $PLIST_SRC（运行时目录），不入库。
render_plist() {
  [ -f "$PLIST_TMPL" ] || die "missing plist template: $PLIST_TMPL"
  local escaped; escaped="$(printf '%s' "$DIR" | sed 's/[&|]/\\&/g')"
  sed -e "s|__LABEL__|$LABEL|g" \
      -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__TAILCAT_TARGET__|$TAILCAT_TARGET|g" \
      -e "s|__TAILCAT_PORT__|$TAILCAT_PORT|g" \
      -e "s|__TAILCAT_DIR__|$escaped|g" \
      "$PLIST_TMPL" > "$PLIST_SRC.new"
  grep -q '__[A-Z_]*__' "$PLIST_SRC.new" && die "plist template still has placeholders after rendering"
  plutil -lint "$PLIST_SRC.new" >/dev/null || die "rendered plist invalid"
  mv "$PLIST_SRC.new" "$PLIST_SRC"
  log "rendered plist: $PLIST_SRC"
}

# PIDs of the Host-managed *serve* helper: children of supervisor.mjs, running rokbot-tailcat,
# without a local TCP LISTEN socket (forward-mode helpers listen on 127.0.0.1, serve mode does not).
container_serve_pids() {
  docker exec -i "$CONTAINER" /usr/local/bin/node - <<'JS'
const fs = require('fs');
const cmd = p => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const ppid = p => { try { return Number(/^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'))[1]); } catch { return -1; } };
const pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number);
const sup = pids.filter(p => { const c = cmd(p); return c[0] !== '/sbin/docker-init' && c.some(a => a.endsWith('deploy/supervisor.mjs')); });
const listen = new Set();
for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) { try { for (const l of fs.readFileSync(f, 'utf8').split('\n').slice(1)) { const c = l.trim().split(/\s+/); if (c[3] === '0A') listen.add(c[9]); } } catch {} }
const out = pids.filter(p => cmd(p)[0] === '/opt/rokbot/bin/rokbot-tailcat' && sup.includes(ppid(p))).filter(p => {
  let fds = []; try { fds = fs.readdirSync(`/proc/${p}/fd`); } catch { return false; }
  return !fds.some(fd => { try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${p}/fd/${fd}`)); return m && listen.has(m[1]); } catch { return false; } });
});
console.log(out.join(' '));
JS
}
container_pid_alive() { docker exec "$CONTAINER" test -d "/proc/$1"; }

admin_login() {
  JAR="$(mktemp -t rokbot-tailcat-admin)"; chmod 600 "$JAR"
  if [ -z "${ROKBOT_ADMIN_PASSWORD:-}" ]; then
    [ -t 0 ] || die "set ROKBOT_ADMIN_PASSWORD or run interactively"
    printf 'RokBot admin password: ' >&2; stty -echo; IFS= read -r ROKBOT_ADMIN_PASSWORD; stty echo; printf '\n' >&2
  fi
  jq -n --arg p "$ROKBOT_ADMIN_PASSWORD" '{password:$p}' |
    curl -sS -m 15 --fail-with-body -o /dev/null -c "$JAR" -H 'x-rokbot-csrf: 1' -H 'content-type: application/json' \
      --data-binary @- "$HOST_URL/admin/api/login" || die "admin login failed"
  unset ROKBOT_ADMIN_PASSWORD
}
admin_network() { curl -sS -m 15 --fail-with-body -b "$JAR" "$HOST_URL/admin/api/network"; }
# usage: admin_set_enabled true|false   (keeps relay / derpMapURL exactly as stored, so identity Region is kept)
admin_set_enabled() {
  local current; current="$(admin_network)"
  printf '%s' "$current" | jq -c --argjson e "$1" '{enabled:$e, derpMapURL:.derpMapURL, relay:.relay}' |
    curl -sS -m 90 --fail-with-body -o /dev/null -b "$JAR" -X PUT -H 'x-rokbot-csrf: 1' -H 'content-type: application/json' \
      --data-binary @- "$HOST_URL/admin/api/network"
}
admin_link_sha() { curl -sS -m 15 --fail-with-body -b "$JAR" -X POST -H 'x-rokbot-csrf: 1' "$HOST_URL/admin/api/network/link" | jq -j .link | shasum -a 256 | cut -c1-64; }

# 停本机节点（launchd bootout = SIGTERM runner，runner 再 SIGTERM 它的 helper）并防止它自己回来。
# 只在回滚时由 rollback.sh 调用；cutover 大失败时也用它收尾。
native_stop() {
  local pid; pid="$(jq -r '.pid // empty' "$STATE/status.json" 2>/dev/null || true)"
  if job_loaded; then log "unloading launchd job $LABEL"; launchctl bootout "$DOMAIN/$LABEL" || true; fi
  if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q "$DIR/bin/rokbot-tailcat"; then
    for _ in $(seq 1 20); do ps -p "$pid" >/dev/null || break; sleep 0.5; done
    if ps -p "$pid" >/dev/null; then log "native helper PID $pid still alive; SIGTERM"; kill -TERM "$pid" || true; sleep 2; fi
  fi
  rm -f "$PLIST_DST"   # 运行时目录里的 $PLIST_SRC 保留，重新加载时直接再拷一份
  # The runner refuses to start while enabled=false, so an accidental reload cannot create a second node.
  if [ -f "$STATE/tailcat.json" ]; then jq '.enabled = false' "$STATE/tailcat.json" > "$STATE/tailcat.json.new" && chmod 600 "$STATE/tailcat.json.new" && mv "$STATE/tailcat.json.new" "$STATE/tailcat.json"; fi
  log "native node stopped"
}
# 把 serve 角色交还容器，并等 Host 报 ready。
container_enable() {
  log "re-enabling Host-managed Tailcat (same relay, identity from /data/tailcat.json)"
  admin_set_enabled true || die "admin API re-enable failed: enable Tailcat in the admin Network page"
  for _ in $(seq 1 90); do
    if [ -n "$(container_serve_pids)" ] && [ "$(admin_network | jq -r .state)" = ready ]; then
      log "container serve helper PID: $(container_serve_pids); Host reports ready"; return 0; fi
    sleep 0.5
  done
  die "container Tailcat not ready after 45s (check admin Network page / docker logs $CONTAINER)"
}
