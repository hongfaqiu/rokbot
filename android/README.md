# RokBot Android 原生补丁器 (`android/`)

[English](README.en.md)

本目录提供参考 `ios/`（`RBBootstrap.m` + `patch-app.py`）架构的 **官方 Android React Native `.apk` / `.xapk` / `.apks` 补丁器**（目标包名 `ai.x.grok.bot`，亦兼容 `co.anysphere.sand`，对齐官方 `1.26.0` / build `3212`）：完整保留官方 RN 客户端原生的 Bot 列表、对话、语音通话界面、连接器市场、搜索与设置 UI/交互，零自制主界面重写、零悬浮工具栏劫持，仅注入轻量化 Native Companion 运行时（Companion DEX + 16KB 对齐 Tailcat `.so` + Hermes 字节补丁 + `assets/logo/android/mipmap-*` RokBot 图标替换）及与 iOS 对齐的 6 个原生模态页面、系统分享面板接收与后台通知服务。

> 仅限非商业、授权开发/学习/自建部署用途。请勿在任何提交或日志中包含密钥、配对码、密码或私人 Host 地址。

## 核心能力

- **官方 Split XAPK/APKS 合并与 Google Play Pairip 去校验**
  - **多分包合并 (`xapk.mjs` & `arsc.mjs`)**：纯 Node.js 解包官方 `.xapk` / `.apks` / `.apk`，剥离 `libpairipcore.so`，合并基础包、`arm64-v8a` 原生库与密度/语言分包的 `resources.arsc` 与资源文件，替换 RokBot 桌面/启动器 `mipmap-*` 图标，并把系统启动图（`drawable/splashscreen_logo`，官方只有 108px mdpi 位图，被放大成模糊的第一屏）换成 `assets/logo/android/splash/` 的清晰 RokBot 图标：与 RN 启动页 launch-mark 同为居中 64dp 圆角方块，补 xxxhdpi（含夜间）配置，动画 WebP 让系统启动页按原分辨率绘制，启动全程只有一个清晰 logo；输出单一通用签名 APK（推荐 `android/output/rokbot-android-patched.apk`）。
  - **Pairip 防篡改中和 (`pairip-dex.mjs`, `pairip-elf.mjs`, `PairipVmBridge`, `RokBotAppComponentFactory`)**：中和 Pairip DEX 签名/授权校验并接管 `VMRunner` 调度，清理原生 `.so` 的 `DT_NEEDED libpairipcore.so`、`DT_INIT` 跳板、`ExecuteProgram` 重定位与固定 `.data` 加密区，并移除清单中的 Pairip 与 Play 分包元数据。被 Pairip 虚拟化的 Activity 生命周期方法由 `PairipActivityPorts` 按上游源码移植执行（expo-video 全屏页的 onCreate/onPause/onDestroy、expo-web-browser `BrowserProxyActivity`、CanHub 裁剪页、Play Core 对话框、Braze WebView），不会只调 `super`；RokBot 用不到的 Play 计费与 Google 登录页返回 `RESULT_CANCELED` 并立即关闭。
- **安全配对与多传输连接 (`PairingActivity`)**
  - 支持直接填写 `http://` / `https://` 地址、**6 位配对码 / 管理员密码**切换、**局域网 / mDNS (`_rokbot._tcp.`) 自动扫描**，以及内置 **Tailcat 加密隧道（`tailcat://connect/...`）**。
  - 原生封装 `arm64-v8a` `libgroktailcat.so` + `libgroktailcatjni.so`（强制 **16KB 页对齐**，兼容 Android 15/16；因预编译 JNI 二进制导出 `Java_dev_grokbot_local_TailcatBridge_*` 符号且仓库不含其 C JNI 源码，`dev.grokbot.local.TailcatBridge` 与该组预编译 `.so` 文件名作为二进制 ABI 兼容层保留），支持自动重连、健康探测与网络切换恢复。
  - 设备凭证与 Tailcat 节点身份均通过 **Android Keystore (`AES/GCM/NoPadding`)** 硬件级加密存储。
