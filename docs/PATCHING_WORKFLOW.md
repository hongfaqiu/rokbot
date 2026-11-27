# RokBot 全端自托管适配与补丁改造流程

[English](PATCHING_WORKFLOW.en.md) · [简体中文 README](../README.md) · [AI Agent 部署引导](AGENT_DEPLOY.md) · [兼容与重命名说明](REBRAND_COMPAT.md)

本文档完整记录 RokBot 如何在**不分发任何官方闭源二进制**的前提下，通过「原包校验 → 解包/反汇编 → 确定性字节与配方补丁 → 自托管运行时与品牌注入 → 本地重打包签名」流水线，将官方服务端与五大客户端适配为可完全自托管、支持应用内模型配置与四端增量自动更新的 RokBot 体系。

---

## 一、总体设计原则

1. **零闭源分发**：仓库仅存放补丁脚本、压缩字节差分配方（`.gbp.gz`）、开源原生扩展代码（Java / Objective-C / JS / Go）与品牌资产；所有成品均由用户在本地基于官方安装包生成。
2. **确定性输入校验**：每个补丁器在修改前都会核对输入包或关键产物的 SHA-256 哈希与版本清单（`supported.json` / `manifest.json`），避免在未知版本上误打补丁。
3. **协议兼容与品牌隔离**：所有项目自有标识统一为 `rokbot`（`ROKBOT_*`、`x-rokbot-*`、`rokbot_*`、`rokbot-local://`、`RBDELTA1` / `RBD1`），仅在官方原生协议/包名强约束边界保留最小兼容常量（详见 [REBRAND_COMPAT.md](REBRAND_COMPAT.md)）。

---

## 二、Host 服务端改造流程（`host/`，基线 `97658ad`，回退保留 `2bb5e41`）

核心目录：`host/recipes/host/`、`host/recipes/host/2bb5e41/`、`host/release/patch-host.py`、`host/runtime/`、`host/server/`、`host/deploy/`。

1. **输入校验与解包**：校验本地 `sand-host-bundle-97658ad.tgz` 的 SHA-256，解压出上游 `sand-host` 运行时与 `blob-worker` / `sand-eval-library` 模块（如需回退旧基线，可传 `--revision 2bb5e41`）。
2. **字节差分补丁（265 项 `.gbp.gz`）**：
   - `host/release/patch-host.py` 按 `host/recipes/host/manifest.json` 逐文件校验原文件哈希并应用差分补丁；
   - 重定向云端认证、模型调用与遥测上报，屏蔽外联埋点（含 `97658ad` 新增的 `desktop-telemetry` 扩展）；
   - 接入 `host/runtime/` 中的多协议模型适配层（Anthropic Messages / OpenAI Responses / OpenAI Chat）、可靠上下文压缩、按 Bot 独立路由，以及 `97658ad` 自托管 Canvas（`local-canvas.mjs`）、`Skill` 工具与可选 Tracked Tasks（`ROKBOT_TRACKED_TASKS=1`、`local-tracked-tasks.mjs`）。
3. **自托管控制面与增强能力（`host/server/` + `host/deploy/`）**：
   - `host/deploy/supervisor.mjs` 与 `host/deploy/host-supervisor.mjs` 统一托管外层控制面（`8000`）与内部网关运行时（`1340`）；
   - **ExternalShell 多机路由**：`host/runtime/host-computers.mjs` 将隐式执行确定性地路由至 `ROKBOT_DEFAULT_MACHINE_ID`（多机在线且未配置时返回明确错误，不随机落点）；
   - **非阻塞 MCP 启动**：`host/runtime/host-mcp.mjs` 将 `box:1337` 的 MCP 扩展注册改为后台指数退避重试（`2s → 30s`），避免冷启动沙盒阻塞模型热重载；
   - **应用内模型配置 API**：`GET/PUT /local/model`、`POST /local/model/catalog`、`POST /local/model/test` 写入 `/data/model.env` 并触发热重载；
   - **四端增量更新服务端**：`host/server/updates.mjs` 负责大文件上传、ECDSA P-256 清单签名、自动生成 Android `RBDELTA1` / 桌面 `RBD1` 增量补丁以及 iOS 令牌化 OTA 端点。
