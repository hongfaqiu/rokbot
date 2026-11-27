# RokBot AI Agent Deployment & Operations Runbook

[简体中文](AGENT_DEPLOY.md) · [English README](../README.en.md) · [Source-Build & Split-Host Manual](AI-INSTALL.en.md) · [Rebranding & Compatibility](REBRAND_COMPAT.md)

> **Audience**: AI coding agents (Claude Code, Cursor, Antigravity, Codex, etc.) helping a user deploy, upgrade, configure models, or publish 4-platform incremental updates for RokBot.  
> **Completion Rule**: Verify each stage deterministically, never print or commit secrets, never clobber an existing production container or `/data` volume, and do **not** treat a `healthy` container alone as done until a live model chat turn succeeds.

---

## 0. Mandatory Safety Guardrails

1. **Never clobber existing production stacks**: Run `docker ps -a` first. If an existing instance (e.g., `rokbot-host-1` or an existing `/data` volume) is running, **never** run `down -v`, `rm -f`, or overwrite its `.env` without explicit user approval. Always use an isolated directory, Compose project name, and port for test runs.
2. **Never leak or commit secrets**:
   - Never write `.env`, `.admin-password`, `/data/setup-key`, `/data/model.env`, API keys, Bearer tokens, or private keys into Git commits, logs, or screenshots.
   - Consume credentials in-memory/via pipes or instruct the user to enter them directly in the Admin UI or client app.
3. **Client-only updates skip server deployment**: If the user already has a healthy Host and only needs to build or publish client packages, skip all server deployment commands in Section 2.

---

## 1. Preflight Checks

Run these read-only checks on the target machine first:

```bash
set -eu
uname -a
docker --version
docker compose version
df -h .
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

| Check | Minimum | Recommended |
| --- | --- | --- |
| Docker & Compose | Docker Engine + Compose v2 (`up --wait` supported) | Latest stable |
| CPU / RAM / Disk | 2 vCPU / 4 GB RAM / 30 GB free | 4 vCPU / 8 GB RAM / 50 GB+ |
| Architecture | `x86_64` native; `arm64` hosts need `linux/amd64` binfmt/QEMU or Rosetta for `box` | `x86_64` or Apple Silicon with Rosetta |
| Port availability | Verify `18080` (or chosen `ROKBOT_PUBLIC_PORT`) is free | Change `ROKBOT_PUBLIC_PORT` in `.env` if taken |

Confirm these 4 items once with the user (unless already answered in context):
1. **Deploy path**: Prebuilt mirror image one-click deploy (recommended) or local build-from-source?
2. **Exposure**: Loopback only (`127.0.0.1`), LAN (`0.0.0.0`), or public HTTPS origin (`ROKBOT_PUBLIC_URL`, required for iOS OTA)?
3. **Registry / proxy**: Private GHCR auth (`docker login ghcr.io`), custom mirror registry, or `HTTP_PROXY` / `HTTPS_PROXY`?
4. **Clients**: Which platforms need patching or update publishing (Android / iOS / macOS / Windows / Web)?

---

## 2. Deployment Paths

### Path A: Prebuilt Mirror Image One-Click Deploy (Recommended)

Uses prebuilt images (`ghcr.io/hongfaqiu/rokbot/host:latest` and `ghcr.io/hongfaqiu/rokbot/box:97658ad` by default, or any user-configured mirror).

#### A1. One-Click Setup From a Clone

The repository is private, so anonymous requests to `raw.githubusercontent.com` fail. Clone the repository first (access required), then run its script with `--local`, which copies the Compose and `.env` templates into the current directory. The prebuilt images also require access: before pulling, run `docker login ghcr.io` with a token that has the `read:packages` scope.

```bash
mkdir -p "$HOME/rokbot" && cd "$HOME/rokbot"
gh repo clone hongfaqiu/rokbot src < /dev/null   # without gh: git clone https://github.com/hongfaqiu/rokbot.git src
bash src/host/release/install-images.sh --local --prepare-only
```

Review and edit `.env` (created with mode `0600`). Key variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROKBOT_LISTEN_ADDRESS` | `127.0.0.1` | Host bind interface; set `0.0.0.0` for LAN or reverse proxy |
| `ROKBOT_PUBLIC_PORT` | `18080` | Published port mapped to container port `8000` |
| `ROKBOT_PUBLIC_URL` | empty | Public HTTPS origin (e.g. `https://bot.example.com`), required for iOS `itms-services` |
| `ROKBOT_HOST_IMAGE` | `ghcr.io/hongfaqiu/rokbot/host:latest` | Multi-arch Host image (`amd64` + `arm64`); override for mirrors |
| `ROKBOT_BOX_IMAGE` | `ghcr.io/hongfaqiu/rokbot/box:97658ad` | Execution sandbox image (`linux/amd64`) |
| `ROKBOT_BOX_TOKEN` | `local` | Keep `local` for bundled box; use a strong random token for split execution nodes |
| `ROKBOT_ALLOW_DEVICE_MODEL_CONFIG` | `1` | `1` enables in-app model configuration (`/local/model*`) for authorized clients |
| `ROKBOT_UPDATE_DIR` | `/data/updates` | Persistent storage for 4-platform update packages and manifests |
| `ROKBOT_DEFAULT_MACHINE_ID` | empty | Pins implicit ExternalShell routing when multiple desktop machines are paired |