- **完全对齐 iOS `RBBootstrap` 的 6 个原生界面（无自制主界面、无悬浮工具栏劫持）**
  - 保留官方 RN 主启动器 `MainActivity` 及原版 Bot 列表 / 对话 / 语音 / 连接器 UI，仅拦截对应 iOS `RBBootstrap.m` 的 6 个入口：
    1. **连接 / 登录 (`PairingActivity`)**：对齐官方 Connect UI（`connect.html`）与 iOS `RBConnection.m`。
    2. **个人资料 (`ProfileActivity`)**：点击设置页头像/账户行进入，只保留头像、昵称、保存资料与移除头像（外观与语言用设置首页的官方行，增量更新在「应用更新」页）。RN 界面中原版写死的合成用户 `dev-gateway@localhost` 会被替换为 Host 用户资料（`GET /local/profile`，由 `HostProfile` 管理）：设置页账户行与侧栏 `SidebarIdentityBar` 的文字显示 `displayName`（设置页第二行显示 `hostName`），`dev-gateway@localhost avatar` 头像通过父视图的 ViewGroupOverlay 叠加 `avatarDataUrl`（无头像时显示首字母），覆盖层不拦截点击。资料缓存在 `profileCache`，冷启动先用缓存显示；连上 Host、RN 回到前台（onResume）以及 `ProfileActivity` 保存后会重新拉取。尚未拿到资料时文字回退为 Host 地址。
    3. **通知设置 (`PushSettingsActivity`)**：支持测试推送、UnifiedPush / ntfy / Webhook / FCM 配置。
    4. **Bot 资料库 (`LibraryActivity`)**：通过 `NetworkInterceptor` 自动追踪 `/api/openAgentWindowed`、`/api/getAgentTranscriptTail`、`/api/getAgentTranscript` 与 `/api/sendPrompt` 中的当前 `agentId`，按 Bot 管理文件上传、预览与删除。
    5. **Bot 电脑 (`ComputersActivity` & `ComputerViewerActivity`)**：查询 `/api/getForeverBoxStatus`、唤醒 `/api/ensureForeverBox` 并通过内置回环代理加载交互式 noVNC 桌面。
    6. **用量统计 (`UsageActivity`)**：展示 Host 当日 Token 用量统计。
