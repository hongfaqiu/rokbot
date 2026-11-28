# RokBot Native Android Official APK Patcher (`android/`)

[中文文档](README.md)

This directory provides an **Official Android React Native `.apk` / `.xapk` / `.apks` Patcher** (`ai.x.grok.bot` / `co.anysphere.sand` `1.26.0`, build `3212`) with 1:1 `ios/` (`RBBootstrap.m` + `patch-app.py`) parity: it preserves the official RN UI and interactions (Bot List, Chat, Markdown, Voice UI, Connectors, Search, Settings, Skills) with zero homemade primary UI or floating toolbar hijack, and injects only the lightweight native companion runtime (Companion DEX, 16KB-aligned Tailcat `.so` libraries, Hermes bytepatching, RokBot `assets/logo/android/mipmap-*` launcher icon replacement, OkHttp/WebSocket/Telemetry interception, foreground SSE notifications, deep-link normalization, Share Sheet target, and the 6 `ios/`-parity native modal sheets).

> Intended strictly for non-commercial, authorized self-hosted deployment and development. Never commit pairing codes, passwords, private tokens, or personal Host addresses.

## Key Capabilities

- **Split XAPK/APKS Merging & Google Play Pairip Neutralization**
  - **Universal Split Merger (`xapk.mjs` & `arsc.mjs`)**: Pure Node.js unpacker for Play Store `.xapk` / `.apks` / `.apk` archives; strips `libpairipcore.so`, merges the base APK with `arm64-v8a` native libraries and density/locale `resources.arsc` splits, replaces launcher `mipmap-*` icons with RokBot assets, replaces the system splash icon (`drawable/splashscreen_logo`, officially a 108 px mdpi bitmap that Android stretched into a blurry first screen) with `assets/logo/android/splash/` (the same centered 64 dp tile React Native's launch-mark shows, with added xxxhdpi and night-xxxhdpi configs, as an animated WebP the system splash draws at full resolution, so a cold start shows one sharp logo throughout), and writes a single 16KB-aligned v2/v3-signed APK (default `android/output/rokbot-android-patched.apk`).
  - **Pairip Anti-Tamper Neutralization (`pairip-dex.mjs`, `pairip-elf.mjs`, `PairipVmBridge`, `RokBotAppComponentFactory`)**: Neutralizes Pairip DEX signature/license checks and dispatches `VMRunner` calls cleanly, patches ELF `DT_NEEDED libpairipcore.so`, `DT_INIT` trampolines, `ExecuteProgram` relocations, and pinned `.data` sections, and strips Pairip/Play-split manifest metadata.
- **Secure Pairing & Multi-Transport Connectivity (`PairingActivity`)**
  - Direct `http://` / `https://` URLs, **Pairing Code / Admin Password** segmented toggle, **LAN / mDNS (`_rokbot._tcp.`) Host auto-discovery**, and built-in **Tailcat encrypted tunneling (`tailcat://connect/...`)**.
  - Bundles `arm64-v8a` `libgroktailcat.so` + `libgroktailcatjni.so` injected with strict **16KB page alignment** (`0xd935` ZIP extra-field padding) for Android 15/16 compatibility (kept with `dev.grokbot.local.TailcatBridge` as a binary ABI compatibility bridge because the prebuilt `.so` exports `Java_dev_grokbot_local_TailcatBridge_*` symbols and the C JNI wrapper source is not in this repository), complete with network-change listeners and automatic health recovery.
  - Seals device credentials and Tailcat node identity inside **Android Keystore (`AES/GCM/NoPadding`)**.
- **Exact `ios/` `RBBootstrap` Native Surface Alignment (Zero Homemade Primary UI or Floating Pills)**
  - Retains the official RN `MainActivity` launcher and official Bots/Chat/Voice/Connectors UI, hooking only the 6 `RBBootstrap.m` surfaces:
    1. **Connection / Login (`PairingActivity`)**: Official-aligned Connect UI matching `connect.html` and `RBConnection.m`.
    2. **Profile (`ProfileActivity`)**: Opened from the settings avatar / account row; only the avatar, display name, Save Profile and Remove Photo (appearance and language are the official first-level rows, the incremental update lives on App Updates). Also rewrites `dev-gateway@localhost` labels in the RN tree to the connected Host label.
    3. **Notifications (`PushSettingsActivity`)**: Test push and UnifiedPush / ntfy / Webhook / FCM configuration.
    4. **Bot Library (`LibraryActivity`)**: `NetworkInterceptor` / `R8OkHttpInterceptor` tracks active `agentId` across `/api/openAgentWindowed`, `/api/getAgentTranscriptTail`, `/api/getAgentTranscript`, and `/api/sendPrompt` (`RBObserveRequest` parity) for file upload, download preview, and deletion.
    5. **Bot Computers (`ComputersActivity` & `ComputerViewerActivity`)**: Queries `/api/getForeverBoxStatus`, boots `/api/ensureForeverBox`, and streams interactive noVNC via loopback proxy.
    6. **Usage (`UsageActivity`)**: Displays daily token and Host usage summary.
- **Notifications, Deep Links, Share Target & Hermes Bytecode Layer**
  - **Background Notifications (`NotificationService` & `PushManager`)**: Foreground-service SSE listener (`/notifications/events`) with 256-entry deduplication ring, UnifiedPush / ntfy / Webhook / FCM support, and deep-link normalization (`rokbot-local://agent/<id>` -> upstream RN `grokbot://app/v1/chat?id=<id>` delivered back to the official launcher `MainActivity`, matching `RBDeepLinks.m`).
  - **Transport & Telemetry (`R8OkHttpHook`, `R8OkHttpInterceptor`, `LegacyOkHttpHook`, `NetworkInterceptor` & `VoiceManager`)**: Hooks R8-minified OkHttp (`t8.f` / `Ae.k`) and legacy `OkHttpClientProvider`; blocks Sentry, Braze, AppsFlyer, Statsig, and `/aiserver.v1.AnalyticsService/*`; translates STT dictation (`/aiserver.v1.AiService/TranscribeAudio` -> `/local/audio/transcriptions`), voice-memo playback (`/aiserver.v1.AiService/TextToSpeech` -> `/local/audio/speech`), avatar generation (`/aiserver.v1.AiService/RunGenerateImage` -> `/local/avatar/generate`), voice session minting (`/aiserver.v1.GrokBotService/MintSandVoiceCallSecret` -> `/local/voice/session`), `/local/app-intents/*`, `/local/mobile-rpc/*`, and SkillSheet publication (`https://rokbot.local/skill-publication`); provides 24kHz PCM + hardware `AcousticEchoCanceler` / `NoiseSuppressor` support.
  - **Hermes Layer (`HermesPatcher` & `hermes.mjs`)**: Applies `recipes/*.gbp.gz` bytepatches when matching pinned HBC SHA-256, bundles `assets/recipes/{unpaired.hbc,gateway-template.hbc,gateway-template.json}` (plus `assets/recipes/pairip-strings.json` when VMRunner is hooked), disables Expo Updates, and hooks `ReactNativeHost` and New-Arch `ReactHost`.
  - **The rokbot section of the settings sheet (`hermes-settings.mjs` `applySettingsMenu`)**: the first group right under the account card, headed `rokbot`: Bot Icon Style (`AvatarStyleActivity`), the official Appearance, Language and Usage rows (moved out of their groups, never listed twice), Model Settings (`ModelsActivity`), Connection & Diagnostics (`PairingActivity`, connection content only) and App Updates (`UpdateActivity`, which also carries the manual `RBDELTA1` incremental update with `GBDELTA1` read-compatibility). The rows are built by an in-place Hermes bytecode rewrite with the official `InsetGroup` / `InsetGroupNavRow` components and are rebuilt on every render so the official rows show their current values. Once paired, native pages follow the official Language and Appearance choices; the pairing page's own language / theme switches only show before pairing.
  - **Bot avatar styles and the RokBot logo (`RokBotAvatarManager`, `RokBotAvatarDrawable`, `RokBotAvatarShapes`, `RokBotAvatars`, `RokBotLogo`, `BundleAssets`)**: the style picked in Settings › Bot Icon Style (`AvatarStyleActivity`) (Chassis / Twin Antenna / Cyber Visor / Pixel Sprite / Fluid Orb / Official) applies to every Bot icon React Native draws: the Bot list and its groups, the chat title, Bot details, Edit Bot and the avatar preview, the shape picker, the Create New Bot preview and shape cells, search results and the in-chat working mark. Marks are found by the app's own test ids (`still-avatar-body` / `still-avatar-eyes`), the "<shape> character shape" labels and the animated mark's halo geometry; each Bot's color and exact silhouette are sampled from the official SVG and drawn in the host view's ViewGroupOverlay; the official views are only made INVISIBLE and no child view is inserted into React Native; Official restores everything. The share sheet Bot list and notification large icons use the same style (shape and color from `/api/listAgents`, with the 13 official 1.26.0 silhouettes built in). App logo: the pairing page, Software Update, React Native's About / launch marks (`about-mark`, `launch-mark`, ...) and the notification small icon draw the geometry of `assets/logo/rokbot-logo.svg`; React Native's in-app app icon `res/raw/assets_appicon_*.svg` becomes `assets/logo/rokbot-app-icon.svg`; packaged React Native images, SVGs and sounds are copied next to the file bundles (`RokBotPaired` / `RokBotUnpaired`), where they previously failed to load once paired.
  - **Android Share Sheet Target (`ShareTargetActivity`)**: Accepts `ACTION_SEND` / `ACTION_SEND_MULTIPLE` (text, images, files), uploads via chunked transfer to the selected Bot, and routes back to chat via normalized deep link.

## Layout

```text
android/
├── bin/
│   ├── classes2.dex                   # Compiled native companion DEX (injected at next sequential slot, e.g. classes6.dex in 1.26.0)
│   ├── rokbot-native-base.apk        # Minimal RN patcher test target APK
│   └── jniLibs/arm64-v8a/             # Precompiled arm64-v8a Tailcat Go mobile JNI libraries
├── companion/                         # Native Java companion source, compile-stubs, build.sh
├── patchers/                          # Pure Node AXML, ARSC, XAPK/APKS merger, Pairip DEX/ELF neutralizer, DEX/JNI, Hermes/bytepatch, 16KB ZIP align, v2/v3 APK signer
├── recipes/                           # Pinned 1.26.0 (3212) manifest, .gbp.gz Hermes bytepatches, and Pairip ELF/string recipes
├── release/                           # CLI patcher (patch-android.mjs and Python wrapper patch-android.py)
├── test-target/                       # Minimal RN fixture APK builder
├── tests/ & adversarial/              # Unit, adversarial, MockHost, and live emulator E2E suites
└── output/                            # Default signed APK output directory (rokbot-android-patched.apk & patch-report.json)
```

## Quick Start

### Prerequisites

- Node.js `>= 20` (sufficient to run `patch-android.mjs` standalone)
- Optional (only needed when rebuilding `companion/build.sh`, `test-target/build-base.sh`, or running JVM/emulator tests):
  - JDK 17+ (`javac`, `jar`)
  - Android SDK (`platforms/android-36/android.jar`, `build-tools` `d8`/`aapt2`/`apksigner`, and `platform-tools/adb`)

### Patch an Official Android React Native APK / XAPK (`ios/` Parity)

```bash
# Optional: recompile classes2.dex if you modified companion/ sources
bash android/companion/build.sh

# Patch official 1.26.0 .xapk / .apks / .apk -> android/output/rokbot-android-patched.apk
node android/release/patch-android.mjs \
  --input-apk /path/to/grok-bot-1.26.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk \
  --force
```

Bring your own official package; this repository does not provide original or patched APKs. Use the generated APK only on your own devices, or have your Host administrator publish it on the Client updates page, after which installed clients receive updates through the Host's Android update channel. See [Getting the clients](../docs/clients.en.md#getting-the-clients).

Key CLI options:

- `--input-apk <path>` (aliases `--input`, `--apk`): Official RN `.xapk` / `.apks` / `.apk` (`ai.x.grok.bot` / `co.anysphere.sand` `1.26.0`)
- `--output-apk <path>` (alias `--output`): Destination 16KB-aligned, v2/v3-signed APK path (required unless `--verify-only`; every patch run writes `patch-report.json` alongside it)
- `--package-name <id>` (alias `--bundle-id`): Override Android `package` / `applicationId` while preserving original `MainActivity` FQCN and rewriting `provider` authorities & custom permissions
- `--host <url>`: Preconfigure Host URL (`http://...`, `https://...`, or `tailcat://connect/<node>?port=<port>`)
- `--pairing-code <code>` (alias `--pairing-key`): Preconfigure 6-character pairing code (uppercase alphanumeric excluding `I`/`O`/`1`/`0`)
- `--keystore <path>`: Persistent JSON signing identity path (default `~/.rokbot-local/android-signing.json`; refuses `android/`)
- `--force-hbc`: Force HBC offset splicing even when bundle SHA-256 differs from recipe pin
- `--unsigned`: Output 16KB-aligned unsigned APK
- `--verify-only`: Validate input archive and recipe pins without writing output
- `--force`: Overwrite existing output APK
- `--verbose`: Print full JSON patch report to stdout
- `-h` / `--help`: Show CLI help

## Verification

```bash
node android/tests/runner.mjs
node android/adversarial/run-adversarial.mjs
node --test android/patchers/patcher.test.mjs \
  android/tests/adversarial-cli-multidex.test.mjs
# Live emulator E2E (defaults to android/output/rokbot-android-patched.apk, package ai.x.grok.bot; override via PATCHED_APK / TARGET_PKG; uses dumpsys activity top + screencap -p for RN MainActivity and bounded uiautomator dump for native companion modals)
ANDROID_SERIAL=emulator-5554 node android/tests/emulator-e2e.mjs
```
