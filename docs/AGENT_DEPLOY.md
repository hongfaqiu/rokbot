# RokBot AI Agent 部署与运维执行引导

[English](AGENT_DEPLOY.en.md) · [简体中文 README](../README.md) · [进阶源码构建与分机手册](AI-INSTALL.md) · [兼容与重命名说明](REBRAND_COMPAT.md)

> **适用对象**：协助用户部署、升级、配置模型或发布四端增量更新的 AI Coding Agent（如 Claude Code、Cursor、Antigravity、Codex 等）。  
> **执行原则**：按步骤逐项校验、绝不猜测或打印凭据、绝不覆盖已有生产容器或数据卷；只有完成「真实模型对话连通」后才算交付成功，不可仅凭容器 `healthy` 判定完成。

---

## 0. 安全护栏（必须遵守）

1. **禁止触碰已有生产实例**：动手前先执行 `docker ps -a`，若机器上已存在正在运行的旧实例（例如 `rokbot-host-1` 或已有 `/data` 卷），**禁止**未经用户明确同意执行 `down -v`、`rm -f` 或覆盖其 `.env`。测试演练必须使用独立目录、独立 Compose 项目名与独立端口。
2. **绝不泄露或提交敏感信息**：
   - 严禁将 `.env`、`.admin-password`、`/data/setup-key`、`/data/model.env`、API Key、Bearer Token 或私钥内容写入 Git 仓库、日志或对话截图。
   - 读取密钥类文件时应通过管道/变量就地消费或提示用户在 Web/App 界面输入，避免 `cat` 明文回显到公开日志。
3. **禁止只更新客户端时重建 Host**：若用户已部署好 Host、仅需构建或发布新版客户端，跳过第 2 节全部服务器部署命令。

---

## 1. 环境前置检查（Preflight）

在目标宿主机执行以下只读检查，确认依赖与端口状态：

```bash
set -eu
uname -a
docker --version
docker compose version
df -h .
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

| 检查项 | 最低要求 | 推荐配置 |
| --- | --- | --- |
| Docker & Compose | Docker Engine + Compose v2（支持 `up --wait`） | 最新稳定版 |
| CPU / 内存 / 磁盘 | 2 核 / 4 GB / 30 GB 可用 | 4 核 / 8 GB / 50 GB+ |
| 架构说明 | `x86_64` 原生；`arm64` 宿主机需开启 `linux/amd64` binfmt/QEMU 或 Rosetta（用于运行 `box`） | `x86_64` 或带 Rosetta 的 Apple Silicon |
| 端口冲突 | 检查 `18080`（或自定义 `ROKBOT_PUBLIC_PORT`）未被占用 | 若已占用，修改 `.env` 中的 `ROKBOT_PUBLIC_PORT` |

在开始部署前，向用户一次确认清楚以下 4 项信息（若上下文已明确则直接沿用）：
1. **部署模式**：预构建镜像一键部署（默认推荐）还是从源码本地构建？
2. **网络访问**：仅本机回环（`127.0.0.1`）、局域网（`0.0.0.0`），还是公网 HTTPS 域名（`ROKBOT_PUBLIC_URL`，iOS OTA 安装必需）？
3. **镜像源/代理**：是否需要私有 GHCR 登录（`docker login ghcr.io`）、镜像加速地址或 `HTTP_PROXY` / `HTTPS_PROXY`？
4. **客户端范围**：需要同步配置/发布哪些端（Android / iOS / macOS / Windows / Web）？

---

## 2. 部署路径选择

### 路径 A：预构建镜像一键部署（推荐，小白友好）

适用于已有预构建镜像（默认 `ghcr.io/hongfaqiu/rokbot/host:latest` 与 `ghcr.io/hongfaqiu/rokbot/box:97658ad`，支持替换为自建镜像源）。

#### A1. 克隆仓库后一键部署

仓库是私有的，匿名访问 `raw.githubusercontent.com` 会失败。先 clone 仓库（需要访问权限），再用 `--local` 运行仓库里的脚本，脚本会把 Compose 和 `.env` 模板复制到当前目录。预构建镜像同样需要访问权限，拉取前先用带 `read:packages` 权限的令牌执行 `docker login ghcr.io`。

```bash
mkdir -p "$HOME/rokbot" && cd "$HOME/rokbot"
gh repo clone hongfaqiu/rokbot src < /dev/null   # 没有 gh 时：git clone https://github.com/hongfaqiu/rokbot.git src
bash src/host/release/install-images.sh --local --prepare-only
```

按需编辑生成的 `.env`（权限 `0600`），常用核心字段：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ROKBOT_LISTEN_ADDRESS` | `127.0.0.1` | 宿主机监听网卡；局域网或反代访问改为 `0.0.0.0` |
| `ROKBOT_PUBLIC_PORT` | `18080` | 映射到容器 `8000` 的对外端口 |
| `ROKBOT_PUBLIC_URL` | 空 | 公网/局域网完整源地址（如 `https://bot.example.com`），iOS `itms-services` 必需 |
| `ROKBOT_HOST_IMAGE` | `ghcr.io/hongfaqiu/rokbot/host:latest` | 多架构 Host 镜像（`amd64` + `arm64`），可替换为私有/国内镜像 |
| `ROKBOT_BOX_IMAGE` | `ghcr.io/hongfaqiu/rokbot/box:97658ad` | 沙盒执行镜像（`linux/amd64`） |
| `ROKBOT_BOX_TOKEN` | `local` | 内置 box 保持 `local`；分机执行节点设强随机密钥 |
| `ROKBOT_ALLOW_DEVICE_MODEL_CONFIG` | `1` | `1` 允许已配对客户端直接在 App 内配置与测试模型 |
| `ROKBOT_UPDATE_DIR` | `/data/updates` | 四端签名安装包与增量补丁的持久化存储目录 |
| `ROKBOT_DEFAULT_MACHINE_ID` | 空 | 多台桌面电脑接入时固定 ExternalShell 默认执行机器 |

