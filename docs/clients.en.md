# Supported Platforms & Getting the Clients

[Back to Home](../README.en.md) · [简体中文](clients.md) · [Deployment Guide](deployment.en.md) · [Patching Workflow](PATCHING_WORKFLOW.en.md) · [FAQ](faq.en.md)

This repository contains only what this project wrote itself: the Host source, the image build scripts, the per-platform patch tools and build scripts, and the documentation. It does not contain or distribute any original program files or client installers. You can build the clients yourself with the patch tools, or get them from a Host you deploy yourself.

## Supported Platforms

This repository does not provide client installers. Each client is obtained as shown in the "How to get it" column, and the patches accept only the official versions below. The versions come from the configuration files pinned in the repository.

| Platform | Form | Official version required | How to get it | Guide |
| --- | --- | --- | --- | --- |
| macOS | Apple Silicon client | 1.3.0 (recommended); 1.2.3 also accepted | Build it yourself / From your Host | [`mac/README.en.md`](../mac/README.en.md) |
| Windows | x64 installer and portable build | 1.3.0 (recommended); 1.2.3 and 0.71.2 also accepted | Build it yourself / From your Host | [`windows/README.en.md`](../windows/README.en.md) |
| Linux | x64 / arm64 `.deb`, `.tar.gz`, and portable build | 1.3.0 | Build it yourself / From your Host | [`linux/README.en.md`](../linux/README.en.md) |
| Web | Browser; can be added to the home screen | Interface from Windows 1.3.0 (recommended); 1.2.3 and 0.71.2 also accepted | Build the bundle yourself and upload it to your Host | [`web/README.en.md`](../web/README.en.md) |
| Android | Native APK (arm64-v8a) | 1.26.0 (build 3212) | Build it yourself / From your Host | [`android/README.en.md`](../android/README.en.md) |
| iOS | IPA; bring your own decrypted official IPA | 1.27.0 (29519); 1.26.0 and 1.16.0 also accepted | Build and sign it yourself / From your Host | [`ios/README.en.md`](../ios/README.en.md) |
| Linux server | Docker: `host` (amd64 / arm64) and `box` (amd64) | Host baseline `2bb5e41` | Build the images from source / Pull the prebuilt images (access required) | [`host/README.en.md`](../host/README.en.md) |

