# 在 macOS 宿主机上本机运行 Tailcat

本目录收纳把 RokBot Host 的 Tailcat **serve 节点从 Docker 容器挪到宿主机（macOS）本机**运行所需的部署脚本。它们原先只存在于一台机器的 `~/rokbot-tailcat/` 下，这里做了路径去硬编码、plist 模板化和安全设置补齐后入仓库。

> 这里放的是**部署脚本**，不改变任何运行逻辑：`runner.mjs` 只是加了几行注释，其余脚本逻辑与线上实际使用的一致。

## 为什么要把 Tailcat 挪出容器

Tailcat（类似 Tailscale 的组网组件）要让客户端直连 Host，需要打洞成功：客户端和 Host 从不同方向发来的 UDP 包，对端看到的映射端口应是同一个（endpoint-independent mapping，EIM）。

- **容器内（Docker Desktop for macOS）**：容器的 UDP 走 vpnkit/gvisor 用户态网络，NAT 行为变成 **symmetric NAT** —— 映射端口随目标地址变化，而且容器只知道并通告自己的私网地址（如 `172.x.x.x`）。对端收到的端口对不上，打洞失败，只能退到 DERP 中继或连接根本立不起来。
- **本机直连（经 Clash 映射）**：宿主机出网经 Clash 的 TUN/端口映射，UDP 映射是**固定**的 EIM，打洞稳定成功，真实公网 `ip:port` 可以被对端直连。

用 `tools/explain-nat.sh` 可以在本机和容器里各跑一次（同一条 UDP socket 对多个 STUN 服务器），对比映射端口是否一致，即可复现上面的结论。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `install.sh` | 安装：建运行时目录、把 `runner.mjs` / `probe.py` 复制到运行时目录、按当前机器生成 plist 并 lint。**不启动服务、不碰容器。** |
| `cutover.sh` | 切换：从容器复制身份 → 让 Host 关掉容器内 Tailcat → 加载 launchd 本机节点 → 自检（公钥/链接/endpoints/probe），失败自动回滚。**会停容器内 Tailcat。** |
| `rollback.sh` | 回滚：卸载本机 launchd 节点，把 serve 角色交还容器。 |
| `guard-container-tailcat.sh` | 部署后防护：重建 Host 容器后容器内 Tailcat 又起来了就报警；有管理员密码时直接通过 Host 管理接口再关掉。 |
| `common.sh` | 共享函数：路径推导、plist 渲染、容器内 serve 进程识别、admin API 调用、`native_stop` / `container_enable`。 |
| `runner.mjs` | 本机启动器：读 `state/tailcat.json`，spawn `bin/rokbot-tailcat`，把身份/状态写回 state 目录，日志脱敏。 |
| `probe.py` | 端到端探测：临时 forward 客户端 → 链接 → `/health`，只打印路径。 |
| `templates/*.plist.tmpl` | launchd 定义模板（占位符由脚本按当前机器替换）。 |
| `tools/` | 可选测试/诊断：`filter.py`、`stun-eim.mjs`、`explain-nat.sh`、`install-test-job.sh`。 |

## 安装

前提：macOS、已安装 Node（`node` 在 PATH，或设置 `TAILCAT_NODE`）、`jq`、Docker CLI，且 Host 已在同机容器中运行并健康。

```sh
cd host/deploy/tailcat-native
./install.sh
```

`install.sh` 会：

1. 建运行时目录 `$TAILCAT_DIR`（默认 `$HOME/rokbot-tailcat`）和其下的 `state/`、`logs/`，权限 `700`。
2. 把 `runner.mjs`、`probe.py` 复制过去（内容不同时先备份为 `*.bak-时间戳` 再覆盖）。
3. 按模板生成 `$TAILCAT_DIR/dev.rokbot.tailcat.plist`（替换 `__NODE__`、`__TAILCAT_DIR__`、`__TAILCAT_TARGET__`、`__TAILCAT_PORT__`、`__LABEL__`）并 `plutil -lint`。