Start the stack and wait for health checks:

```bash
bash src/host/release/install-images.sh --local
```

#### A2. Local Clone & Air-Gapped Flags

| Scenario | Command |
| --- | --- |
| Use the templates from a local clone (required for the private repository) | `bash install-images.sh --local` |
| Generate and validate Compose + `.env` only | `bash install-images.sh --prepare-only` |
| Images preloaded via `docker load`, no network allowed | `bash install-images.sh --offline` |
| Images already present locally, skip `docker compose pull` | `bash install-images.sh --pull-never` |
| Custom mirror base for template downloads | `ROKBOT_DOWNLOAD_BASE="https://mirror.example.com/rokbot/release" bash install-images.sh` |

### Path B: Local Build From Source (Custom/Offline Builds)

Requires `sand-host-bundle-97658ad.tgz` and `sand-box-97658ad`. See [docs/AI-INSTALL.en.md](AI-INSTALL.en.md) and [host/README.en.md](../host/README.en.md):

```bash
python3 host/deploy.py doctor < /dev/null
python3 host/deploy.py init < /dev/null
```

---

## 3. First-Boot Verification, Setup & Pairing

Run these checks after startup (replace `PORT` with `ROKBOT_PUBLIC_PORT`, default `18080`):

```bash
PORT="${ROKBOT_PUBLIC_PORT:-18080}"
# 1. Verify containers are Up (healthy)
docker compose --env-file .env -f docker-compose.images.yml ps
# 2. Verify control-plane health
curl -fsS "http://127.0.0.1:${PORT}/healthz"
# 3. Verify public status (expects brand: "RokBot", initialized, needsModel)
curl -fsS "http://127.0.0.1:${PORT}/connect/status"
```

Onboarding steps:
1. Retrieve the one-time setup key (have the user consume it directly — **never commit or paste into public logs**):
   ```bash
   docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
   ```
2. Open `http://127.0.0.1:${PORT}/admin`, enter the setup key, and set the admin password.
3. Generate a 6-character pairing code on the Devices page (or sign in with the admin password) from Android, iOS, macOS, Windows, or Web.
4. Once paired, `GET /local/status` returns `initialized`, `needsModel`, `canConfigureModel`, `hostVersion` (`97658ad`), and `defaultMachineId`.

---

## 4. Model Configuration & Hot-Reload Verification

