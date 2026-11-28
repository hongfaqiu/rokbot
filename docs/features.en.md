# Features

[Back to Home](../README.en.md) · [简体中文](features.md) · [Screenshots](screenshots.en.md) · [Deployment Guide](deployment.en.md) · [Getting the Clients](clients.en.md)

## The Bot's computer and live takeover

- The Host ships with a Linux desktop container (`box`). Bots use its browser, terminal and files to do their work. Home and workspace directories live on their own data volumes.
- Clients can open a live VNC view of the Bot's computer and take over with mouse, keyboard or touch.
- Bots can also work on your own computer through the Host: on a Mac they can run commands and control the GUI, and on Windows they can run local commands. The client connects out to the Host, so the computer does not need any open ports.
- Reading files, listing folders and copying files to the Bot's computer are not limited to a folder. Only a fixed list of sensitive paths is off limits: SSH/GPG keys, cloud and GitHub CLI credentials, keychains, browser passwords and cookies, credential files such as `auth.json`, `credentials.json`, `secrets.json`, `model.env`, `setup-key` and `android-signing.json`, and RokBot's own data folder, also when reached through a symlink. Writing, deleting and copying files onto your computer still go through approval or auto-review; files copied from the Bot's computer are saved in RokBot's local workspace.
- You can replace the built-in `box` with a remote Linux execution node, configured on the Execution page of the admin console.

## Continuity across devices and notifications

- Conversations and settings live on the Host, and every client connects to the same Host. You can start a task on your computer and follow up on your phone or in the browser.
- The chat list can be sorted by last message and grouped: Needs attention, Unread and Read on desktop and web, with an additional In progress group on Android.
- On Android, tapping the `+` button in the top-right corner of the chat list opens a native bottom sheet to create either a new Bot or a new group chat with multiple Bots collaborating together.
- Desktop (macOS, Windows, Linux) and Web clients also include a "New group" button next to the sidebar "New Bot" button, letting you pick up to 6 Bots and jump straight into the created group chat.
- Web and Android show contextual input suggestions above the chat composer; tap any suggestion to fill the input box. Suggestions use the dedicated Input suggestions scenario model and fall back to built-in Chinese/English presets when no model is configured or the request fails.
- Notification channels:
  - iOS can use APNs or Bark.
  - The Android client keeps its own connection to the Host and can also use ntfy, UnifiedPush, FCM or a webhook.
  - The web client uses browser notifications while the page is open.
- Notifications can be sent on every reply or only when a task completes.

## Bring your own models

- Three API formats are supported: OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. Any service that speaks one of these formats can be connected.
- Model services and model profiles organize several providers and models.
- The default route and per-Bot routes each set the model, the reasoning effort and a fallback order, with up to 8 fallbacks per route.
- Per-scenario model routing: on the Chat model page of the admin console and in Android Model Settings, you can assign a dedicated model profile and reasoning effort to each of 6 scenarios — Input suggestions, Context summarization, Memory extraction, Auto-review, Subagents and Automations. Any unset scenario follows the default route.
- You can fetch model lists and test connections in the admin console or in the clients. On Android, you can also assign a dedicated model directly from an individual Bot's details screen. Changing the model configuration from a client requires a device paired with the admin password.
- If the primary model fails with 402, 408, 429, 5xx or a network error before producing any output, the next fallback takes over. Once output has started there is no switch, so output and tool calls are never repeated.
- Optional JEV routing picks a model profile by task difficulty. It requires an API key for the JEV service and is off by default.

## Image and video generation

- The Images & video page of the admin console connects providers: OpenAI-compatible image and video APIs, WaveSpeed, or a custom HTTP JSON endpoint.
- Image generation, video generation, video understanding and video review each have their own default model. Results come back to the conversation as attachments.
- Batch image download: select multiple images in a conversation or the media viewer and download them at once — save to a folder or ZIP on Desktop (macOS, Windows, Linux), download as ZIP on Web, or save directly to the gallery (`Pictures/RokBot`) on Android. On Desktop and Web the entry sits in the chat header and media viewer and only appears when the conversation has 2+ images (no always-on floating button).
- You need to supply an API key for each provider.

## Voice

- Speech recognition uses Fish Audio or an OpenAI-compatible transcription service; a Mac can also use a local model.
- Voice calls use the current Bot's model, context and tools, with recognition and speech synthesis handled by the services you configure.
- Real-time calls are experimental.

## Scheduled tasks

- A local scheduler in the Host runs Bot routines on cron schedules, with no external scheduling service.
- Each routine has at most one run in progress, and missed slots are merged into a single catch-up run.

## Webhooks

- The Webhook page of the admin console creates a trigger for a chosen Bot. You set a task template, an optional event-type filter and a per-minute limit.
- Requests are verified with HMAC-SHA256 signatures and a ±5-minute window. The request URL and signing secret are shown once at creation and can be reset later.
- Every delivery is recorded in a run log.

## Auto-review and approval cards

- Before a Bot performs a risky action, the model you configured decides whether to allow it, using the original classification rules. This covers shell commands, MCP calls, computer use, writes to scheduled tasks and sub-agent launches. You can write your own allow and block rules.
- A blocked action appears as a native approval card where you deny or allow it.
- Cards expire after 30 minutes by default; `ROKBOT_AUTO_REVIEW_APPROVAL_TTL_MS` sets the timeout.
- Auto-review is turned on in the client settings.

## Usage statistics

- Input, output, cache read/write and reasoning tokens are recorded per model.
- The admin Overview page and the client settings chart usage for today (hourly) and for the last 7 or 30 days (daily). They also show each model's share, a detail table and the cache hit rate.

## Self-hosted deployment and networking

- **Images:** prebuilt images are published on GitHub Container Registry (GHCR) and, like this repository, require access. One script configures, pulls and starts everything. Offline installs and building the images from source are also supported.
- **Architectures:** the Host image supports `linux/amd64` and `linux/arm64`. The `box` desktop image is `linux/amd64` only, so ARM hosts need binfmt/QEMU or Rosetta.
- **Ports:** the admin console (`18080`) and the web client (`18081`) listen on `127.0.0.1` by default. `ROKBOT_LISTEN_ADDRESS` changes the listen address.
- **Sign-in:** no cloud account is needed. Devices sign in with a single-use 6-digit pairing code that is valid for 5 minutes, or with the admin password.
- **LAN:** clients can connect directly by IP address, and the Android client can scan the local network for Hosts.
- **Remote access:** the built-in Tailcat encrypted network needs no Tailscale account. Tailscale and HTTPS reverse proxies also work.
- **Client updates:**
  - You publish installers for each platform on the Client updates page.
  - Android and desktop clients receive delta patches, and desktop update manifests are signed with ECDSA P-256.
  - iOS installs through `itms-services` (HTTPS required) or an AltStore / SideStore source.
- **Privacy:**
  - API keys are write-only. The admin API only reports whether a key is set, and keys are stored in `/data/model.env` on the Host data volume.
  - Telemetry and crash reporting are disabled in the Host and in every client.