还需要人工准备一项：**tailcat helper 可执行文件** `$TAILCAT_DIR/bin/rokbot-tailcat`（与 Host 容器内 `/opt/rokbot/bin/rokbot-tailcat` 同一构建，按机器架构选 arm64/amd64）。仓库不收录二进制。

安装完成后**不会启动任何服务**。正式切换：

```sh
cd host/deploy/tailcat-native
ROKBOT_ADMIN_PASSWORD_FILE=~/.rokbot-admin-password ./cutover.sh   # 或在终端里交互输入密码
```

切换时 `cutover.sh` 会：

1. 从容器 `/data/tailcat.json` 复制身份到 `$TAILCAT_DIR/state/tailcat.json`（同一身份 = 同一 `tailcat://` 链接，已配对客户端不用重新配对）。
2. 通过 Host 管理接口把容器内 Tailcat 设为 `enabled=false`，确认容器内 serve 进程已退出且不再拉起。
3. 加载 launchd 任务 `dev.rokbot.tailcat`，等 `state/status.json` 出现 `ready/listening`（最多 45 秒，超时自动回滚）。
4. 校验公钥不变、链接 SHA 不变、通告了 LAN 与 STUN 端点，最后用 `probe.py` 做一次端到端探测。

## launchd：Label 与环境变量

| 项 | 值 |
| --- | --- |
| Label | `dev.rokbot.tailcat`（可用 `TAILCAT_LABEL` 覆盖；测试任务用 `dev.rokbot.tailcat-test`） |
| 加载位置 | `~/Library/LaunchAgents/dev.rokbot.tailcat.plist`（由 `cutover.sh` 生成后拷入） |
| KeepAlive | `SuccessfulExit=false`：异常退出会被重新拉起；runner 发现 `enabled=false` 时 exit 0，不会自我复活 |
| ThrottleInterval / Umask | `5` 秒 / `63`（`077`） |

