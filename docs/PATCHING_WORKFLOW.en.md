# RokBot Self-Hosting Adaptation & Cross-Platform Patching Workflow

[简体中文](PATCHING_WORKFLOW.md) · [English README](../README.en.md) · [AI Agent Deploy Runbook](AGENT_DEPLOY.en.md) · [Rebranding & Compatibility](REBRAND_COMPAT.md)

This document describes how RokBot adapts the official Host and all five native clients for full self-hosting **without redistributing any proprietary upstream binaries**, using a deterministic local pipeline: **SHA-256 verification → unpack/disassemble → byte/recipe patching → self-hosted runtime & branding injection → local repack & signing**.

---

## 1. Core Principles

1. **Zero Proprietary Redistribution**: The repository contains only patchers, compressed byte-diff recipes (`.gbp.gz`), open-source native companion code (Java / Objective-C / JS / Go), and brand assets. Every runnable artifact is assembled locally by the user from verified official packages.
2. **Deterministic Input Pinning**: Every patcher verifies SHA-256 hashes and version pins (`supported.json` / `manifest.json`) before modifying anything.
3. **Brand Isolation with Minimal Protocol Compatibility**: All RokBot-owned identifiers use `rokbot` (`ROKBOT_*`, `x-rokbot-*`, `rokbot_*`, `rokbot-local://`, `RBDELTA1` / `RBD1`), preserving only upstream-pinned constants required at binary/protocol boundaries (documented in [REBRAND_COMPAT.md](REBRAND_COMPAT.md)).

---

## 2. Host Server Adaptation (`host/`, baseline `97658ad`, fallback `2bb5e41`)

Key paths: `host/recipes/host/`, `host/recipes/host/2bb5e41/`, `host/release/patch-host.py`, `host/runtime/`, `host/server/`, `host/deploy/`.

1. **Verification & Unpack**: Verifies the SHA-256 of `sand-host-bundle-97658ad.tgz` and unpacks the upstream `sand-host`, `blob-worker`, and `sand-eval-library` modules (pass `--revision 2bb5e41` to fall back to the previous baseline).
2. **Byte-Diff Recipes (265 `.gbp.gz` patches)**:
   - `host/release/patch-host.py` verifies each source file's hash against `host/recipes/host/manifest.json` and applies the compressed byte diffs;
   - Redirects cloud auth, model calls, and telemetry to the local control plane (`host/server/`) and self-hosted runtime (`host/runtime/`), neutralizing outbound telemetry including the new `desktop-telemetry` extension in `97658ad`;
   - Adds multi-protocol model routing (Anthropic Messages / OpenAI Responses / OpenAI Chat), reliable compaction, per-Bot model selection, plus self-hosted `97658ad` Canvases (`local-canvas.mjs`), the `Skill` tool, and opt-in Tracked Tasks (`ROKBOT_TRACKED_TASKS=1`, `local-tracked-tasks.mjs`).
3. **Self-Hosted Control Plane & Enhancements (`host/server/` + `host/deploy/`)**:
   - `host/deploy/supervisor.mjs` and `host/deploy/host-supervisor.mjs` supervise the public control plane (`8000`) and internal gateway (`1340`);
   - **ExternalShell Routing**: `host/runtime/host-computers.mjs` deterministically routes implicit execution to `ROKBOT_DEFAULT_MACHINE_ID` (failing loudly if unset while multiple machines are online);
   - **Non-Blocking MCP Startup**: `host/runtime/host-mcp.mjs` applies `box:1337` MCP registry config asynchronously with backoff (`2s → 30s`) so a cold box never blocks model hot-reload;
   - **In-App Model Config API**: `GET/PUT /local/model`, `POST /local/model/catalog`, and `POST /local/model/test` write `/data/model.env` and trigger hot-reload;
   - **4-Platform Auto-Update Server**: `host/server/updates.mjs` handles signed artifact uploads, ECDSA P-256 manifest signing, automatic Android `RBDELTA1` and desktop `RBD1` delta generation, and tokenized iOS OTA feeds.
4. **Container Packaging**: `host/release/build-docker.py` and `Dockerfile.host` build multi-arch (`amd64`/`arm64`) `rokbot-host` images (with a resilient `15s` `HEALTHCHECK`) paired with `sand-box-97658ad`.

---

## 3. Native Android Client Adaptation (`android/`, baseline `1.26.0`)

Key paths: `android/release/patch-android.mjs`, `android/patchers/`, `android/recipes/`, `android/companion/`.

1. **Split XAPK Merge**: Combines `base.apk` and `config.*.apk` splits from official `1.26.0` `.xapk` / `.apks` / `.apk` into one standalone APK.
2. **Integrity Lock Neutralization (Pairip)**:
   - Neutralizes Pairip runtime integrity/signature checks and strips conflicting manifest attributes so locally signed repacks cold-start cleanly;
   - Sorts `AndroidManifest.xml` attributes by resource ID for strict Android 14/15/16 parser compatibility.
3. **Hermes Bytecode Patching**:
   - Applies deterministic patches to the React Native Hermes bundle (`index.android.bundle`) to route traffic to the local proxy;
   - Injects stable `clientDeviceId` reporting for device deduplication and aligns with the `2bb5e41` Host protocol and `needsModel` onboarding state.