编辑完成后启动并等待健康检查：

```bash
bash src/host/release/install-images.sh --local
```

#### A2. 已克隆私有仓库 / 离线环境参数

| 场景 | 命令 |
| --- | --- |
| 使用本地克隆里的模板（私有仓库必须加） | `bash install-images.sh --local` |
| 仅生成并校验 Compose + `.env`，不启动容器 | `bash install-images.sh --prepare-only` |
| 镜像已通过 `docker load` 导入本地，禁止联网拉取 | `bash install-images.sh --offline` |
| 镜像已存在本机，跳过 `docker compose pull` | `bash install-images.sh --pull-never` |
| 自定义模板下载基地址 | `ROKBOT_DOWNLOAD_BASE="https://mirror.example.com/rokbot/release" bash install-images.sh` |

### 路径 B：从源码本地构建镜像（无预构建镜像或二次开发）

需准备官方 `sand-host-bundle-97658ad.tgz` 与 `sand-box-97658ad` 镜像，详见 [docs/AI-INSTALL.md](AI-INSTALL.md) 与 [host/README.md](../host/README.md)：

```bash
# 从仓库根目录执行环境检查与初始化构建
python3 host/deploy.py doctor < /dev/null
python3 host/deploy.py init < /dev/null
```

---

## 3. 首次初始化、健康校验与配对

启动完成后，按顺序校验以下端点（将 `PORT` 替换为 `.env` 中的 `ROKBOT_PUBLIC_PORT`，默认 `18080`）：

```bash
PORT="${ROKBOT_PUBLIC_PORT:-18080}"
# 1. 容器状态应为 Up (healthy)
docker compose --env-file .env -f docker-compose.images.yml ps
# 2. 外层服务健康
curl -fsS "http://127.0.0.1:${PORT}/healthz"
# 3. 公开状态（返回 brand: "RokBot"、initialized、needsModel）
curl -fsS "http://127.0.0.1:${PORT}/connect/status"
```

首次初始化流程：
1. 获取一次性初始化密钥（仅引导用户使用，**不要粘贴到工单或提交到仓库**）：
   ```bash
   docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
   ```
2. 引导用户在浏览器打开 `http://127.0.0.1:${PORT}/admin`，输入初始化密钥并设定管理员密码。
3. 在管理后台「设备与通知」生成 6 位配对码（或直接使用管理员密码），在 Android / iOS / macOS / Windows / Web 客户端中完成配对。
4. 配对完成后，客户端调用 `GET /local/status` 将返回 `initialized`、`needsModel`、`canConfigureModel`、`hostVersion`（`97658ad`）与 `defaultMachineId`。

---

## 4. 模型配置与热重载验收（支持 App 内与 API）