plist 里的环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TAILCAT_DIR` | `$HOME/rokbot-tailcat` | 运行时目录，`state/`、`bin/`、`logs/` 都在其下 |
| `TAILCAT_TARGET` | `127.0.0.1:18080` | 转发目标，即本机 Host |
| `TAILCAT_PORT` | `8000` | forward 模式本地监听端口 |
| `TAILCAT_STATE`（仅测试模板） | `test/state` | 相对 `TAILCAT_DIR` 的 state 子目录 |
| `TAILCAT_BINARY`（可选） | `$TAILCAT_DIR/bin/rokbot-tailcat` | helper 路径 |

安装时生成的实际 plist **不放入仓库**：仓库只放 `templates/*.plist.tmpl`，实际文件每台机器不同，且已由 `install.sh` / `cutover.sh` 自动生成。

## 状态文件

都在 `$TAILCAT_DIR/state/`（权限 `600`）：

- `state/tailcat.json`：身份与配置（`identity`、`relay`、`derpMapURL`、`enabled`）。**含私钥，绝不能入仓库。**
- `state/status.json`：runner 写的运行状态（`pid`、`state`、`listening`、`endpoints`、`netcheck`、`publicKey`…）。`endpoints` 含公网映射地址，也不入库。
- `state/link`：当前 `tailcat://` 链接（等同配对凭证，不入库）。
- `state/container-tailcat.json.bak-*`：`cutover.sh` 从容器复制前的备份（同样含身份，不入库）。
- `logs/tailcat.log`：runner 日志（`runner.mjs` 已脱敏身份行和长串密钥）。

## 回滚

把 serve 角色交还容器，并停掉本机节点：

```sh
cd host/deploy/tailcat-native
ROKBOT_ADMIN_PASSWORD_FILE=~/.rokbot-admin-password ./rollback.sh
```

步骤（`rollback.sh` → `common.sh`）：

1. **先**用管理员密码登录 Host（密码错时不会出现两边都停着的空窗）。
2. `native_stop`：`launchctl bootout gui/$(id -u)/dev.rokbot.tailcat`（runner 收到 SIGTERM 会 SIGTERM 它的 helper），必要时直接对 helper PID 发 SIGTERM；删除 `~/Library/LaunchAgents/dev.rokbot.tailcat.plist`，并把 `state/tailcat.json` 的 `enabled` 置为 `false`——这样即使误加载 launchd 任务，runner 也会以 exit 0 退出，不会出现两个同身份节点。
3. `container_enable`：通过 Host 管理接口把 Tailcat 重新置为 `enabled=true`（保留原 relay / derpMapURL），等容器内 serve helper 出现且 Host 报 `ready`（最多 45 秒）。
4. 打印服务空窗时长。

回滚后要再切回本机，重新跑 `cutover.sh` 即可。

## 可配置项（没有为此改动默认行为）

以下默认值来自这台机器当时的部署，换机器/换网络请显式覆盖：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ROKBOT_CONTAINER` | `rokbot-live-host-1` | Host 容器名 |
| `ROKBOT_HOST_URL` | `http://127.0.0.1:18080` | Host 管理接口地址 |
| `ROKBOT_LAN_IP` | `192.168.31.147` | 切换后自检期望的 LAN 通告地址（只用于打 WARN） |
| `ROKBOT_ADMIN_PASSWORD_FILE` | — | 管理员密码文件（避免明文进 argv/历史） |
| `TAILCAT_DIR` / `TAILCAT_LABEL` / `TAILCAT_TARGET` / `TAILCAT_PORT` / `TAILCAT_NODE` | 见上表 | 运行时目录、launchd Label、转发目标、本地端口、node 路径 |

> 说明：原先部分脚本/注释里提到的旧部署路径（`~/tailcat-native/finalize.sh`）已不存在于本机；`guard-container-tailcat.sh` 改为直接调用 Host 管理接口关闭容器内 Tailcat，不再依赖那个私有脚本。仓库代码里没有硬编码公网 IP；relay / derpMapURL 都由 Host 配置下发，不写死在本目录。

## 测试与诊断（可选）

- `tools/install-test-job.sh`：用独立 Label `dev.rokbot.tailcat-test` 和 `test/state` 起一个测试任务，验证 `runner.mjs` + 模板在本机能跑，然后自动卸载。**正式节点在跑时不要用**（同机只能有一个本机 tailcat 节点）。
- `tools/stun-eim.mjs` / `tools/explain-nat.sh`：STUN 映射端口一致性检测（EIM vs symmetric NAT）。
- `tools/filter.py`：从 helper 输出流中抽取 link 到文件（建议 `umask 077`）。

## 已知限制

- **只针对 macOS**：依赖 launchd、`plutil`、`launchctl`，不支持 Linux 宿主机（Linux 上应继续用容器内 Tailcat）。
- **切换有短暂空窗**：容器内 Tailcat 关闭到本机节点 ready 之间约数秒；期间已配对客户端可能需要重连。
- **同机唯一**：同一身份只能有一个 serve 节点。误启动容器内 Tailcat 会与本机节点冲突，靠 `guard-container-tailcat.sh` 兜底。
- **依赖 Clash/网络映射**：去掉 Clash 的 UDP 映射或改为其它代理模式后，公网映射端口不再固定，打洞成功率会下降。
- **依赖 Host 管理接口**：`cutover.sh` / `rollback.sh` / guard 都需要 Host 管理员密码；Host 不健康时切换会直接拒绝。
- **helper 二进制需自行放置**：仓库不含 `bin/rokbot-tailcat`，需与 Host 同版本。
- `ROKBOT_LAN_IP`、容器名、Host 地址是机器相关默认值，换机器必须覆盖，否则自检只会给出 WARN 或 API 调用失败。
- 切回容器后，Host 端 `state/` 下本机留下的身份副本仍在（`enabled=false`），请勿提交到任何仓库。

## 相关文档

- [Host 部署说明（host/README.md）](../README.md) —— 含「分开部署执行电脑」与内嵌网络开关（`ROKBOT_TAILCAT_ENABLED`）。
- [Host 编排与镜像构建（host/release/）](../release/) —— `compose.yaml`、`Dockerfile.host`、`build-docker.py`。
- [AI 部署手册](../../docs/AI-INSTALL.md)。