- **后台通知、深链接、语音、系统分享与 Hermes 补丁**
  - **后台推送 (`NotificationService` & `PushManager`)**：前台服务常驻长连接 SSE（`/notifications/events`），支持 256 条游标去重、系统通知栏推送，点击通知或外部深链接自动将 `rokbot-local://agent/<id>` 规范化为官方 RN `grokbot://app/v1/chat?id=<id>` 并拉起主 `MainActivity`（对齐 iOS `RBDeepLinks.m`）。
  - **网络与语音兼容层 (`R8OkHttpHook`, `R8OkHttpInterceptor`, `LegacyOkHttpHook`, `NetworkInterceptor` & `VoiceManager`)**：Hook R8 混淆 OkHttp 工厂（`t8.f` / `Ae.k`）与传统 `OkHttpClientProvider`；拦截遥测上报（Sentry、Braze、AppsFlyer、Statsig 及 `/aiserver.v1.AnalyticsService/*`）；重定向 API/WebSocket、`/aiserver.v1.AiService/TranscribeAudio` -> `/local/audio/transcriptions`、`/aiserver.v1.AiService/TextToSpeech` -> `/local/audio/speech`（语音消息播放）、`/aiserver.v1.AiService/RunGenerateImage` -> `/local/avatar/generate`（Bot 头像页「生成」）、`/aiserver.v1.GrokBotService/MintSandVoiceCallSecret` -> `/local/voice/session`、`/local/app-intents/*`、`/local/mobile-rpc/*` 及 SkillSheet 发布（`https://rokbot.local/skill-publication`）；提供 24kHz PCM + 硬件 `AcousticEchoCanceler` / `NoiseSuppressor` 原生音频支持。
  - **Hermes 运行时 (`HermesPatcher` & `hermes.mjs`)**：匹配固定 HBC 指纹时应用 `recipes/*.gbp.gz` 字节补丁，注入 `assets/recipes/{unpaired.hbc,gateway-template.hbc,gateway-template.json}`（并在需要时注入 `assets/recipes/pairip-strings.json`），禁用 Expo Updates，并 Hook `ReactNativeHost` 与 New Architecture `ReactHost`。
  - **设置首页 rokbot 分组 (`hermes-settings.mjs` `applySettingsMenu`)**：账号卡片正下方的第一组，标题 `rokbot`，依次为「Bot 图标样式」（`AvatarStyleActivity`）、官方「外观」「语言」「用量」行（从原分组移入，不重复出现）、「模型配置」（`ModelsActivity`）、「连接与诊断」（`PairingActivity`，只保留连接相关内容）、「应用更新」（`UpdateActivity`）。行由 Hermes 字节码原地改写生成（与官方行同一 `InsetGroup` / `InsetGroupNavRow` 组件），每次渲染重建以显示官方行的当前取值。配对后原生页面的语言和深浅色跟随官方「语言」「外观」的选择；配对页右上角的语言/主题开关只在未配对时显示。
  - **App 内更新 (`AppUpdater`, `UpdateActivity`, `UpdateManager` & `ApkUpdateProvider`)**：走已配对 Host 的 Android 更新通道（`GET /local/updates/android.json`，设备 Bearer 鉴权，`rokbot-android-native-update/v1`）。App 冷启动和每次回到前台时自动检查，成功后 6 小时内不再检查（失败 30 分钟后重试）；只有清单 `versionCode` 严格大于已安装版本才算新版本，弹窗显示版本号与更新说明，可选“立即更新”或“稍后”。下载到 App 私有目录 `files/updates/`，校验大小、SHA-256、包名、签名证书（与当前 App 不一致即拒绝）和 versionCode，再通过 `ApkUpdateProvider` 的 `content://` URI 以 `ACTION_VIEW` 交给系统安装器；未授予“安装未知应用”时先引导到该开关，返回后自动继续。升级后首次启动提示“已更新到 …”并删除暂存安装包。RN 设置页底部的版本号行显示“· 已是最新版本 / · 有新版本”，点击进入 `UpdateActivity`；设置首页 rokbot 分组的「应用更新」行和官方的“更新到最新版本”入口也进入同一页面（页内另有手动 `RBDELTA1` 增量更新卡片：更新清单地址、检查增量更新，兼容读取旧版 `GBDELTA1`），不再跳转应用商店。Host 端发布方式见 `docs/AGENT_DEPLOY.md` 第 5 节。
  - **Bot 动态图标与 RokBot logo (`RokBotAvatarManager`, `RokBotAvatarDrawable`, `RokBotAvatarShapes`, `RokBotAvatars`, `RokBotLogo`, `BundleAssets`)**：「设置首页 › Bot 图标样式」（`AvatarStyleActivity`）选择的样式（机甲灵偶 / 双天线波波 / 赛博护目镜 / 像素精灵 / 流体光球 / 官方原版）作用于 RN 里所有 Bot 图标：Bot 列表与分组、对话页顶部标题、Bot 详情、编辑 Bot 与头像预览、头像形状选择器、「创建新 Bot」的预览与形状格子、搜索结果、对话里的“处理中”标记。识别依据是官方自带的 testID（`still-avatar-body` / `still-avatar-eyes`）、“<shape> character shape” 无障碍标签和动画头像的光晕几何；从官方 SVG 采样每个 Bot 的颜色与精确轮廓，画在宿主视图的 ViewGroupOverlay 上，官方视图只设为 INVISIBLE，不向 RN 视图树插入子视图；选“官方原版”即全部还原。系统分享面板的 Bot 列表和通知大图标用同一样式（形状与颜色取自 `/api/listAgents`，内置官方 1.26.0 的 13 种形状轮廓）。App logo：配对页、软件更新页、RN 关于页 / 启动页标记（`about-mark`、`launch-mark` 等）与通知小图标都画 `assets/logo/rokbot-logo.svg` 的同一几何；RN 内的 App 图标资源 `res/raw/assets_appicon_*.svg` 换成 `assets/logo/rokbot-app-icon.svg`；RN 打包的图片、SVG、音效会复制到文件 bundle 旁（`RokBotPaired` / `RokBotUnpaired`），此前这些资源在配对后无法加载。
  - **系统分享面板接收 (`ShareTargetActivity`)**：支持 `ACTION_SEND` / `ACTION_SEND_MULTIPLE` 直接分片上传并发给指定 Bot，完成后通过规范化深链接返回对话页。

## 目录结构

```text
android/
├── bin/
│   ├── classes2.dex                   # 编译好的 Companion DEX（注入目标 APK 顺序下一槽位，如 1.26.0 中的 classes6.dex）
│   ├── rokbot-native-base.apk         # 轻量 RN 补丁器测试基准 APK
│   └── jniLibs/arm64-v8a/             # 预编译 Tailcat Go Mobile JNI 动态库
├── companion/                         # 原生 Java Companion 源码、compile-stubs 与 build.sh
├── patchers/                          # 纯 Node AXML、ARSC、XAPK/APKS 合并、Pairip DEX/ELF 去校验、DEX/JNI、Hermes(HBC/bytepatch)、16KB Zipalign 与 APK v2/v3 签名器
├── recipes/                           # 固定包指纹（1.26.0 / 3212）、.gbp.gz Hermes 字节补丁及 Pairip ELF/字符串配方
├── release/                           # CLI 自动化补丁入口（patch-android.mjs 与 Python 包装 patch-android.py）
├── test-target/                       # 轻量 RN 基准目标 APK 构建脚本
├── tests/ & adversarial/              # 单元测试、MockHost 协议测试、对抗测试与模拟器 E2E
└── output/                            # 默认签名 APK 输出目录（rokbot-android-patched.apk 与 patch-report.json）
```