See [Getting the clients](#getting-the-clients) below for both methods.

The pinned versions come from these files: `mac/patchers/desktop/supported.json`, `windows/patchers/desktop/supported.json`, `linux/patchers/desktop/{x64,arm64}/supported.json`, `web/patchers/supported.json`, `android/recipes/manifest.json`, `ios/recipes/ios/manifest.json` and `host/recipes/host/manifest.json`.

## Getting the clients

This repository does not provide ready-made client installers. There are two ways to get a client: build it yourself, or get it from a Host you deploy yourself.

### Option 1: Build it yourself

Bring your own official Grok Bot client installer, then patch and sign it with the patch tools in this repository. The tools first check the input's size and SHA-256 against the pinned configuration and stop if it is not one of the official versions in the table. Run every command below from the repository root, replacing the paths with your own files.

If you omit `--source` for the desktop clients or the web client, the tool fetches the pinned version from the official download address and verifies it just as strictly. `ROKBOT_DESKTOP_DOWNLOAD_BASE` points it at a mirror you host. Android and iOS always need an installer you supply.

| Platform | Runs on | Input | Output |
| --- | --- | --- | --- |
| macOS | macOS, Node.js 22.12+ | Official 1.3.0 (or 1.2.3) Apple Silicon `.dmg` or `Grok Bot.app` | `mac/output.noindex/RokBot.app` |
| Windows | Windows 10/11 x64, Node.js 22.12+ | Official 1.3.0 (or 1.2.3, 0.71.2) x64 installer, `app-64.7z` or an installed original directory | `windows/output/` |
| Linux | Linux or macOS, Node.js 22.12+ | Official 1.3.0 Linux x64 / arm64 `.deb` or extracted directory | `linux/output/` (portable dir, `.tar.gz`, `.deb`) |
| Web | Windows, macOS or Linux, Node.js 22.12+ | The same official installer as Windows | `web/output/RokBotLocal-web-1.3.0.zip` |
| Android | Node.js 20+ | Official 1.26.0 (build 3212) `.xapk`, `.apks` or `.apk` | The APK given by `--output-apk` |
| iOS | Python 3.9+ | An official IPA you decrypted yourself: 1.27.0 (29519), 1.26.0 (29388) or 1.16.0 (23152) | The new directory given by `--output` |

#### macOS

```bash
node mac/patchers/desktop/patch.mjs --source "/path/to/Grok_Bot_1.3.0.dmg"
```

- Produces `mac/output.noindex/RokBot.app` and keeps a copy of the original in `mac/backup.noindex/RokBot.app`. The tool does not overwrite an existing output.
- The app is ad-hoc signed by default. To control the Mac's GUI, add `--identity auto` to sign with a Developer ID Application or Apple Development certificate from your keychain.
- `--verify-only` replays the patches in a temporary directory without producing a client. See [`mac/README.en.md`](../mac/README.en.md).

#### Windows

```powershell
node windows/patchers/desktop/patch.mjs --source C:\path\to\Grok_Bot_1.3.0_Setup.exe
```

- Produces, in `windows/output/`, the portable directory `RokBot Local/`, `RokBotLocal-1.3.0-x64-portable.zip`, the per-user installer `RokBotLocal-1.3.0-x64-Setup.exe` and the patch record `RokBotLocal-1.3.0-x64.patch.json`. Add `--no-installer` to build only the portable version.
- If 1.3.0 does not work for you, use `--version 1.2.3` or `--version 0.71.2`; the version in the file names changes accordingly.
- The patch removes the original signature, which no longer matches once the program is modified, so the generated program and installer are unsigned. See [`windows/README.en.md`](../windows/README.en.md).

#### Linux

```bash
# Install the shared dependency before the first build
npm install --prefix mac/patchers/desktop

# Download the pinned official 1.3.0 .deb and build (builds .deb and .tar.gz on Linux or macOS)
node linux/patchers/desktop/patch.mjs --arch x64   # or --arch arm64

# Or use a local official .deb (architecture detected by SHA-256), or pass --verify-only
node linux/patchers/desktop/patch.mjs --source /path/to/grok-bot_1.3.0_amd64.deb
```

- Produces, in `linux/output/`, the portable directory `RokBotLocal-1.3.0-linux-<arch>/`, portable archive `RokBotLocal-1.3.0-linux-<arch>.tar.gz`, rebranded Debian/Ubuntu package `RokBotLocal-1.3.0-linux-<arch>.deb` (upstream apt repo stripped, installs to `/opt/RokBot/rokbot`), and patch record `RokBotLocal-1.3.0-linux-<arch>.patch.json`.
- Works on both Linux and macOS without requiring `dpkg-deb`. See [`linux/README.en.md`](../linux/README.en.md).

#### Web client

```bash
node web/patchers/patch.mjs --source /path/to/Grok_Bot_1.3.0_Setup.exe
```

- Produces `web/output/RokBotLocal-web-1.3.0.zip`, which you upload on the Web client page of the admin console. Alternatively, add `--upload <Host address>` to install it on the Host right after the build; the admin password is read from `ROKBOT_ADMIN_PASSWORD`, `--password-file` or the terminal.
- If the 1.3.0 interface does not work for you, add `--version 1.2.3` or `--version 0.71.2`. See [`web/README.en.md`](../web/README.en.md).

#### Android

```bash
node android/release/patch-android.mjs \
  --input-apk /path/to/official-1.26.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk
```

- Produces a single 16 KB-aligned APK with v2/v3 signatures and writes `patch-report.json` next to it. Add `--force` to overwrite an existing output.
- The signing key is kept in `~/.rokbot-local/android-signing.json` by default and is created on the first run; `--keystore` chooses another path. Later upgrades must use the same key, so back it up separately.
- To publish upgrades through a Host, raise the version on every build with `--rokbot-build <n>` (1–99). See [`android/README.en.md`](../android/README.en.md).

#### iOS

```bash
python3 ios/release/patch-ios.py \
  --input /path/to/decrypted.ipa \
  --output ios/output/RokBot-Patched \
  --bundle-id dev.rokbot.local
```

- `--output` must be a new directory that does not exist yet. It receives the unsigned `RokBot-Local-resignable.ipa`, `RokBotLocal.dylib` and `patch-report.json`, plus `extension-signing.json` when the extensions are kept. The report's `dylibSha256` is the digest of the signature-stripped `RokBotLocal.dylib` actually shipped in the IPA (and next to it); `sourceDylibSha256` is the input library digest (the manifest pin).
- Sign it with your own signing tool and certificate, then install it. A free Apple ID allows only 3 App IDs, which is not enough for the main app and its three extensions; add `--remove-extensions` to keep only the main app. See [`ios/README.en.md`](../ios/README.en.md).

### Option 2: Get it from your own Host

The administrator of a Host can publish the installers they built to the devices on that Host:

1. The administrator builds and signs the installers as in Option 1.
2. On the Client updates page of the admin console, they choose a platform (Android, iOS, macOS, Windows or Linux), upload the installer and publish it. They can optionally pick an older release to generate a delta patch from.
3. Paired clients check for and download updates from that Host:
   - Android checks the download's size, SHA-256, package name and signing certificate, and the certificate must match the installed app.
   - macOS, Windows and Linux receive delta patches, and their update manifests are signed with ECDSA P-256. By default the clients check the Host they are paired with. To pin the manifest signing key shown on the Client updates page into the client, build it with `--update-url <Host HTTPS address>/local/updates` and `--update-public-key-file <key file>`.
   - iOS apps cannot replace themselves, so iOS installs through `itms-services` (HTTPS required), an AltStore / SideStore source, or by downloading the IPA and handing it to a signing tool.

For the first install the client is not yet paired with the Host. How the installer reaches users is decided by, and is the responsibility of, the administrator of each Host. Publishing and API details are in [`docs/AGENT_DEPLOY.en.md`](AGENT_DEPLOY.en.md#5-publishing-signed-4-platform-releases--incremental-updates), and compliance notes are in [`docs/faq.en.md`](faq.en.md#distribution--compliance).
