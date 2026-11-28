# RokBot Host

[English](README.en.md)

自建 RokBot 服务端（仓库：`https://github.com/hongfaqiu/rokbot`）。Host 可在 Linux amd64 / arm64 上构建；官方执行桌面只有 amd64，ARM 机器可以接一台独立的 amd64 节点，或同机模拟（实验）。需要 Python 3.10+ 和 Docker Compose v2。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md)，实现原理见[技术文档](../docs/ARCHITECTURE.md)。

## 使用

在 `host/` 目录运行：

```sh
python3 deploy.py doctor
python3 deploy.py init
python3 deploy.py up
```

新装默认只监听回环地址，自定义访问地址在 `init` 时指定（`python3 deploy.py init --help`）。已有实例用 `update`，不要重新 `init`。首次设置、模型和配对见部署手册。

## 离线构建

构建工具默认从固定来源下载原版文件并严格校验，版本见 `recipes/host/manifest.json`。已有原版文件时：

```sh
python3 deploy.py up --host-archive /path/to/host.tgz --box-archive /path/to/box.tar.gz
```

- Box 归档校验通过后标记为 `rokbot-box-input:2bb5e41`，Compose 直接使用（也可通过 `ROKBOT_HOST_IMAGE=ghcr.io/hongfaqiu/rokbot/host` 与 `ROKBOT_BOX_IMAGE=ghcr.io/hongfaqiu/rokbot/box` 指定预构建镜像，并通过 `ROKBOT_HOST_ARCHIVE_URL` 覆盖归档镜像源）。离线归档按配置摘要校验，与 Docker 的镜像存储方式无关。
- 已有实例把 `up` 换成 `update`；只构建不启动时，`release/build-docker.py` 接受相同参数。
- 这些参数只替代原版下载。全离线还要预缓存基础镜像、系统包和 npm 依赖，ARM 同机还需要 amd64 的 `busybox:1.37`。ARM 独立 Host 不传 `--box-archive`。
- `release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` 可以单独生成 Host 文件；只做固定的字节复制和新增，不反编译。

## 本地画布

Bot 可以用 `WriteCanvas`、`EditCanvas`、`ReadCanvas`、`ListCanvases` 生成和修改可交互页面（单个 React `.canvas.tsx` 模块，只能 import `cursor/canvas`），参数和官方画布工具一致，但编译、存储、访问都在本机完成：

- Host 用镜像里自带的 esbuild、React 和 RokBot 画布组件库离线编译，不访问网络。源码、编译结果和访问令牌保存在数据目录的 `canvases/` 下，随 `host-data` 一起备份。更新同一个画布时链接不变。
- **默认私有**（对齐官方 CanvasVisibility 的 PRIVATE / PUBLIC）。工具返回给模型的是软件内链接 `/canvas/app/<画布 id>`：RokBot 各客户端点开后在软件内打开（桌面端 / 网页版是全屏画布视图，安卓 `CanvasActivity`，iOS `RBCanvas`），用设备自己的凭证读取；浏览器直接访问时只有已登录的网页版会话能看，其他一律 404。
- **分享时公开**：画布右上角「分享」里打开「公开访问」后才有公开链接 `/canvas/<令牌>`（256 位随机令牌），任何人无需登录可看；关闭后该链接立即 404，再次打开沿用同一链接；「重新生成链接」会换令牌，旧链接永久失效。公开状态写在 `canvases/<id>/meta.json`，Host 重启不丢。旧版本生成的画布（没有 `visibility` 字段）一律按私有处理，用户在分享面板里重新打开即可恢复原链接。
- 设备接口：`GET /local/canvases?agentId=`、`GET /local/canvases/<id>`、`POST /local/canvases/<id>/visibility`、`POST /local/canvases/<id>/link`、`DELETE /local/canvases/<id>`，两个监听端口都需要设备凭证。Bot 详情（桌面端 / 网页版）和 Bot 资料库（安卓 / iOS）里有「画布」列表，可打开、分享、删除。
- 画布代码只在 `sandbox` 环境里运行（不同源、`connect-src 'none'`），读不到 Host 的接口和凭证。链接里的地址优先取 `ROKBOT_PUBLIC_URL`，未配置时取客户端最近一次访问 Host 用的地址；公开链接要给外部访问时请配置 `ROKBOT_PUBLIC_URL`。

