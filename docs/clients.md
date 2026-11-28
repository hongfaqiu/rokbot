# 支持平台与获取客户端

[返回首页](../README.md) · [English](clients.en.md) · [部署指南](deployment.md) · [补丁维护流程](PATCHING_WORKFLOW.md) · [常见问题](faq.md)

本仓库只包含本项目自己编写的部分：Host 源码、镜像构建脚本、各平台的补丁工具和构建脚本，以及文档；不包含、也不分发任何原版程序文件或客户端安装包。客户端可以用补丁工具自行构建，也可以从你自己部署的 Host 获取。

## 支持平台

本仓库不提供客户端安装包。各端客户端按下表的「获取方式」取得，补丁只接受下表中的官方版本。版本以仓库中锁定的配置文件为准。

| 平台 | 形式 | 对应的官方版本 | 获取方式 | 说明 |
| --- | --- | --- | --- | --- |
| macOS | Apple Silicon 客户端 | 1.3.0（推荐），也接受 1.2.3 | 自行构建 / Host 分发 | [`mac/README.md`](../mac/README.md) |
| Windows | x64 安装版和便携版 | 1.3.0（推荐），也接受 1.2.3、0.71.2 | 自行构建 / Host 分发 | [`windows/README.md`](../windows/README.md) |
| Linux | x64 / arm64 `.deb`、`.tar.gz` 与便携目录 | 1.3.0 | 自行构建 / Host 分发 | [`linux/README.md`](../linux/README.md) |
| 网页版 | 浏览器，可添加到主屏幕 | 界面取自 Windows 1.3.0（推荐），也接受 1.2.3、0.71.2 | 自行构建界面包，上传到自己的 Host | [`web/README.md`](../web/README.md) |
| Android | 原生 APK（arm64-v8a） | 1.26.0（build 3212） | 自行构建 / Host 分发 | [`android/README.md`](../android/README.md) |
| iOS | IPA，需要自备解密的原版 IPA | 1.27.0（29519），也接受 1.26.0、1.16.0 | 自行构建并签名 / Host 分发 | [`ios/README.md`](../ios/README.md) |
| Linux 服务端 | Docker：`host`（amd64 / arm64）和 `box`（amd64） | Host 基线 `2bb5e41` | 从源码构建镜像 / 拉取预构建镜像（需要访问权限） | [`host/README.md`](../host/README.md) |