RokBot 支持**直接在客户端 App 内配置模型**（Android `ModelsActivity`、iOS `RBModels`、macOS/Windows/Web 设置与 `needsModel` 引导横幅），也支持通过已配对设备 Token 调用以下接口：

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/local/model` | `GET` | 读取脱敏后的当前模型路由配置与热重载状态（`apiKey` 永不明文返回，仅返回 `hasApiKey`） |
| `/local/model` | `PUT` | 写入 `/data/model.env` 并触发 `HostSupervisor` 自动热重载，返回 `reload.status`（`applied`） |
| `/local/model/catalog` | `POST` | 探测上游 `/models`（OpenAI）或 `/v1/models`（Anthropic）返回可用模型列表 |
| `/local/model/test` | `POST` | 发送一次真实预检请求（`Reply with OK.`），返回 `latencyMs` 与实际回复 |

> [!IMPORTANT]
> 验收标准：必须确认 `PUT /local/model` 返回 `reload.status: "applied"`、`POST /local/model/test` 返回 `ok: true`，且在客户端发送真实消息能够收到流式回复，才算部署验收通过。

---

## 5. 发布四端签名安装包与增量自动更新

这是「从自己部署的 Host 获取客户端」的方式：安装包由管理员按各平台 README 自行构建，仓库不提供。由管理员提前打包并签名好 Android（`.apk`）、iOS（`.ipa`）、macOS（`.dmg`/`.zip`/`.asar`）或 Windows（`.exe`/`.zip`/`.asar`）产物，通过自托管 Host 发布，终端用户即可在 App 内一键增量更新：

1. **后台界面发布（推荐）**：登录 `/admin` → 左侧「客户端更新」→ 选择目标平台（`Android` / `iOS` / `macOS` / `Windows`）→ 上传签名包 → 勾选「基于旧版本生成增量补丁」（自动生成 Android `RBDELTA1` 或桌面 `RBD1` 增量，并对桌面清单做 ECDSA P-256 签名）→ 点击「发布更新」。
2. **API 自动化发布**（需管理员 Cookie + `x-rokbot-csrf: 1`）：
   - 上传产物：`POST /admin/api/updates/upload`
   - 发布并生成增量：`POST /admin/api/updates/publish`
   - 查看清单与签名公钥：`GET /admin/api/updates`
   - 删除旧版本：`DELETE /admin/api/updates/:platform/:releaseId`
3. **客户端拉取校验端点**（需已配对设备 Bearer Token）：
   - `GET /local/updates/android.json`（`rokbot-android-native-update/v1`，含 `certificateSha256` 与 `RBDELTA1` 增量）
   - `GET /local/updates/macos.json` / `GET /local/updates/windows.json`（`rokbot-desktop-update/v1`，含 `ecdsa-p256-sha256` 签名与 `RBD1` ASAR 增量）
   - `GET /local/updates/ios.json`（`rokbot-ios-update/v1`，返回带令牌的 `itms-services`、`altstore.json` 与 `.ipa` 下载入口）
   - iOS 外部免 Header OTA 端点：`GET /updates/ios/:token/manifest.plist`、`GET /updates/ios/:token/altstore.json`、`GET /updates/ios/:token/:filename`（需配置 HTTPS `ROKBOT_PUBLIC_URL`）

---

## 6. 自动化回归校验（仓库内执行）

若 Agent 正在本仓库中协助维护或升级，可在提交前运行黑盒端到端测试套件：

```bash
# 1. 自包含框架 + 仓库规则校验（199 项）
node tests/e2e/runner.mjs --tier all --repo-check

# 2. 针对隔离测试 Host 实例的实时全量验证（切勿指向生产实例）
ROKBOT_E2E_HOST_URL=http://127.0.0.1:18082 \
ROKBOT_E2E_ADMIN_PASSWORD="<isolated-test-admin-password>" \
  node tests/e2e/runner.mjs --tier all --mode live --repo-check
```

---

## 7. 常见故障快速定位

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| `docker compose pull` 失败 | Shell 的 `HTTP_PROXY` 未传递给 Docker daemon，或私有 GHCR 未登录 | 执行 `docker login ghcr.io`、在 Docker daemon 配置代理，或在 `.env` 中将 `ROKBOT_HOST_IMAGE`/`ROKBOT_BOX_IMAGE` 改为可达镜像源 |
| ARM64 宿主机启动 `box` 较慢或报错 | `box` 为 `linux/amd64` 镜像，缺少 binfmt/QEMU 或 Rosetta | 启用 Rosetta（macOS Docker Desktop）或安装 `qemu-user-static` + `binfmt-support`（Linux） |
| 首次配置模型后沙盒工具未立刻就绪 | 冷启动 `box:1337` 需要初始化桌面与扩展；Host 已改为后台退避重试（`2s→30s`），不再阻塞模型热重载 | 等待 `box-doctor` 通过后重试工具调用；可用 `docker logs <box-container>` 查看状态 |
| iOS OTA `itms-services` 无法安装 | `ROKBOT_PUBLIC_URL` 未配置为受信任 HTTPS 域名，或 `.ipa` 签名证书不受设备信任 | 配置有效 HTTPS 反向代理与 `ROKBOT_PUBLIC_URL`，或改用 AltStore / SideStore / IPA 分享安装 |
| 容器高负载偶发 `unhealthy` | 同机多容器抢占 CPU/内存导致健康检查超时 | 新版镜像已将 `HEALTHCHECK` 超时加固至 `15s`；检查宿主机负载并确保 `box` 内存充足（建议 ≥ 3–4 GB） |