## 数据与备份

```sh
python3 deploy.py backup < /dev/null
```

- 同机部署备份 `host-data`、`box-home`、`box-workspace`；独立 Host 只有 `host-data`，执行节点要单独备份 `gateway-data` 和两个桌面卷。
- 备份目录只含卷归档和校验清单，**不含镜像、实例目录的 `.env` 和宿主机系统**。卷里有配对身份、模型 Key、对话和工作区文件，备份不要公开。
- 备份会暂停正在运行的容器，结束后恢复。`update` 先构建候选，再停止旧服务并备份。分机部署不是跨主机原子快照，要协调两端停止写入。

**恢复成一个新实例**：分开保管卷备份、原 `.env`、对应代码版本和镜像；清单的 `serviceImages` 记录完整镜像 ID，目标 Docker 必须已有这些镜像。先确认原实例及其他机器上的同一身份都已停机，不要对原项目运行 `down -v`。以下是回环地址的同机示例，目录和项目名按实际替换；要让原有配对继续可用，用 `init` 的 `--listen`、`--port`、`--public-url` 重现原地址。独立 Host 在 `init` 前加 `--host-only`。

```sh
python3 deploy.py --home "$HOME/rokbot-restored" --project rokbot-restored init < /dev/null
python3 deploy.py --home "$HOME/rokbot-restored" recover --directory /path/to/backup < /dev/null
python3 deploy.py --home "$HOME/rokbot-restored" status < /dev/null
```

`recover` 校验卷、项目名、拓扑和本地镜像 ID，只往新项目解包，启动时只用记录的镜像，不构建、不拉取、不改原卷。启动后用原设备读回旧对话和文件。启动失败时新项目的卷保留，原实例不会自动重启。

旧清单缺少完整的 `serviceImages`，或精确镜像不在本机时，不能自动恢复上线，也不要用 `:local` 标签猜版本。只恢复数据用 `python3 release/backup.py restore --project rokbot-data-only --directory /path/to/backup --image <已核实的镜像ID> < /dev/null`，它不启动服务，独立执行节点也用这个入口。

同个 Docker daemon 上，部署工具用锁防止并发修改同一项目、同源恢复副本重复上线；不同 daemon 之间不共享锁，由操作者确认同一身份只运行一份。崩溃后可能留锁，先核实服务和操作进程，不要把删锁当成常规步骤。名字带 `_restore-in-progress` 的项目是未完成的恢复，不能启动，换一个空项目重试。

## 分开部署执行电脑

Host 机器用 `python3 deploy.py --host-only init` 再 `python3 deploy.py up`。在另一台 **amd64 Linux** 的 `host/` 目录部署执行节点：

```sh
python3 release/build-docker.py --box-only
# 设置至少 32 位的随机 ROKBOT_NODE_TOKEN；离线镜像可在上一条命令加 --box-archive
docker compose -f release/compose.execution.yaml up -d --build
```

然后在 Host 管理页填写执行节点的地址和密钥并启用。`--host-only` 模式要先配好模型并启用节点，聊天核心才会启动；没有节点时管理页能打开、容器也可能显示健康，但不能聊天。

- 局域网访问：设置 `ROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`，端口默认 18443。
- 内嵌网络：设置 `ROKBOT_TAILCAT_ENABLED=1`；高级选项是 `ROKBOT_TAILCAT_RELAY` 和 `ROKBOT_TAILCAT_DERP_MAP_URL`。
- macOS 宿主机想绕开容器 UDP 的对称 NAT、把 Tailcat 放到本机 launchd 运行：见 [deploy/tailcat-native/](deploy/tailcat-native/README.md)。