「自行构建」和「Host 分发」的具体做法见下方[获取客户端](#获取客户端)。

锁定版本的来源：`mac/patchers/desktop/supported.json`、`windows/patchers/desktop/supported.json`、`linux/patchers/desktop/{x64,arm64}/supported.json`、`web/patchers/supported.json`、`android/recipes/manifest.json`、`ios/recipes/ios/manifest.json`、`host/recipes/host/manifest.json`。

## 获取客户端

本仓库不提供现成的客户端安装包。客户端有两种获取方式：自行构建，或从你自己部署的 Host 获取。

### 方式一：自行构建

自备官方 Grok Bot 客户端安装包，用仓库里的补丁工具打补丁并签名。补丁工具先按锁定配置中的大小和 SHA-256 校验输入，不是表中的官方版本就停止。以下命令都在仓库根目录运行，命令里的路径换成你自己的文件。

桌面端和网页版省略 `--source` 时，工具会从官方下载地址获取锁定版本，同样严格校验；可以用 `ROKBOT_DESKTOP_DOWNLOAD_BASE` 换成自建的镜像源。Android 和 iOS 必须自备安装包。

| 平台 | 运行环境 | 输入 | 输出 |
| --- | --- | --- | --- |
| macOS | macOS，Node.js 22.12+ | 官方 1.3.0（或 1.2.3）Apple Silicon 的 `.dmg` 或 `Grok Bot.app` | `mac/output.noindex/RokBot.app` |
| Windows | Windows 10/11 x64，Node.js 22.12+ | 官方 1.3.0（或 1.2.3、0.71.2）x64 安装包、`app-64.7z` 或已安装的原版目录 | `windows/output/` |
| Linux | Linux 或 macOS，Node.js 22.12+ | 官方 1.3.0 Linux x64 / arm64 `.deb` 或解压目录 | `linux/output/`（便携目录、`.tar.gz`、`.deb`） |
| 网页版 | Windows、macOS 或 Linux，Node.js 22.12+ | 与 Windows 相同的官方安装包 | `web/output/RokBotLocal-web-1.3.0.zip` |
| Android | Node.js 20+ | 官方 1.26.0（build 3212）的 `.xapk`、`.apks` 或 `.apk` | `--output-apk` 指定的 APK |
| iOS | Python 3.9+ | 自己解密的官方 IPA：1.27.0（29519）、1.26.0（29388）或 1.16.0（23152） | `--output` 指定的新目录 |

#### macOS

```bash
node mac/patchers/desktop/patch.mjs --source "/path/to/Grok_Bot_1.3.0.dmg"
```

- 生成 `mac/output.noindex/RokBot.app`，原版的副本备份在 `mac/backup.noindex/RokBot.app`。输出已存在时工具不会覆盖。
- 默认使用 ad-hoc 签名。需要控制本机图形界面时加 `--identity auto`，改用钥匙串里的 Developer ID Application 或 Apple Development 证书。
- `--verify-only` 只在临时目录回放补丁，不生成客户端。详见 [`mac/README.md`](../mac/README.md)。

#### Windows

```powershell
node windows/patchers/desktop/patch.mjs --source C:\path\to\Grok_Bot_1.3.0_Setup.exe
```

- 在 `windows/output/` 生成便携目录 `RokBot Local/`、`RokBotLocal-1.3.0-x64-portable.zip`、按用户安装的 `RokBotLocal-1.3.0-x64-Setup.exe`，以及补丁记录 `RokBotLocal-1.3.0-x64.patch.json`。加 `--no-installer` 只生成便携版本。
- 1.3.0 用不了时，可用 `--version 1.2.3` 或 `--version 0.71.2` 回退，输出文件名中的版本号随之改变。
- 补丁会移除因修改而失效的原签名，生成的程序和安装包都未签名。详见 [`windows/README.md`](../windows/README.md)。

#### Linux

```bash
# 首次构建前安装共享依赖
npm install --prefix mac/patchers/desktop

# 自动下载锁定版本的官方 1.3.0 .deb 并构建（支持在 Linux 或 macOS 跨平台生成 .deb 与 .tar.gz）
node linux/patchers/desktop/patch.mjs --arch x64   # 或 --arch arm64

# 也可使用本地官方 .deb（自动按 SHA-256 识别架构），或加 --verify-only 仅校验
node linux/patchers/desktop/patch.mjs --source /path/to/grok-bot_1.3.0_amd64.deb
```

- 在 `linux/output/` 生成便携目录 `RokBotLocal-1.3.0-linux-<arch>/`、通用便携包 `RokBotLocal-1.3.0-linux-<arch>.tar.gz`、Debian/Ubuntu 安装包 `RokBotLocal-1.3.0-linux-<arch>.deb`（已移除上游 apt 源注册，安装到 `/opt/RokBot/rokbot`）以及补丁记录 `RokBotLocal-1.3.0-linux-<arch>.patch.json`。
- 支持在 Linux 或 macOS 上跨平台生成 `.deb` 与 `.tar.gz`，无需安装 `dpkg-deb`。详见 [`linux/README.md`](../linux/README.md)。

#### 网页版

```bash
node web/patchers/patch.mjs --source /path/to/Grok_Bot_1.3.0_Setup.exe
```

- 生成 `web/output/RokBotLocal-web-1.3.0.zip`，在管理页「网页版」上传。也可以加 `--upload <Host 地址>` 生成后直接安装到 Host，管理员密码从 `ROKBOT_ADMIN_PASSWORD`、`--password-file` 或终端输入读取。
- 1.3.0 的界面用不了时加 `--version 1.2.3` 或 `--version 0.71.2`。详见 [`web/README.md`](../web/README.md)。

#### Android

```bash
node android/release/patch-android.mjs \
  --input-apk /path/to/official-1.26.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk
```

- 生成 16KB 对齐、v2/v3 签名的单个 APK，同目录写入 `patch-report.json`。输出已存在时需要加 `--force`。
- 签名密钥默认保存在 `~/.rokbot-local/android-signing.json`，第一次运行时自动创建，可以用 `--keystore` 指定。后续升级必须使用同一把密钥，请单独备份。
- 要通过 Host 发布升级包，每次构建用 `--rokbot-build <n>` 递增版本号（1–99）。详见 [`android/README.md`](../android/README.md)。

#### iOS

```bash
python3 ios/release/patch-ios.py \
  --input /path/to/decrypted.ipa \
  --output ios/output/RokBot-Patched \
  --bundle-id dev.rokbot.local
```

- `--output` 必须是不存在的新目录。目录中包含未签名的 `RokBot-Local-resignable.ipa`、`RokBotLocal.dylib`、`patch-report.json`，保留扩展时还有 `extension-signing.json`。报告中的 `dylibSha256` 是 IPA 内（与同目录）实际交付、已去除签名的 `RokBotLocal.dylib` 的摘要，`sourceDylibSha256` 是输入库的摘要（即 manifest 固定值）。
- 用你自己的签名工具和证书签名后安装。免费 Apple ID 最多 3 个 App ID，不够为主应用和三个扩展签名，可以加 `--remove-extensions` 只保留主应用。详见 [`ios/README.md`](../ios/README.md)。

### 方式二：从自己部署的 Host 获取

Host 的管理员可以把构建好的安装包发布给自己 Host 上的设备：

1. 管理员按方式一构建并签名安装包。
2. 在管理页「客户端更新」选择平台（Android、iOS、macOS、Windows 或 Linux），上传安装包并发布；需要时选择一个旧版本，生成增量补丁。
3. 已经配对的客户端从这台 Host 检查和下载更新：
   - Android 下载后核对大小、SHA-256、包名和签名证书，证书必须与已安装的版本一致；
   - macOS、Windows 和 Linux 支持增量补丁，更新清单用 ECDSA P-256 签名。客户端默认从已配对的 Host 检查更新；构建时加 `--update-url <Host 的 HTTPS 地址>/local/updates` 和 `--update-public-key-file <公钥文件>`，可以把「客户端更新」页显示的清单签名公钥固定在客户端里；
   - iOS 不能在应用内自我替换，通过 `itms-services`（需要 HTTPS）、AltStore / SideStore 源，或下载 IPA 后交给签名工具安装。

第一次安装时，客户端还没有和 Host 配对，安装包怎样交给用户由各 Host 的管理员自行决定，并由管理员负责。发布和接口的细节见 [`docs/AGENT_DEPLOY.md`](AGENT_DEPLOY.md#5-发布四端签名安装包与增量自动更新)，合规说明见 [`docs/faq.md`](faq.md#分发与合规说明)。