## 快速开始

### 前置依赖

- Node.js `>= 20`（运行 `patch-android.mjs` 仅依赖 Node.js）
- 可选（仅重编 `companion/build.sh`、`test-target/build-base.sh` 或运行 JVM/模拟器测试时需要）：
  - JDK 17+（`javac`、`jar`）
  - Android SDK（`platforms/android-36/android.jar`、`build-tools` 中的 `d8`/`aapt2`/`apksigner` 及 `platform-tools/adb`）

### 对官方 Android React Native APK / XAPK 执行补丁

```bash
# 如修改了 companion/ 原生代码，可先重新编译 classes2.dex
bash android/companion/build.sh

# 对官方 1.26.0 .xapk / .apks / .apk 执行补丁并输出到 output/rokbot-android-patched.apk
node android/release/patch-android.mjs \
  --input-apk /path/to/grok-bot-1.26.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk \
  --force
```

官方安装包需要自备，本仓库不提供原版或补丁后的 APK。生成的 APK 只给自己的设备用，或由 Host 管理员在管理页「客户端更新」发布，已安装的客户端会通过 Host 的 Android 更新通道收到更新，见[获取客户端](../docs/clients.md#获取客户端)。

常用 CLI 参数：

- `--input-apk <path>`（别名 `--input`、`--apk`）：官方 React Native `.xapk` / `.apks` / `.apk`（`ai.x.grok.bot` / `co.anysphere.sand` `1.26.0`）
- `--output-apk <path>`（别名 `--output`）：输出 16KB 对齐并 v2/v3 签名后的 APK 路径（非 `--verify-only` 时必填；每次补丁都会在同目录写入 `patch-report.json`）
- `--package-name <id>`（别名 `--bundle-id`）：重写 Android 包名 / `applicationId`（保留原 `MainActivity` 全限定名并自动重写 `provider.authorities` 与自定义权限前缀）
- `--host <url>`：预置 Host 地址（`http://...`、`https://...` 或 `tailcat://connect/<node>?port=<port>`）
- `--pairing-code <code>`（别名 `--pairing-key`）：预置 6 位配对码（大写字母数字，不含 `I`/`O`/`1`/`0`）
- `--rokbot-build <n>`：RokBot 发布序号（1-99）。`versionCode = 上游 versionCode × 100 + n`（1.26.0 的 3212 → 321201、321202…；上游升到 3213 后从 321301 继续，仍然更大），`versionName = <上游版本>-rokbot.<n>`。每次发布必须递增，系统才会覆盖升级；不传时保留上游版本号
- `--version-code <n>` / `--version-name <s>`：显式指定输出的 versionCode / versionName（优先于 `--rokbot-build`；versionCode 不得低于上游）
- `--keystore <path>`：指定持久化签名密钥 JSON（默认 `~/.rokbot-local/android-signing.json`，严禁写入 `android/`）
- `--force-hbc`：当 HBC SHA-256 与配方指纹不一致时强制偏移拼接
- `--unsigned`：输出 16KB 对齐的未签名 APK
- `--verify-only`：仅校验输入归档与配方指纹，不写入输出 APK
- `--force`：覆盖已存在的输出 APK
- `--verbose`：在标准输出打印完整 JSON 补丁报告
- `-h` / `--help`：查看完整帮助

## 验证与测试

```bash
# 1. 核心与边界协议测试 (MockHost)
node android/tests/runner.mjs

# 2. 对抗性安全性与 16KB 对齐/签名篡改测试
node android/adversarial/run-adversarial.mjs

# 3. 补丁管线、多 DEX 与功能单元测试
node --test android/patchers/patcher.test.mjs \
  android/tests/adversarial-cli-multidex.test.mjs

# 4. Android 模拟器真实 UI 端到端测试（默认安装 android/output/rokbot-android-patched.apk，包名 ai.x.grok.bot；可通过 PATCHED_APK / TARGET_PKG 覆盖；RN MainActivity 使用 dumpsys activity top + screencap -p，原生模态页使用受限 uiautomator dump）
ANDROID_SERIAL=emulator-5554 node android/tests/emulator-e2e.mjs
```
