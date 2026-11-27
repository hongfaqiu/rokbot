<p align="center">
  <img src="assets/logo/rokbot-logo.svg" width="112" alt="RokBot" />
</p>

<h1 align="center">RokBot</h1>

<p align="center">
  部署在你自己服务器上的私有 AI 助手：自选模型，数据留在本地，桌面、移动端和浏览器都能用。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Noncommercial%201.0-f59e0b?style=flat-square" alt="License: ProkBot Noncommercial License 1.0" /></a>
  <a href="#支持平台"><img src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20iOS%20%7C%20Android%20%7C%20Web-111827?style=flat-square" alt="Platforms: macOS, Windows, iOS, Android, Web" /></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Deploy-Docker%20Compose-0ea5e9?style=flat-square" alt="Deploy: Docker Compose" /></a>
</p>

<p align="center">
  <a href="docs/media/rokbot-promo.mp4">
    <img src="docs/media/rokbot-promo-teaser.webp" width="800" alt="RokBot 宣传片预告动图：云电脑、多端接力、生图、语音对话、模型自选" />
  </a>
  <br />
  <sub><a href="docs/media/rokbot-promo.mp4">观看完整宣传片（80 秒，带配音）</a></sub>
</p>

<!-- 用户可在 GitHub 网页编辑器中把 mp4 拖入此处，生成 user-attachments 链接后即可内嵌播放 -->

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.en.md">English</a> ·
  <a href="#核心功能">核心功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#获取客户端">获取客户端</a> ·
  <a href="#文档">文档</a> ·
  <a href="#常见问题">常见问题</a>
</p>

<div align="center">

<table>
  <tr>
    <td align="center"><img src="docs/images/rokbot-android-bot-list.png" width="210" alt="Android 会话列表：待处理、进行中、未读、已读四组" /><br /><sub>Bot 列表</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-image-generation.png" width="210" alt="和设计助手聊天，生成的图片直接发回对话" /><br /><sub>聊天与生图</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-bot-details.png" width="210" alt="Bot 详情：例行任务、资料库、Bot 的电脑和说明" /><br /><sub>Bot 的电脑与任务</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-approval-card.png" width="210" alt="Bot 要执行 git push 前弹出的审批卡片" /><br /><sub>审批卡片</sub></td>
  </tr>
</table>

</div>

## 简介

RokBot 是一个面向个人的自托管 AI 助手。Agent 服务端（Host）和 Bot 的执行桌面（`box`）都用 Docker 部署在你自己的机器上，模型调用走你配置的 OpenAI 或 Anthropic 兼容接口。macOS、Windows、Android、iOS 客户端和网页版只连接你自己的 Host。