<a id="capacity-benchmark"></a>
## 整机基准

`bench/` 用来比较两个版本在同一台机器上的整机资源占用，不是备份工具，也不给出硬件最低配置。只在获准的专用非生产 Linux 虚拟机上运行，不接生产服务、卷或凭据。

| `--mode` | 采样对象 |
| --- | --- |
| `x86-local` | 同机：amd64 Host 上的 `host` 和 `box` |
| `arm-split` | 分机：arm64 Host 上的 `host`；另一台 amd64 上的 `gateway` 和 `box`（用 `--role desktop`），两端用同一个 `--run-id` |
| `arm-emulated` | 模拟同机（实验）：arm64 上的 `host` 和模拟的 amd64 `box` |
| `host-only` | 只有 `host`，只用于设置和空闲诊断，不评容量 |

```sh
R=/path/to/private-bench
python3 -B bench/bench.py sample --isolated-guest --mode x86-local --role host \
  --project benchdemo --run-id before-1 --out "$R/BEFORE/1/host.jsonl" --interval 5 --duration 5400
python3 -B bench/bench.py validate "$R/BEFORE/1" > "$R/round-report.json"
python3 -B bench/bench.py compare --before "$R/BEFORE" --after "$R/AFTER" > "$R/comparison.json"
```

- 采样器需要 `systemd-detect-virt --vm` 认可的虚拟机、cgroup v2 和本地 Docker 套接字；裸机、WSL、容器、远程或 rootless Docker 会被拒绝。stderr 输出 `sampling-ready` 后再开始构建或负载。
- 每轮目录需要 `run.json`、`actions.jsonl` 和各角色的采样文件。字段和阶段（`build`、`cold`、`idle`、`chat`、`desktop`、`restart`、`soak`、`concurrent`）的规则见 [`bench/evidence.py`](bench/evidence.py)，样例见 [`tests/benchmark_checks.py`](tests/benchmark_checks.py)。只有真实客户端、外部模型 API 的测量才能送审；`soak` 每轮至少 1 小时真实负载。
- `compare` 需要同条件下至少三对基线和候选，失败的轮次也要保留。退出码 `0` 表示可复核（不是硬件认证），`1` 表示失败、不完整或轮数不足，`2` 表示输入无效或条件不匹配。指标的计算方式见 [`bench/telemetry.py`](bench/telemetry.py)。
- 离线自检：`python3 -B bench/bench.py selftest`；回归测试：`node --test "tests/benchmark*.test.mjs"`。

首页的最低和推荐配置来自功能测试和实际占用，不是这套对照的结果，依据见[技术文档](../docs/ARCHITECTURE.md#capacity-evidence)。

## 应用开发

管理页的「应用」统一管理远程 MCP 服务、带代码的应用和附带的技能。一个应用就是一个 `rokbot-app` JSON 包，旧版插件 JSON 也能导入。

- 内置的「编写应用」提供开发指南、格式校验和提交工具。Bot 提交后，用户在客户端的「连接应用」里添加并授权。
- 导入、导出都是单个 JSON，包含代码、图标、说明和技能；已保存的配置和授权凭证不会导出。
- 代码应用通过执行电脑上的 MCP 进程运行，不额外部署容器，和这台电脑上的其他任务共享用户权限、文件和网络。
- OAuth 支持 PKCE、一次性 state 和过期刷新。开发者声明授权地址、Token 地址和 scopes；用户填写 Client ID/Secret，再从客户端打开授权页。
- 应用版本不可覆盖，升级后可以恢复到上一个版本。

完整的包格式、可运行示例和 OAuth 示例见 [server/application-guide.md](server/application-guide.md)（英文，Bot 写应用时读的就是这份）。

## 许可

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