Models can be configured directly inside any client app (Android `ModelsActivity`, iOS `RBModels`, macOS/Windows/Web Settings & `needsModel` banner) or via device-authenticated API calls:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/local/model` | `GET` | Returns redacted model routing config & reload status (`apiKey` is never returned; only `hasApiKey`) |
| `/local/model` | `PUT` | Writes `/data/model.env` and triggers `HostSupervisor` hot reload (`reload.status: "applied"`) |
| `/local/model/catalog` | `POST` | Probes upstream `/models` (OpenAI) or `/v1/models` (Anthropic) for available models |
| `/local/model/test` | `POST` | Sends a live preflight check (`Reply with OK.`) and returns `latencyMs` + reply |

> [!IMPORTANT]
> Do not mark deployment verified until `PUT /local/model` reports `reload.status: "applied"`, `POST /local/model/test` succeeds, and a real streaming chat turn completes in a client.

---

## 5. Publishing Signed 4-Platform Releases & Incremental Updates

This is the "get the clients from your own Host" method: administrators build the packages themselves following each platform README; the repository does not provide them. Admins upload their own pre-signed packages (`.apk`, `.ipa`, `.dmg`/`.zip`/`.asar`, `.exe`/`.zip`/`.asar`) to the self-hosted Host so end users get one-click incremental updates:

1. **Admin UI (Recommended)**: Open `/admin` → **Client Updates** → pick platform (`Android` / `iOS` / `macOS` / `Windows`) → upload signed package → optionally select a prior release to auto-generate deltas (`RBDELTA1` for Android, `RBD1` + ECDSA P-256 signed manifest for macOS/Windows) → **Publish**.
2. **Admin API** (admin cookie + `x-rokbot-csrf: 1`):
   - Upload artifact: `POST /admin/api/updates/upload`
   - Publish & build delta: `POST /admin/api/updates/publish`
   - List releases & public PEM: `GET /admin/api/updates`
   - Remove release: `DELETE /admin/api/updates/:platform/:releaseId`
3. **Client Update Feeds** (device Bearer token):
   - `GET /local/updates/android.json` (`rokbot-android-native-update/v1`, `certificateSha256` + `RBDELTA1` deltas)
   - `GET /local/updates/macos.json` & `GET /local/updates/windows.json` (`rokbot-desktop-update/v1`, `ecdsa-p256-sha256` signature + `RBD1` ASAR deltas)
   - `GET /local/updates/ios.json` (`rokbot-ios-update/v1`, tokenized `itms-services`, `altstore.json`, and `.ipa` URLs)
   - Tokenized iOS external OTA endpoints (no Bearer header required): `GET /updates/ios/:token/manifest.plist`, `GET /updates/ios/:token/altstore.json`, `GET /updates/ios/:token/:filename` (requires HTTPS `ROKBOT_PUBLIC_URL`).

---

## 6. Automated Regression Verification (In-Repo)

When an agent maintains or upgrades this repository, run the opaque-box E2E suite before pushing:

```bash
# 1. Self-contained harness + repo checks (199 tests)
node tests/e2e/runner.mjs --tier all --repo-check

# 2. Live integrated verification against an ISOLATED test Host (never production)
ROKBOT_E2E_HOST_URL=http://127.0.0.1:18082 \
ROKBOT_E2E_ADMIN_PASSWORD="<isolated-test-admin-password>" \
  node tests/e2e/runner.mjs --tier all --mode live --repo-check
```

---

## 7. Quick Troubleshooting

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| `docker compose pull` fails | Shell `HTTP_PROXY` does not reach Docker daemon, or private GHCR not logged in | Run `docker login ghcr.io`, configure Docker daemon proxy/mirrors, or override `ROKBOT_HOST_IMAGE`/`ROKBOT_BOX_IMAGE` in `.env` |
| `box` slow or failing on ARM64 | `box` is `linux/amd64` and requires binfmt/QEMU or Rosetta | Enable Rosetta in Docker Desktop (macOS) or install `qemu-user-static` + `binfmt-support` (Linux) |
| Sandbox tools not ready right after model save | Cold `box:1337` is still booting; Host applies MCP config asynchronously with backoff (`2s→30s`) without blocking model reload | Wait for `box-doctor` to pass (`docker logs <box-container>`) and retry |
| iOS `itms-services` OTA install fails | `ROKBOT_PUBLIC_URL` is not trusted HTTPS, or `.ipa` signing cert is untrusted on device | Serve Host behind valid HTTPS + set `ROKBOT_PUBLIC_URL`, or use AltStore / SideStore / IPA share sheet |
| Transient `unhealthy` under heavy host load | Multi-container CPU/RAM contention | Upgraded image uses a hardened `15s` `HEALTHCHECK` timeout; ensure `box` has ≥ 3–4 GB RAM available |