对话、文件、配置和 API Key 都保存在 Host 的数据卷里。本仓库只包含本项目自己编写的部分：Host 源码、镜像构建脚本、各平台的补丁工具和构建脚本，以及文档；不包含、也不分发任何原版程序文件或客户端安装包。客户端可以用补丁工具自行构建，也可以从你自己部署的 Host 获取，见[获取客户端](#获取客户端)。

## 核心功能

### Bot 的电脑与实时接管

- Host 自带一台 Linux 桌面执行容器（`box`）。Bot 在里面用浏览器、终端和文件完成任务，主目录和工作区保存在单独的数据卷里。
- 客户端可以打开 Bot 电脑的实时 VNC 画面，直接用鼠标、键盘或触摸接管操作。
- Bot 也可以通过 Host 操作你自己的电脑：Mac 支持命令和图形界面控制，Windows 支持本机命令。由客户端主动连接 Host，电脑不需要开放端口。
- 内置的 `box` 也可以换成一台远程 Linux 执行节点，在管理页「执行环境」配置。

### 多端接力与通知

- 对话和设置都保存在 Host 上，所有客户端连接同一个 Host。在电脑上布置的任务，可以在手机或浏览器上接着看、接着回复。
- 会话列表可以按最后一条消息的时间排列并分组：桌面端和网页版分为「待处理」「未读」「已读」三组，Android 另有「进行中」一组。
- 通知渠道：
  - iOS 可以用 APNs 或 Bark；
  - Android 客户端和 Host 保持连接，也可以改用 ntfy、UnifiedPush、FCM 或 Webhook；
  - 网页版在页面打开时使用浏览器通知。
- 通知频率可以选「每条回复」或「仅任务完成」。

### 自选模型

- 支持三种接口格式：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages，兼容这些格式的服务都能接入。
- 用「模型服务」和「模型档案」管理多个服务商和模型。默认路由和单个 Bot 的路由可以分别指定模型、思考强度和备用顺序，每条路由最多 8 个备用。
- 主模型还没输出内容时，如果遇到 402、408、429、5xx 或网络错误，会按顺序切换到下一个备用；一旦开始输出就不再切换，避免重复输出和重复执行工具。
- 在管理页或客户端里都可以读取模型列表、测试连接。在客户端修改模型配置，需要用管理员密码配对的设备。
- 可选的 JEV 智能路由会按任务难度自动选模型档案，需要 JEV 服务的 API Key，默认关闭。

### 图片与视频生成

- 在管理页「图片与视频」接入服务商：OpenAI 兼容的图片和视频接口、WaveSpeed，或自定义的 HTTP JSON 接口。
- 图片生成、视频生成、视频理解和视频审核可以分别设置默认模型。生成结果以附件形式发回对话。
- 需要自己配置服务商的 API Key。

### 语音对话

- 语音识别：Fish Audio 或 OpenAI 兼容的转写服务，Mac 也可以用本地模型。
- 语音通话：使用当前 Bot 的模型、上下文和工具，识别和合成分别接你配置的服务。
- 实时通话目前是实验功能。

### 定时任务

- Host 内置本地计时器，按 cron 规则触发 Bot 的例行任务，不依赖外部调度服务。
- 同一个任务同时只运行一次，错过的时间点合并成一次补跑。

### Webhook

- 在管理页「Webhook」为指定 Bot 创建触发入口，填写任务模板，可以按事件类型过滤，并设置每分钟调用上限。
- 请求用 HMAC-SHA256 签名校验，时间窗为 ±5 分钟。请求地址和签名密钥只在创建时显示一次，之后可以重置。
- 每次触发都会留下运行记录。

### 自动审查与审批卡片

- Bot 执行有风险的操作前，由你配置的模型按原版的分类规则判断能否执行。覆盖的操作包括 Shell 命令、MCP 调用、电脑操作、写入定时任务和启动子 Agent。允许和拦截规则可以自己写。
- 被拦截的操作以原生审批卡片的形式出现，由你决定拒绝还是放行。卡片默认 30 分钟后过期，时长由 `ROKBOT_AUTO_REVIEW_APPROVAL_TTL_MS` 控制。
- 自动审查在客户端设置中开启。

### 用量统计

- 按模型记录输入、输出、缓存读写和推理 Token。
- 管理页「概览」和客户端设置提供今天（按小时）、近 7 天和近 30 天（按天）的用量图表，以及模型占比、明细和缓存命中率。

### 自托管部署与网络

- 预构建镜像发布在 GitHub Container Registry（GHCR），和本仓库一样需要访问权限；一个脚本完成配置、拉取镜像和启动。也支持离线安装和从源码构建镜像。
- Host 镜像支持 `linux/amd64` 和 `linux/arm64`。执行桌面 `box` 只有 `linux/amd64` 镜像，ARM 主机需要开启 binfmt/QEMU 或 Rosetta。
- 管理页（`18080`）和网页版（`18081`）默认只监听 `127.0.0.1`，监听地址由 `ROKBOT_LISTEN_ADDRESS` 设置。
- 不需要注册云端账号。设备用 6 位一次性配对码登录（5 分钟内有效），也可以用管理员密码登录。
- 局域网内可以用 IP 地址直连，Android 客户端还能扫描局域网里的 Host。
- 外网访问可以用内置的 Tailcat 加密组网（不需要 Tailscale 账号），也可以用 Tailscale 或 HTTPS 反向代理。
- 客户端更新：
  - 在管理页「客户端更新」发布各端安装包；
  - Android 和桌面端支持增量补丁，桌面端的更新清单用 ECDSA P-256 签名；
  - iOS 支持 `itms-services`（需要 HTTPS）和 AltStore / SideStore 源。
- 隐私：
  - API Key 只写不读，管理接口只返回「是否已设置」，Key 保存在 Host 数据卷的 `/data/model.env`；
  - Host 和各端客户端的遥测与错误上报都已关闭。

## 界面截图

截图来自加载演示数据的 RokBot Host 和原生客户端，不含真实账号。

### Android 客户端

会话列表、聊天、Bot 详情和审批卡片见页首，这里是其余界面。

<table>
  <tr>
    <td align="center"><img src="docs/images/rokbot-android-question-card.png" width="190" alt="Android 对话中的选项问题卡片" /><br /><sub>问题卡片</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-usage.png" width="190" alt="用量页：今日 Token、请求数、缓存命中率和按小时用量" /><br /><sub>用量</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-models.png" width="190" alt="模型设置：模型服务和模型档案" /><br /><sub>模型设置</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-settings.png" width="190" alt="设置页：用量、时区、Bot 电脑和通知" /><br /><sub>设置</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/rokbot-android-pairing.png" width="190" alt="连接页：Host 地址、局域网扫描和六位配对码" /><br /><sub>连接 Host</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-connection.png" width="190" alt="连接与诊断：当前连接、连接记录和头像风格" /><br /><sub>连接与诊断</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-share.png" width="190" alt="从系统分享面板把内容发给指定 Bot" /><br /><sub>系统分享</sub></td>
    <td align="center"><img src="docs/images/rokbot-android-about.png" width="190" alt="设置页底部的应用版本和更新状态" /><br /><sub>关于与更新</sub></td>
  </tr>
</table>

### 桌面端

桌面客户端（macOS、Windows）与网页版使用同一套界面，以下两张为桌面布局。

| 会话列表与对话 | Bot 的电脑：实时桌面画面 |
| --- | --- |
| <img src="docs/images/rokbot-web-desktop.png" width="420" alt="桌面布局：会话按待处理、未读、已读分组，右侧是运维助手的巡检结果" /> | <img src="docs/images/rokbot-client-live-vnc.png" width="420" alt="对话旁边显示 Bot 电脑的实时画面" /> |

### 管理页

| 概览与用量 | 对话模型与路由 |
| --- | --- |
| <img src="docs/images/rokbot-admin-overview.png" width="420" alt="管理页概览：今日按小时、按模型的 Token 用量" /> | <img src="docs/images/rokbot-admin-models.png" width="420" alt="管理页对话模型：模型服务、模型档案、默认路由和备用模型" /> |
| **图片与视频** | **语音** |
| <img src="docs/images/rokbot-admin-media.png" width="420" alt="管理页图片与视频：默认模型、服务商和模型列表" /> | <img src="docs/images/rokbot-admin-voice.png" width="420" alt="管理页语音：语音识别和语音通话设置" /> |

Android 截图为英文界面，桌面端和管理页截图为中文界面。Android、桌面端、网页版和管理页都提供中英文界面。

## 支持平台

本仓库不提供客户端安装包。各端客户端按下表的「获取方式」取得，补丁只接受下表中的官方版本。版本以仓库中锁定的配置文件为准。

| 平台 | 形式 | 对应的官方版本 | 获取方式 | 说明 |
| --- | --- | --- | --- | --- |
| macOS | Apple Silicon 客户端 | 1.2.3 | 自行构建 / Host 分发 | [`mac/README.md`](mac/README.md) |
| Windows | x64 安装版和便携版 | 1.2.3（推荐），也接受 0.71.2 | 自行构建 / Host 分发 | [`windows/README.md`](windows/README.md) |
| 网页版 | 浏览器，可添加到主屏幕 | 界面取自 Windows 1.2.3（推荐）或 0.71.2 | 自行构建界面包，上传到自己的 Host | [`web/README.md`](web/README.md) |
| Android | 原生 APK（arm64-v8a） | 1.26.0（build 3212） | 自行构建 / Host 分发 | [`android/README.md`](android/README.md) |
| iOS | IPA，需要自备解密的原版 IPA | 1.27.0（29519），也接受 1.26.0、1.16.0 | 自行构建并签名 / Host 分发 | [`ios/README.md`](ios/README.md) |
| Linux 服务端 | Docker：`host`（amd64 / arm64）和 `box`（amd64） | Host 基线 `97658ad`（回退保留 `2bb5e41`） | 从源码构建镜像 / 拉取预构建镜像（需要访问权限） | [`host/README.md`](host/README.md) |

「自行构建」和「Host 分发」的具体做法见[获取客户端](#获取客户端)。

锁定版本的来源：`mac/patchers/desktop/supported.json`、`windows/patchers/desktop/supported.json`、`web/patchers/supported.json`、`android/recipes/manifest.json`、`ios/recipes/ios/manifest.json`、`host/recipes/host/manifest.json`。

## 快速开始

### 1. 部署 Host 和执行容器

准备一台装好 Docker（含 Compose v2）的 Linux 或 macOS 服务器。本仓库是私有仓库，匿名访问 `raw.githubusercontent.com` 会失败，所以先 clone 仓库（需要访问权限），再在本地运行安装脚本：

```bash
# 克隆仓库；已登录 GitHub CLI 时可以用 gh
gh repo clone hongfaqiu/rokbot rokbot-src
# 没有 gh 时用 git：git clone https://github.com/hongfaqiu/rokbot.git rokbot-src

mkdir rokbot && cd rokbot
bash ../rokbot-src/host/release/install-images.sh --local
```

`--local` 让脚本直接复制仓库里的 `docker-compose.images.yml` 和 `.env.images.example`，不再联网下载这两个文件。预构建镜像同样需要访问权限，拉取前先登录 GHCR，令牌需要 `read:packages` 权限：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub 用户名> --password-stdin
```

无法拉取镜像时，可以改为在服务器上从源码构建，见 [`docs/AI-INSTALL.md`](docs/AI-INSTALL.md)。

脚本依次完成以下工作：

1. 生成 `.env`（权限 0600）并填好随机密钥；
2. 拉取镜像；
3. 启动 Host 和 `box` 容器；
4. 如果 Compose 支持，等待健康检查通过；
5. 打印管理页和网页版的地址。

> [!TIP]
> - **交给 AI 部署**：把 [`docs/AGENT_DEPLOY.md`](docs/AGENT_DEPLOY.md) 发给 Claude Code、Cursor、Codex 等 AI 编程助手，它会按手册完成环境检查、部署和验收。
> - **常用参数**：
>   - 上面的命令已经带了 `--local`；去掉它，脚本会改从 `raw.githubusercontent.com` 下载模板，私有仓库下匿名访问会失败；
>   - 想先改配置再启动，用 `--prepare-only`，改完后去掉它重新运行（保留 `--local`）；
>   - 离线环境，先用 `docker load` 导入镜像，再用 `--offline`。
> - **镜像加速和代理**：在 `.env` 中设置 `ROKBOT_HOST_IMAGE` / `ROKBOT_BOX_IMAGE` 换成镜像地址，或设置 `HTTP_PROXY` / `HTTPS_PROXY`。

### 2. 初始化 Host 并连接客户端

1. 读取一次性初始化密钥：
   ```bash
   docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
   ```
2. 用浏览器打开管理页 `http://127.0.0.1:18080/admin`，输入初始化密钥，设置管理员密码（12–128 位）。
3. 连接客户端：
   - **原生客户端**：先按[获取客户端](#获取客户端)取得客户端。在管理页「设备与通知」创建 6 位配对码，在 macOS、Windows、Android 或 iOS 客户端中输入 Host 地址和配对码；也可以直接用管理员密码登录。
   - **网页版**：默认启用，地址是 `http://127.0.0.1:18081/web/`。预构建镜像不包含网页版界面包，第一次使用前需要按 [`web/README.md`](web/README.md) 生成界面包，并在管理页「网页版」上传。

### 3. 配置模型

在管理页「对话模型」（`/admin?view=model`），或用管理员密码配对的客户端设置里：

1. 添加模型服务：选择接口格式（OpenAI Chat、OpenAI Responses 或 Anthropic），填写 Base URL 和 API Key；
2. 读取模型列表，创建模型档案并测试连接；
3. 设置默认路由；需要时，为单个 Bot 单独设置路由和备用模型。

保存后就可以创建 Bot、开始对话了。

## 获取客户端

本仓库不提供现成的客户端安装包。客户端有两种获取方式：自行构建，或从你自己部署的 Host 获取。

### 方式一：自行构建

自备官方客户端安装包，用仓库里的补丁工具打补丁并签名。补丁工具先按锁定配置中的大小和 SHA-256 校验输入，不是表中的官方版本就停止。以下命令都在仓库根目录运行，命令里的路径换成你自己的文件。

桌面端和网页版省略 `--source` 时，工具会从官方下载地址获取锁定版本，同样严格校验；可以用 `ROKBOT_DESKTOP_DOWNLOAD_BASE` 换成自建的镜像源。Android 和 iOS 必须自备安装包。

| 平台 | 运行环境 | 输入 | 输出 |
| --- | --- | --- | --- |
| macOS | macOS，Node.js 22.12+ | 官方 1.2.3 Apple Silicon 的 `.dmg` 或 `Grok Bot.app` | `mac/output.noindex/RokBot.app` |
| Windows | Windows 10/11 x64，Node.js 22.12+ | 官方 1.2.3（或 0.71.2）x64 安装包、`app-64.7z` 或已安装的原版目录 | `windows/output/` |
| 网页版 | Windows、macOS 或 Linux，Node.js 22.12+ | 与 Windows 相同的官方安装包 | `web/output/RokBotLocal-web-1.2.3.zip` |
| Android | Node.js 20+ | 官方 1.26.0（build 3212）的 `.xapk`、`.apks` 或 `.apk` | `--output-apk` 指定的 APK |
| iOS | Python 3.9+ | 自己解密的官方 IPA：1.27.0（29519）、1.26.0（29388）或 1.16.0（23152） | `--output` 指定的新目录 |

#### macOS

```bash
node mac/patchers/desktop/patch.mjs --source "/path/to/Grok_Bot_1.2.3.dmg"
```

- 生成 `mac/output.noindex/RokBot.app`，原版的副本备份在 `mac/backup.noindex/RokBot.app`。输出已存在时工具不会覆盖。
- 默认使用 ad-hoc 签名。需要控制本机图形界面时加 `--identity auto`，改用钥匙串里的 Developer ID Application 或 Apple Development 证书。
- `--verify-only` 只在临时目录回放补丁，不生成客户端。详见 [`mac/README.md`](mac/README.md)。

#### Windows

```powershell
node windows/patchers/desktop/patch.mjs --source C:\path\to\Grok_Bot_1.2.3_Setup.exe
```

- 在 `windows/output/` 生成便携目录 `RokBot Local/`、`RokBotLocal-1.2.3-x64-portable.zip`、按用户安装的 `RokBotLocal-1.2.3-x64-Setup.exe`，以及补丁记录 `RokBotLocal-1.2.3-x64.patch.json`。加 `--no-installer` 只生成便携版本。
- 1.2.3 用不了时，用 `--version 0.71.2 --output windows/output/0.71.2` 改用 0.71.2，输出文件名中的版本号随之改变。
- 补丁会移除因修改而失效的原签名，生成的程序和安装包都未签名。详见 [`windows/README.md`](windows/README.md)。

#### 网页版

```bash
node web/patchers/patch.mjs --source /path/to/Grok_Bot_1.2.3_Setup.exe
```

- 生成 `web/output/RokBotLocal-web-1.2.3.zip`，在管理页「网页版」上传。也可以加 `--upload <Host 地址>` 生成后直接安装到 Host，管理员密码从 `ROKBOT_ADMIN_PASSWORD`、`--password-file` 或终端输入读取。
- 1.2.3 的界面用不了时加 `--version 0.71.2`。详见 [`web/README.md`](web/README.md)。

#### Android

```bash
node android/release/patch-android.mjs \
  --input-apk /path/to/official-1.26.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk
```

- 生成 16KB 对齐、v2/v3 签名的单个 APK，同目录写入 `patch-report.json`。输出已存在时需要加 `--force`。
- 签名密钥默认保存在 `~/.rokbot-local/android-signing.json`，第一次运行时自动创建，可以用 `--keystore` 指定。后续升级必须使用同一把密钥，请单独备份。
- 要通过 Host 发布升级包，每次构建用 `--rokbot-build <n>` 递增版本号（1–99）。详见 [`android/README.md`](android/README.md)。

#### iOS

```bash
python3 ios/release/patch-ios.py \
  --input /path/to/decrypted.ipa \
  --output ios/output/RokBot-Patched \
  --bundle-id dev.rokbot.local
```

- `--output` 必须是不存在的新目录。目录中包含未签名的 `RokBot-Local-resignable.ipa`、`RokBotLocal.dylib`、`patch-report.json`，保留扩展时还有 `extension-signing.json`。
- 用你自己的签名工具和证书签名后安装。免费 Apple ID 最多 3 个 App ID，不够为主应用和三个扩展签名，可以加 `--remove-extensions` 只保留主应用。详见 [`ios/README.md`](ios/README.md)。

### 方式二：从自己部署的 Host 获取

Host 的管理员可以把构建好的安装包发布给自己 Host 上的设备：

1. 管理员按方式一构建并签名安装包。
2. 在管理页「客户端更新」选择平台（Android、iOS、macOS 或 Windows），上传安装包并发布；需要时选择一个旧版本，生成增量补丁。
3. 已经配对的客户端从这台 Host 检查和下载更新：
   - Android 下载后核对大小、SHA-256、包名和签名证书，证书必须与已安装的版本一致；
   - macOS 和 Windows 支持增量补丁，更新清单用 ECDSA P-256 签名。客户端默认从已配对的 Host 检查更新；构建时加 `--update-url <Host 的 HTTPS 地址>/local/updates` 和 `--update-public-key-file <公钥文件>`，可以把「客户端更新」页显示的清单签名公钥固定在客户端里；
   - iOS 不能在应用内自我替换，通过 `itms-services`（需要 HTTPS）、AltStore / SideStore 源，或下载 IPA 后交给签名工具安装。

第一次安装时，客户端还没有和 Host 配对，安装包怎样交给用户由各 Host 的管理员自行决定，并由管理员负责。发布和接口的细节见 [`docs/AGENT_DEPLOY.md`](docs/AGENT_DEPLOY.md#5-发布四端签名安装包与增量自动更新)。

## 架构概览

```mermaid
flowchart LR
  subgraph Clients["客户端"]
    Desktop["macOS / Windows 客户端"]
    Mobile["iOS / Android 客户端"]
    Web["网页版 (:18081)"]
  end

  subgraph HostC["host 容器"]
    Admin["管理服务 (:18080)<br/>登录 / 配对 / 配置 / 推送 / 更新"]
    Core["原版 Host<br/>Agent / 工具 / 上下文 / 定时任务"]
    Adapter["模型适配层<br/>路由 / 备用 / 自动审查"]
    Admin --> Core --> Adapter
  end

  Desktop --> Admin
  Mobile --> Admin
  Web --> Admin
  Adapter --> Models["你的模型接口<br/>Chat / Responses / Anthropic"]
  Core --> Box["box 容器<br/>Linux 桌面 + VNC"]
  Core -.经客户端反向连接.-> PC["你的 Mac / Windows 电脑"]
  Admin --> Push["APNs / Bark / ntfy 等推送"]
  Admin <--> Tailcat["Tailcat 加密组网"]
```

- **Host**：原版 Node.js 程序，只替换和官方服务绑定的部分（身份验证、Agent 身份、模型调用、MCP 配置），外面加一层管理服务。
- **执行电脑**：官方 Linux 桌面镜像，原样运行在 Docker 里；也可以让 Agent 操作你自己的电脑。
- **客户端**：保留原版界面，补丁让它只连接你的 Host。补丁只做「复制」和「新增」两种操作，每一段都先校验原文件的哈希，不反编译、不重写原版程序。

详细设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/AGENT_DEPLOY.md`](docs/AGENT_DEPLOY.md) | 写给 AI 编程助手的部署手册：环境检查、预构建镜像部署、源码构建、首次启动、模型配置、发版与排障 |
| [`docs/AI-INSTALL.md`](docs/AI-INSTALL.md) | 用 `host/deploy.py` 部署：机器选择、分机部署、日常运维、数据卷备份与恢复 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 原理、功能对照、各部分实现、目录结构、测试与已知限制 |
| [`docs/PATCHING_WORKFLOW.md`](docs/PATCHING_WORKFLOW.md) | 各平台补丁的适配基线和维护流程 |
| [`docs/REBRAND_COMPAT.md`](docs/REBRAND_COMPAT.md) | 重命名对照：环境变量、接口标识和旧环境迁移（英文） |
| [`tests/e2e/README.md`](tests/e2e/README.md) | 黑盒端到端测试套件的运行方法 |
| [`SECURITY.md`](SECURITY.md) | 漏洞报告方式和部署安全建议 |

## 常见问题

**没有公网 IP，怎么在外面访问？**

在管理页「远程访问」开启内置的 Tailcat，不需要 Tailscale 账号；也可以用 Tailscale、VPN 或 HTTPS 反向代理。网页版不支持 Tailcat，外网使用网页版请用 VPN 或 HTTPS 域名。不要把管理页直接暴露到公网，见 [`SECURITY.md`](SECURITY.md)。

**为什么手机在局域网里连不上 Host？**

`ROKBOT_LISTEN_ADDRESS` 默认是 `127.0.0.1`，只有本机能访问。局域网使用时，把它改成服务器的局域网 IP（或在防火墙后用 `0.0.0.0`）。注意，Docker 发布的端口会绕过 ufw 等主机防火墙。

**ARM 服务器能部署吗？**

能。Host 镜像支持 `linux/arm64`；执行桌面 `box` 只有 `linux/amd64` 镜像，需要在宿主机开启 binfmt/QEMU，Apple Silicon 上可以用 Rosetta。

**为什么仓库里没有客户端安装包？**

本仓库只分发本项目自己编写的代码和文档，不包含原版程序文件，也不提供打过补丁的安装包。你可以自备官方安装包，用补丁工具在本机构建；也可以从自己 Host 的管理员那里获取，管理员在管理页「客户端更新」发布。两种方式见[获取客户端](#获取客户端)，原因见[分发与合规说明](#分发与合规说明)。

**API Key 存在哪里？会被读出来吗？**

API Key 保存在 Host 数据卷的 `/data/model.env`。管理接口和客户端只能看到「是否已设置」，读不到 Key 本身。

**怎么备份数据？**

数据在 `host-data`（挂载为 `/data`）、`box-home` 和 `box-workspace` 三个数据卷里。用 `host/deploy.py` 部署时，可以运行 `python3 host/deploy.py backup`，恢复步骤见 [`docs/AI-INSTALL.md`](docs/AI-INSTALL.md#volume-recovery)。备份里有对话记录和 Key，请妥善保管。不要运行 `docker compose down -v`，它会删除数据卷。

## 分发与合规说明

- 本项目不分发第三方客户端的二进制文件。仓库中只有本项目自己编写的 Host 源码、镜像构建脚本、补丁工具、构建脚本和文档；原版安装包需要使用者自行取得。
- 补丁工具仅供个人学习和自托管使用。[LICENSE](LICENSE) 允许的非商业分发只适用于本项目自己的代码，不涵盖原版程序的任何内容。
- 使用原版客户端及其补丁时，请遵守原客户端的许可条款和相关服务条款。
- 用补丁工具生成的客户端、网页版界面包和内置界面包的镜像，只用于你自己的 Host，请勿公开传播。通过 Host 分发安装包时，渠道和使用范围由该 Host 的管理员负责。
- 以上说明不构成法律意见。具体能否使用，请以原客户端的许可条款和你所在地区的法律为准。

## 许可证

RokBot 使用 [ProkBot Noncommercial License 1.0](LICENSE)。允许个人使用、自托管、学习、修改和非商业分发；禁止任何商业用途，包括出售或付费授权、付费托管和付费服务、集成到商业产品、企业内部使用，以及通过广告等方式变现。完整条款以 [LICENSE](LICENSE) 为准，衍生关系和第三方组件见 [NOTICE](NOTICE)。

本项目基于 [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) 和 [ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus) 开发，并受到 `rakazo` 在自托管部署方面工作的启发，在此致谢。

## 友情链接

- [LINUX DO](https://linux.do)

## 免责声明

RokBot 是独立的开源项目，与 xAI、Grok Bot 及 Cursor / Anysphere 没有任何关联，也未获得其认可。Grok、Grok Bot 及相关名称和标志归各自的权利人所有。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