4. **Native Companion DEX Injection (`dev.rokbot.nativeapp`)**:
   - Compiles `android/companion/` into `classes2.dex` and merges it into the APK (Multidex), providing:
     - `PairingActivity`: native pairing screen (6-char code, admin password, LAN Host discovery);
     - `ModelsActivity`: in-app provider/profile management, `/local/model/catalog` fetch, `/local/model/test` live probe, and hot-switching;
     - `UpdateManager` + `ApkUpdateProvider`: checks `/local/updates/android.json`, downloads `RBDELTA1` ZIP-entry deltas, reconstructs the full APK locally, verifies SHA-256, package name, and signing certificate fingerprint, and launches the system installer;
   - Bundles the 16KB-page-aligned Tailcat native library (`arm64-v8a`).
5. **Adaptive Icon Replacement & Signing**:
   - Replaces `mipmap-*` densities with the deformed RokBot icon while preserving the `@color/iconBackground` reference (preventing Pixel Launcher fallback to a generic icon);
   - Zipaligns (4-byte / 16KB page aligned) and signs with APK v2/v3 using the user's `--keystore` (reuse the same keystore across releases so incremental updates install cleanly).

---

## 4. macOS & Windows Desktop Adaptation (`mac/`, `windows/`, baseline `1.2.3`)

Key paths: `mac/patchers/desktop/`, `mac/clients/desktop/`, `windows/patchers/desktop/`, `windows/tools/desktop-recipes/`, `windows/installer/`.

1. **Official Package Verification**: Downloads and verifies official `1.2.3` `.dmg` (macOS Apple Silicon) or `Setup.exe` (Windows x64) against `supported.json` SHA-256 pins.
2. **ASAR Unpack & Recipe Patching**:
   - Unpacks Electron `app.asar` and applies the `1.2.3` desktop recipes (17 recipes each for macOS and Windows);
   - Redirects API/update endpoints to the self-hosted Host, disables telemetry, registers `rokbot-local://`, and injects the `window.localBot` preload bridge, in-app Model Config UI, `needsModel` banner, and `clientDeviceId` dedup.
3. **Embedded Proxy & Signed Delta Updates**:
   - Embeds platform `rokbot-tailcat` binaries and RokBot icons (`.icns` / `.ico`);
   - Integrates ECDSA P-256 manifest signature verification and `RBD1` ASAR incremental patching (`mac/clients/desktop/asar-install.mjs`) with full-installer fallback.
4. **Repackaging**: Repacks `app.asar` into `RokBot.app` (macOS) and the Go-based Windows installer (`windows/installer/`).

---

## 5. Web Client Adaptation (`web/`, baseline `1.2.3`)

Key paths: `web/patchers/patch.mjs`, `web/client/`.

1. **Renderer Extraction**: Extracts the renderer bundle from the verified Windows `1.2.3` installer and strips desktop-only shell hooks.
2. **Browser Compatibility Bridge**: Bundles `web/client/` (`gateway.js`, `bridge.js`, `compat.js`, `native.js`) using browser `fetch` / `EventSource` / `WebSocket` with `rokbot_web` HttpOnly cookie sessions and `x-rokbot-web: 1`.
3. **Branding & Model UI**: Integrates `/web/manifest.webmanifest`, `/rokbot-icon.png`, and the in-app Model Config UI.
4. **Packaging**: Produces `web/output/RokBotLocal-web-1.2.3.zip` for upload via Host Admin or `PUT /admin/api/web-client`.

---

## 6. Native iOS Client Adaptation (`ios/`, baseline `1.16.0`)

Key paths: `ios/release/patch-ios.py`, `ios/patchers/ios/`, `ios/clients/ios/`.

1. **Decrypted IPA Prerequisite**: Because App Store IPAs are FairPlay-encrypted, the user provides a decrypted `1.16.0` IPA (or a newer decrypted IPA when upgrading).
2. **Native Dylib Build & Injection**:
   - Compiles `ios/clients/ios/` Objective-C sources into arm64 `RokBotLocal.dylib`:
     - `RBBootstrap.m` / `RBConnection.m`: network redirection, Host pairing, and `clientDeviceId` dedup;
     - `RBModels.m`: native in-app model configuration & testing screen;
     - `RBUpdater.m`: checks `/local/updates/ios.json` and exposes `itms-services://`, AltStore / SideStore, and IPA share-sheet installation;
     - `RBComputers.m` / `RBConnectors.m` / `RBPush.m`: multi-machine, connector, and push support;
   - Injects `LC_LOAD_DYLIB` into the main binary and applies `ios/recipes/ios/gateway-template.hbc.gbp.gz`.
3. **Branding & Distribution**: Replaces the 5 opaque RGB `AppIcon` assets, rewrites the bundle ID to `dev.rokbot.local`, and outputs an IPA ready for user code-signing and Host OTA distribution.

---

## 7. Tracking Future Official Releases

To advance to newer upstream versions:
1. Run `node ci/official-channels.mjs --online` to inspect live release channels;
2. Verify the new official archive SHA-256 and update `supported.json` / `manifest.json`;
3. Regenerate affected byte-diff or desktop recipes (`host/recipes/host/`, `windows/tools/desktop-recipes/`, `android/recipes/`);
4. Run module unit tests plus `node tests/e2e/runner.mjs --tier all --repo-check` until 100% green.
