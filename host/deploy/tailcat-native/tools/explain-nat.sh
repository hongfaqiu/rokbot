#!/bin/bash
# 解释「为什么要挪出容器」：同一条 UDP socket 向多个 STUN 服务器测映射端口。
# 本机直连（Clash TUN/映射）应得到 EIM（所有服务器看到同一映射端口）；
# Docker Desktop for macOS 下容器走 vpnkit/gvisor，UDP 变成 symmetric NAT（端口随目标变化，且只通告容器内网地址），打洞失败。
# 纯探测，不需要密钥，不改任何东西。用法: host/deploy/tailcat-native/tools/explain-nat.sh
set -euo pipefail
NODE_BIN="${TAILCAT_NODE:-$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)}"
exec "$NODE_BIN" "$(dirname "$0")/stun-eim.mjs" stun.l.google.com:19302 stun1.l.google.com:19302 stun.cloudflare.com:3478