4. **容器封装**：`host/release/build-docker.py` 与 `Dockerfile.host` 构建多架构（`amd64`/`arm64`）`rokbot-host` 镜像（含 `15s` 抗高负载 `HEALTHCHECK`），搭配 `sand-box-97658ad` 运行。

---

## 三、Android 原生客户端改造流程（`android/`，基线 `1.26.0`）

核心目录：`android/release/patch-android.mjs`、`android/patchers/`、`android/recipes/`、`android/companion/`。

1. **Split XAPK 合并**：读取官方 `1.26.0` `.xapk` / `.apks` / `.apk`，合并 `base.apk` 与各 ABI / 密度 / 语言配置分包（`config.*.apk`），整理为单一独立 APK。
2. **中和运行时完整性校验（Pairip 去校验）**：
   - 识别并中和官方包中的 Pairip 完整性/签名校验入口，清理会导致自签名安装或冷启动崩溃的冲突清单属性；
   - 修复 `AndroidManifest.xml` 中属性按资源 ID 排序，确保系统解析器（Android 14/15/16）稳定加载。
3. **Hermes 字节码补丁**：
   - 对 React Native 的 Hermes 字节码（`index.android.bundle`）应用确定性补丁，替换内置服务域名/协议路由至本地控制面代理；
   - 注入稳定 `clientDeviceId` 上报逻辑，防止同一设备重复配对产生冗余记录；
   - 适配 `2bb5e41` Host 的新接口字段与 `needsModel` 引导状态。
4. **原生 Companion DEX 注入（`dev.rokbot.nativeapp`）**：
   - 编译 `android/companion/` 源码为 `classes2.dex` 合入 APK（Multidex），提供：
     - `PairingActivity`：原生配对连接页（支持 6 位配对码、管理员密码与局域网扫描）；
     - `ModelsActivity`：应用内模型提供商/模型档案管理、拉取上游模型列表、实时连通测试与热切换；
     - `UpdateManager` + `ApkUpdateProvider`：拉取 `/local/updates/android.json`，优先下载 `RBDELTA1` ZIP 条目级增量并在本地重建完整 APK，校验 SHA-256、包名与签名证书指纹后调起系统安装；
   - 打包 16KB 页对齐的 Tailcat 原生库（`arm64-v8a`）。
5. **自适应图标替换与重签名**：
   - 写入 `assets/logo/` 生成的变形 RokBot 图标各密度 `mipmap-*`，保留自适应图标 `<background>` 的 `@color/iconBackground` 引用（避免 Pixel Launcher 退回默认通用图标）；
   - 执行 4 字节 / 16KB zipalign 对齐，使用用户本地 Keystore（`--keystore`）执行 APK v2/v3 签名（后续增量更新必须复用同一签名密钥）。

---

## 四、macOS / Windows 桌面端改造流程（`mac/`、`windows/`，基线 `1.2.3`）

核心目录：`mac/patchers/desktop/`、`mac/clients/desktop/`、`windows/patchers/desktop/`、`windows/tools/desktop-recipes/`、`windows/installer/`。

1. **官方包下载与校验**：按 `supported.json` 固定版本与 SHA-256 拉取官方 `1.2.3` `.dmg`（macOS Apple Silicon）或 `Setup.exe`（Windows x64）。
2. **解包与 ASAR 配方补丁**：
   - 解包 Electron 的 `app.asar`，运行 `1.2.3` 桌面补丁配方（macOS / Windows 各 17 项核心配方）；
   - 重定向远端 API 与更新地址至自托管 Host，禁用遥测，注册 `rokbot-local://` 自定义 URL Scheme；
   - 注入 `preload` 桥接对象 `window.localBot`、应用内模型配置面板、`needsModel` 顶部引导横幅以及 `clientDeviceId` 去重。
3. **内置网络代理与签名增量更新**：
   - 嵌入对应平台的 `rokbot-tailcat` 可执行文件与变形 RokBot 图标（`.icns` / `.ico`）；
   - 接入 ECDSA P-256 公钥验签与 `RBD1` ASAR 增量更新引擎（`mac/clients/desktop/asar-install.mjs`），优先应用增量补丁，失败自动回退完整包。
4. **封装产出**：重新打包 `app.asar`，macOS 生成 `RokBot.app`（及 `.dmg`/`.zip`），Windows 通过 Go 安装器（`windows/installer/`）打包原生安装程序。

---

## 五、Web 网页版改造流程（`web/`，基线 `1.2.3`）

核心目录：`web/patchers/patch.mjs`、`web/client/`。

1. **渲染层提取**：从校验通过的 Windows `1.2.3` 安装包提取 Electron 前端渲染资源，剥离桌面原生 IPC 依赖。
2. **浏览器兼容桥接**：注入 `web/client/` 下的 `gateway.js`、`bridge.js`、`compat.js` 与 `native.js`，用浏览器 `fetch` / `EventSource` / `WebSocket` 承接原桌面端能力，接入 `rokbot_web` HttpOnly Cookie 会话认证与 `x-rokbot-web: 1` 头校验。
3. **品牌与模型 UI 集成**：写入 RokBot PWA 清单（`/web/manifest.webmanifest`）、`/rokbot-icon.png` 图标以及应用内模型配置界面。
4. **托管发布**：打包为 `web/output/RokBotLocal-web-1.2.3.zip`，通过 Host 管理后台或 `PUT /admin/api/web-client` 上传托管。

---

## 六、iOS 原生客户端改造流程（`ios/`，基线 `1.16.0`）

核心目录：`ios/release/patch-ios.py`、`ios/patchers/ios/`、`ios/clients/ios/`。

1. **输入前提**：App Store 官方包受 FairPlay 加密保护，需由用户自行提供已解密的 `1.16.0` IPA（或未来适配的新版已解密 IPA）。
2. **原生动态库编译与注入**：
   - 将 `ios/clients/ios/` 中的 Objective-C 源码编译为 arm64 动态库 `RokBotLocal.dylib`，包含：
     - `RBBootstrap.m` / `RBConnection.m`：网络重定向、Host 配对与 `clientDeviceId` 设备去重；
     - `RBModels.m`：原生应用内模型配置与测试面板；
     - `RBUpdater.m`：拉取 `/local/updates/ios.json`，对接 `itms-services://` OTA、AltStore / SideStore 源与 IPA 分享安装；
     - `RBComputers.m` / `RBConnectors.m` / `RBPush.m`：多机、连接器与推送适配；
   - 对 IPA 主二进制注入 `LC_LOAD_DYLIB` 加载 `RokBotLocal.dylib`，并应用 `ios/recipes/ios/gateway-template.hbc.gbp.gz` 网关补丁。
3. **品牌替换与分发**：替换 5 组无透明通道 RGB `AppIcon`、将 Bundle ID 改为 `dev.rokbot.local`，输出未签名/待签名 IPA，由用户使用自有 Apple 证书重签名后上传至 Host 推送给 iOS 设备。

---

## 七、更新到未来官方新版本的维护方法

当官方发布新版本时，可按以下最小步骤跟进：
1. 运行 `node ci/official-channels.mjs --online` 查看官方各通道最新版本号与下载链接；
2. 下载官方新原包并在本地计算 SHA-256，更新对应平台的 `supported.json` / `manifest.json`；
3. 重新生成受影响的字节差分配方（Host `host/recipes/host/`、桌面 `windows/tools/desktop-recipes/`、Android `android/recipes/`）；
4. 运行各模块单测与全量 E2E 回归（`node tests/e2e/runner.mjs --tier all --repo-check`）确认 100% 通过后发布新版。
