#!/usr/bin/env node
import { Applications } from './applications.mjs';
import { applicationsAdmin } from './applications-api.mjs';
import { taskControlMethods } from './federation-tasks.mjs';
import http from "node:http";
import { readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Auth, handleConnectPair, isAdminPairedDevice } from "./auth.mjs";
import { DeviceModelSettings, Models } from "./models.mjs";
import { isConfiguredModelRouting, publicModelRouting } from "../runtime/model-routing.mjs";
import { UpdatesManager } from "./updates.mjs";
import { Speech } from "./speech.mjs";
import { VoiceConfig } from './voice-config.mjs';
import { VoiceSynthesis } from './voice-synthesis.mjs';
import { listFishVoices } from './voice-catalog.mjs';
import { Voice } from './voice.mjs';
import { pcmWav } from './voice-audio.mjs';
import { HarnessSettings } from './harness-settings.mjs';
import { Skills } from './skills.mjs';
import { ExecutionNode } from './execution-node.mjs';
import { TailcatNetwork, tailcatAdmin } from './tailcat.mjs';
import { Plugins } from './plugins.mjs';
import { Webhooks } from './webhooks.mjs';
import {
  AutomationWebhooks,
  hasWebhookTrigger,
  resolveAutomationWebhookCredential,
  resolveWebhookOrigin,
} from './automation-webhooks.mjs';
import { Sharing } from './sharing.mjs';
import { Migration } from './migrate.mjs';
import { migrateAdmin, migrateDevice, migrateInbox } from './migrate-api.mjs';
import { rewriteSharingUrls } from './sharing-api.mjs';
import { Federation } from './federation.mjs';
import { federationInternal } from './federation-api.mjs';
import { DesktopCapabilities } from './desktop-capabilities.mjs';
import { DesktopBrowserProviders } from './desktop-browser.mjs';
import { MediaSettings } from './media-settings.mjs';
import { WebSettings } from './web-settings.mjs';
import { MediaServices } from '../runtime/media-services.mjs';
import { WebServices } from '../runtime/web-services.mjs';
import { mediaInternal } from './media-internal.mjs';
import { provisionTeachSkill } from '../runtime/host-teach.mjs';
import { PromptSettings } from './prompt-settings.mjs';
import { internalHostClient } from './internal-host.mjs';
import { mobileAppIntentMethods, mobileAppIntentRpc } from './mobile-app-intents.mjs';
import { clientCompatMethods, handleClientCompatRpc } from './client-compat-api.mjs';
import { adminExtensions } from './admin-extensions.mjs';
import { recentRouting } from '../runtime/routing-log.mjs';
import { usageSummary, USAGE_PERIODS } from "../runtime/usage-ledger.mjs";
import { usageExport, usageReport, UsageReportError } from "../runtime/usage-report.mjs";
import { Profile } from "./profile.mjs";
import { Library, validateAgentId } from "./library.mjs";
import { deleteAgentsWithLibrary } from "./host-api.mjs";
import { Notifications } from "./notifications.mjs";
import { NotificationSettings } from './notification-settings.mjs';
import { PushService } from "./push-service.mjs";
import { Connectors, connectorApiMethods, mobileConnectorMethods } from "./connectors.mjs";
import { attachmentDataUrl } from "./attachments.mjs";
import { DeviceConnections, proxyHttp, proxyWebSocket } from "./proxy.mjs";
import { proxyLocalExec } from "./local-exec-proxy.mjs";
import { handleUpdateProxy, normalizeSelfOrigins } from "./update-proxy.mjs";
import { VncTickets, vncPath, normalizeVncUpgradeUrl, vncUpgradeRejectionLog, NATIVE_APP_VNC_PLATFORMS } from "./vnc.mjs";
import { WebClient, rawBody } from "./web-client.mjs";
import { createWebRoutes, webMoved } from "./web-routes.mjs";
import {
  adminMutation,
  bearer,
  check,
  cookie,
  equal,
  hash,
  HttpError,
  jsonBody,
  originFor,
  PAGE_POLICY,
  RateLimit,
  securityHeaders,
  sendJson,
  verifyPassword,
} from "./security.mjs";
import { readJson } from "./storage.mjs";
import { CanvasLinkOrigins, CanvasStore, configuredCanvasOrigin } from "./canvas-store.mjs";
import { routeCanvas } from "./canvas-http.mjs";
import { routeCanvasApi } from "./canvas-api.mjs";
import { createSpeedTest } from "./speedtest.mjs";
import { SuggestionsService, SuggestionsSettings } from "./suggestions.mjs";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const assetTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const pages = new Map([["/", "index.html"], ["/admin", "index.html"], ["/admin/", "index.html"], ["/connectors/result", "connector-result.html"]]);
// Admin assets are served from a fixed listing taken at startup.
const publicAssets = new Set(readdirSync(publicDir).filter((name) => [".js", ".css", ".svg"].includes(extname(name))));
const adminCookie = "rokbot_admin";
// Preference reads of the mobile Auto-review switch (PrReviewPreferencesService.fetchPreferences).
const localPreferenceRpcPaths = new Set([
  "/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings",
]);
const bootAt = new Date().toISOString();
function endpoint(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Server endpoint must be an HTTP(S) origin without credentials",
    );
  return url;
}
function isDirectLoopback(request) {
  if (
    request.headers["x-forwarded-host"] ||
    request.headers["x-forwarded-for"] ||
    request.headers["forwarded"] ||
    request.headers["x-forwarded-proto"] === "https"
  ) {
    return false;
  }
  const host = String(request.headers.host ?? "").trim().toLowerCase();
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host);
}
export async function createSelfHostServer(options = {}) {
  // Primary ROKBOT_* env vars with GROKBOT_* fallback for smooth .env migration.
  const dataDir = resolve(
    options.dataDir ?? process.env.ROKBOT_DATA_DIR ?? process.env.GROKBOT_DATA_DIR ?? "/data",
  );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const hostUrl = endpoint(
    options.hostUrl ??
      process.env.ROKBOT_INTERNAL_HOST_URL ??
      process.env.GROKBOT_INTERNAL_HOST_URL ??
      "http://127.0.0.1:1340",
  );
  const publicUrl = options.publicUrl ?? process.env.ROKBOT_PUBLIC_URL ?? process.env.GROKBOT_PUBLIC_URL;
  const webPublicUrl = options.webPublicUrl ?? process.env.ROKBOT_WEB_PUBLIC_URL ?? process.env.GROKBOT_WEB_PUBLIC_URL;
  const canonical = publicUrl ? endpoint(publicUrl).origin : null;
  const webCanonical = webPublicUrl ? endpoint(webPublicUrl).origin : null;
  if (webCanonical && canonical && webCanonical === canonical) {
    throw new Error("ROKBOT_WEB_PUBLIC_URL must differ from ROKBOT_PUBLIC_URL");
  }
  const configuredPort = (primary, legacy) => {
    const raw = process.env[primary] ?? process.env[legacy];
    if (raw === undefined || raw === "") return null;
    const port = Number(raw);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  };
  const publicPorts = {
    main: options.publicPort ?? configuredPort("ROKBOT_PUBLIC_PORT", "GROKBOT_PUBLIC_PORT"),
    web: options.webPublicPort ?? configuredPort("ROKBOT_WEB_PUBLIC_PORT", "GROKBOT_WEB_PUBLIC_PORT"),
  };
  const requestOrigin = (request, web = false) =>
    originFor(request, network.isIngress(request) || isDirectLoopback(request) ? "" : (web ? webCanonical : canonical));
  const updatesOriginFor = (request, web = false) => {
    if (network.isIngress(request) || isDirectLoopback(request)) {
      return originFor(request, "");
    }
    const proxied = Boolean(
      request.headers["x-forwarded-host"] ||
      request.headers["x-forwarded-for"] ||
      request.headers["forwarded"] ||
      request.headers["x-forwarded-proto"] === "https",
    );
    if (!proxied) {
      const reqOrigin = originFor(request, "");
      const configured = web ? webCanonical : canonical;
      try {
        if (!configured || new URL(reqOrigin).host !== new URL(configured).host) {
          return reqOrigin;
        }
      } catch {
        return reqOrigin;
      }
    }
    return requestOrigin(request, web);
  };
  const webhookOrigin = (request, origin) =>
    resolveWebhookOrigin({ canonical, requestOrigin: origin, isIngress: network.isIngress(request) });
  const hostDataDir = resolve(
    options.hostDataDir ??
      process.env.ROKBOT_HOST_DATA_DIR ??
      process.env.GROKBOT_HOST_DATA_DIR ??
      join(dataDir, "host-data"),
  );
  const attachmentUrlRoot =
    options.attachmentUrlRoot ??
    process.env.ROKBOT_ATTACHMENT_URL_ROOT ??
    process.env.GROKBOT_ATTACHMENT_URL_ROOT ??
    hostDataDir;
  const tokenFile =
    options.tokenFile ?? process.env.ROKBOT_INTERNAL_HOST_TOKEN_FILE ?? process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE;
  const internalToken =
    options.internalToken ??
    (tokenFile ? (await readFile(tokenFile, "utf8")).trim() : null);
  if (internalToken && !/^[A-Za-z0-9_-]{32,256}$/.test(internalToken))
    throw new Error("Invalid internal Host credential");
  const targets = {
    desktop: endpoint(
      options.vncUrl ?? process.env.ROKBOT_VNC_URL ?? process.env.GROKBOT_VNC_URL ?? "http://127.0.0.1:6080",
    ),
    fork: endpoint(
      options.forkVncUrl ??
        process.env.ROKBOT_FORK_VNC_URL ??
        process.env.GROKBOT_FORK_VNC_URL ??
        "http://127.0.0.1:6081",
    ),
  };
  const auth = await new Auth(dataDir, options.authOptions).load();
  const webClient = await new WebClient(dataDir, { auth }).load();
  const models = new Models(dataDir, {
    filename: options.modelFile ?? process.env.ROKBOT_MODEL_ENV ?? process.env.GROKBOT_MODEL_ENV,
    onModelSaved: options.onModelSaved,
    getReloadStatus: options.getReloadStatus,
    fetchImpl: options.modelFetch,
    autoSync: options.modelAutoSync !== false,
  });
  const modelSettings = await new DeviceModelSettings(dataDir).load();
  const updates = await new UpdatesManager(dataDir, {
    updateDir: options.updateDir,
    maxUploadBytes: options.maxUploadBytes,
    maxDeltaBytes: options.maxDeltaBytes,
  }).load();
  const library = await new Library(dataDir).load();
  // Canvases are written by the bot runtime; this service only reads and serves them.
  const canvasStore = new CanvasStore(dataDir), canvasLinks = new CanvasLinkOrigins(dataDir);
  const speech = await new Speech(dataDir).load();
  const voiceConfig = await new VoiceConfig(dataDir, { speech }).load();
  const synthesis = new VoiceSynthesis(voiceConfig);
  const mediaSettings = await new MediaSettings(dataDir).load(), webSettings = await new WebSettings(dataDir).load();
  const mediaServices = await new MediaServices(dataDir).load(), webServices = new WebServices(dataDir);
  const harness = await new HarnessSettings(dataDir).load();
  const prompts = await new PromptSettings(dataDir).load();
  const skills = await new Skills(dataDir, { hostDataDir }).load();
  await provisionTeachSkill(skills);
  const network = await new TailcatNetwork(dataDir, options.tailcatOptions).load();
  const executionNode = await new ExecutionNode(dataDir, { network }).load();
  const profile = await new Profile(dataDir).load();
  const connectors = await new Connectors(dataDir, {
    actorActive: actor => actor?.kind === "device" ? Boolean(auth.device(actor.id)) :
      actor?.kind === "admin" && auth.store.value.sessions.some(item => item.hash === actor.hash && item.expiresAt > Date.now()),
  }).load();
  const federation = await new Federation(dataDir, { profile, network, hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const push = await new PushService(dataDir, auth, { ...options.pushOptions, enabled: () => federation.role() === "primary" }).load();
  const plugins = await new Plugins(dataDir, { connectors, skills, hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const applications = await new Applications({ connectors, plugins, hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const webhooks = await new Webhooks(dataDir).load();
  const automationWebhooks = await new AutomationWebhooks(dataDir).load();
  const sharing = await new Sharing(dataDir, { skills, plugins, profile, publicUrl: canonical,
    hostCall: internalHostClient(hostUrl, internalToken) }).load();
  const migration = await new Migration(dataDir, { skills, library, hostCall: internalHostClient(hostUrl, internalToken) }).load();
  // A Bot's reply also prepares the input suggestions of that chat (SuggestionsService.prefetch).
  let suggestionsForReplies = null;
  const notifications = await new Notifications(dataDir, { onPublish: item => {
    try { suggestionsForReplies?.onAgentNotification(item); } catch {}
    return push.enqueue(item);
  } }).load();
  const notificationSettings = await new NotificationSettings(dataDir).load();
  const tickets = new VncTickets(auth, options.ticketOptions);
  const connections = new DeviceConnections();
  federation.onRoleChange = () => connections.close();
  const voice = new Voice({ config: voiceConfig, speech, synthesis, auth, connections,
    hostCall: internalHostClient(hostUrl, internalToken) });
  const modelContextSyncIntervalMs = options.modelContextSyncIntervalMs ?? 6 * 60 * 60_000;
  const modelContextSyncTimer = options.modelAutoSync !== false && modelContextSyncIntervalMs > 0
    ? setInterval(() => {
      void models.getSyncSettings().then(syncSettings => {
        if (syncSettings.autoSync) return models.syncAllProviders({ onlyAuto: true });
      }).catch(error => console.warn(`[models] periodic context sync failed: ${error.message}`));
    }, modelContextSyncIntervalMs)
    : null;
  modelContextSyncTimer?.unref();
  const desktopCapabilities = new DesktopCapabilities({ authenticate: device, connections, internalToken, enabled: () => harness.current().macComputer });
  const browserProviders = new DesktopBrowserProviders({ authenticate: device, connections, hostUrl, internalToken, enabled: key => harness.current()[key] });
  let executionRevision = executionNode.active()?.revision;
  const limiter = options.rateLimit ?? new RateLimit();
  const speedTest = createSpeedTest({ limiter });
  const suggestionsSettings = await new SuggestionsSettings(dataDir).load();
  const suggestions = await new SuggestionsService({
    models,
    settings: suggestionsSettings,
    hostCall: internalHostClient(hostUrl, internalToken),
    dataDir,
    fetchImpl: options.suggestionsFetch,
    ...options.suggestionsOptions,
  }).load();
  suggestionsForReplies = suggestions;
  // ?timeZone= (default: the Host's) and an optional ?period=today|7d|30d to return one period.
  const usage = url => {
    const timeZone = url.searchParams.get('timeZone') || process.env.TZ || 'UTC', period = url.searchParams.get('period') || undefined;
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
    catch { throw new HttpError(400, 'Invalid time zone'); }
    if (period && !USAGE_PERIODS.some(item => item.id === period)) throw new HttpError(400, 'Invalid period');
    return usageSummary(join(dataDir, 'usage'), timeZone, new Date(), { period });
  };
  // The usage report (host/runtime/usage-report.mjs): ?timeZone=&range=today|7d|30d|all|custom
  // (&from=&to= local dates), filters ?model=&provider=&profile=&kind=&agent=&status=, a page of
  // requests ?offset=&limit=, or ?export=csv for every request as { filename, csv, count }.
  // Bot and model profile names are looked up here; the ledger keeps only their ids.
  const usageHostCall = internalHostClient(hostUrl, internalToken);
  let usageNamesCache = null;
  const usageNames = async () => {
    if (usageNamesCache && Date.now() - usageNamesCache.at < 30000) return usageNamesCache.names;
    const [agents, config] = await Promise.all([
      usageHostCall('listAgents', {}, { signal: AbortSignal.timeout(4000) }).catch(() => null),
      models.publicConfig().catch(() => null),
    ]);
    const names = {
      agents: new Map((Array.isArray(agents) ? agents : []).filter(item => item?.id).map(item => [item.id, String(item.name ?? '').slice(0, 120) || item.id])),
      profiles: new Map((config?.profiles ?? []).filter(item => item?.id).map(item => [item.id, item.name || item.model || item.id])),
      providers: new Map((config?.providers ?? []).filter(item => item?.id).map(item => [item.id, item.name || item.id])),
    };
    // A failed bot lookup is retried on the next request instead of caching empty names.
    if (Array.isArray(agents)) usageNamesCache = { at: Date.now(), names };
    return names;
  };
  // Optional prices per model, per million tokens: { "model": { "input": 2, "output": 8, "cached": 0.5 } }.
  const usagePrices = async () => {
    try {
      const value = JSON.parse(await readFile(join(dataDir, 'usage-prices.json'), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  };
  const usageReportFor = async url => {
    const query = url.searchParams, timeZone = query.get('timeZone') || process.env.TZ || 'UTC';
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
    catch { throw new HttpError(400, 'Invalid time zone'); }
    const filters = Object.fromEntries(['model', 'provider', 'profile', 'kind', 'agent', 'status']
      .map(key => [key, query.get(key) || undefined]).filter(([, value]) => value));
    const options = { timeZone, range: query.get('range') || '7d', from: query.get('from') || undefined, to: query.get('to') || undefined,
      filters, offset: Number(query.get('offset') ?? 0), limit: Number(query.get('limit') ?? 50),
      names: await usageNames(), prices: await usagePrices() };
    try {
      return query.get('export') === 'csv' ? await usageExport(join(dataDir, 'usage'), options) : await usageReport(join(dataDir, 'usage'), options);
    } catch (error) {
      if (error instanceof UsageReportError) throw new HttpError(400, error.message);
      throw error;
    }
  };
  const sockets = new Set();
  function device(request, web = false) {
    check(federation.role() === 'primary', 403, 'Connect to the primary Host');
    // The web listener signs browsers in with an HttpOnly cookie; the main listener accepts bearer tokens only.
    const token = web ? webClient.deviceToken(request, request.rokbotOrigin) : bearer(request);
    const found = auth.authenticate(token);
    check(found && (found.platform === "web") === web, 401, "设备凭证无效，请重新配对");
    void auth.touch(found.id).catch(() => {});
    canvasLinks.observe(request.rokbotOrigin, web);
    return found;
  }
  function resolveDefaultMachineId() {
    const raw = process.env.ROKBOT_DEFAULT_MACHINE_ID ?? process.env.GROKBOT_DEFAULT_MACHINE_ID ?? "";
    return raw.trim() || null;
  }
  async function readHostVersion() {
    if (options.hostVersion) return options.hostVersion;
    const stateDir = resolve(process.env.ROKBOT_STATE_DIR ?? process.env.GROKBOT_STATE_DIR ?? join(dataDir, "runtime"));
    const status = await readJson(join(stateDir, "host-status.json"), null).catch(() => null);
    if (typeof status?.revision === "string" && status.revision.trim()) return status.revision.trim();
    const originalDir = resolve(process.env.ROKBOT_ORIGINAL_HOST ?? process.env.GROKBOT_ORIGINAL_HOST ?? "/research/original-host");
    const versionText = await readFile(join(originalDir, "version"), "utf8").catch(() => "");
    if (versionText.trim()) return versionText.trim();
    const manifest = await readJson(fileURLToPath(new URL("../recipes/host/manifest.json", import.meta.url)), null).catch(() => null);
    if (typeof manifest?.archive?.version === "string" && manifest.archive.version.trim()) return manifest.archive.version.trim();
    return null;
  }
  function canDeviceConfigureModel(found) {
    const policy = modelSettings.current();
    return Boolean(policy.envAllowed && policy.allowDeviceModelConfig && (isAdminPairedDevice(found) || policy.allowGuestModelConfig));
  }
  async function authorizeDeviceModel(request, found) {
    const policy = modelSettings.current();
    check(policy.envAllowed && policy.allowDeviceModelConfig, 403, "Host 已禁用客户端模型配置");
    if (isAdminPairedDevice(found) || policy.allowGuestModelConfig) return;
    const stepUp = request.headers["x-rokbot-admin-password"];
    if (typeof stepUp === "string" && stepUp.length > 0) {
      limiter.check(`local-model-pw:${request.socket.remoteAddress}`, 5);
      limiter.check(`local-model-pw:device:${found.id}`, 5);
      check(auth.initialized && await verifyPassword(stepUp, auth.store.value.admin), 403, "管理员密码不正确，无权修改模型配置");
      return;
    }
    throw new HttpError(403, "当前设备无权配置模型，请使用管理员密码配对或提供管理密码");
  }
  function admin(request) {
    check(
      auth.adminSession(cookie(request, adminCookie)),
      401,
      "请登录管理页面",
    );
  }
  function session(response, token, origin) {
    response.setHeader(
      "set-cookie",
      `${adminCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? Math.floor(auth.sessionMs / 1000) : 0}${origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  function vncAccess(request, url, path, origin, web = false) {
    check(federation.role() === 'primary', 403, 'Connect to the primary Host');
    const route = vncPath(
      path,
      request.headers.upgrade?.toLowerCase() === "websocket",
    );
    check(route, 404, "桌面资源不存在");
    let found, ticket, nativeAppTicket = false;
    if (!web && request.headers.authorization !== undefined) {
      found = device(request, false);
      ticket = tickets.issue(found.id, route.slot);
    } else {
      ticket =
        url.searchParams.get("ticket") ??
        cookie(request, `rokbot_vnc_${route.slot}`);
      const value = tickets.validate(ticket, route.slot);
      check(value && (auth.device(value.deviceId)?.platform === "web") === web, 401, "桌面访问票据已失效，请重新打开电脑预览");
      found = { id: value.deviceId };
      // The official apps' embedded viewers (iOS, and the Android "Bot computer" screen with its
      // take-over button) load noVNC as inline HTML, so their socket carries `Origin: null`. Accept that
      // only for a native app's ticket passed in the socket URL itself.
      nativeAppTicket =
        !web &&
        request.headers.upgrade?.toLowerCase() === "websocket" &&
        url.searchParams.get("ticket") === ticket &&
        NATIVE_APP_VNC_PLATFORMS.has(auth.device(value.deviceId)?.platform);
    }
    check(
      !request.headers.origin || request.headers.origin === origin ||
        (request.headers.origin === "null" && nativeAppTicket),
      403,
      "桌面请求来源不匹配",
    );
    url.searchParams.delete("ticket");
    const execution = executionNode.vnc(route.slot, `${route.path}${url.search}`);
    const activeRevision = executionNode.active()?.revision;
    if (activeRevision !== executionRevision) {
      executionRevision = activeRevision; connections.close();
    }
    return {
      target: targets[route.slot],
      path: `${route.path}${url.search}`,
      ...(execution ?? {}),
      deviceId: found.id,
      ticketCookie: `rokbot_vnc_${route.slot}=${ticket}; Path=/vnc/${route.slot}/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(tickets.ttlMs / 1000)}${origin.startsWith("https:") ? "; Secure" : ""}`,
    };
  }
  async function revokeDevice(id) {
    await auth.revoke(id);
    await push.revoke(id);
    tickets.revoke(id);
    connections.revoke(id);
  }
  async function cleanupPairedResult(result) {
    if (result.reused) {
      tickets.revoke(result.deviceId);
      connections.revoke(result.deviceId);
    }
    for (const dupId of result.revokedDuplicateIds ?? []) {
      await revokeDevice(dupId);
    }
  }
  async function sendPage(response, asset, method = "GET", type) {
    const bytes = await readFile(join(publicDir, asset));
    if (!type) response.setHeader("content-security-policy", PAGE_POLICY);
    response.writeHead(200, {
      "content-type": type ?? `${assetTypes[extname(asset)]}; charset=utf-8`,
      "content-length": bytes.length,
      ...(type ? { "cache-control": "public, max-age=86400" } : {}),
    });
    return response.end(method === "HEAD" ? undefined : bytes);
  }
  const webRoute = createWebRoutes({
    webClient,
    auth,
    federation,
    tickets,
    limiter,
    revokeDevice,
    cleanupPairedResult,
    sendPage,
    publicDir,
  });
  /** The other listener's origin: configured, or the same host name with that listener's public port. */
  function peerOrigin(origin, web) {
    const configured = web ? webCanonical : canonical;
    if (configured) return configured;
    const url = new URL(origin);
    url.port = String(publicPorts[web ? "web" : "main"] ?? (web ? webServer : server).address()?.port ?? "");
    return url.origin;
  }
  const webStatus = origin => ({ ...webClient.status(), url: `${peerOrigin(origin, true)}/web/` });
  async function hostStatus({ includeProfile = false } = {}) {
    try {
      const result = await fetch(new URL("/api/listAgents", hostUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(internalToken
            ? { authorization: `Bearer ${internalToken}` }
            : {}),
        },
        body: "{}",
        signal: AbortSignal.timeout(1800),
        redirect: "error",
      });
      if (!result.ok) {
        await result.body?.cancel();
        return { connected: false, agents: [] };
      }
      const agents = await result.json();
      if (!Array.isArray(agents)) return { connected: false, agents: [] };
      return {
        connected: true,
        busy: agents.some((item) => item.isRunning),
        agents: agents
          .filter((item) => !item.isHiddenFromSidebar)
          .map((item) => ({
            id: item.id,
            name: item.name,
            // Voice selection reads these local fields only for an authenticated
            // voice-session request. Regular admin status responses omit them.
            ...(includeProfile ? {
              title: typeof item.title === 'string' ? item.title.slice(0, 500) : '',
              description: typeof item.description === 'string' ? item.description.slice(0, 4000) : '',
            } : {}),
            isRunning: Boolean(item.isRunning),
            isGroup: Boolean(item.isGroup),
          })),
      };
    } catch {
      return { connected: false, agents: [] };
    }
  }
  async function verifyAgent(agentId, { includeProfile = false } = {}) {
    validateAgentId(agentId);
    const status = await hostStatus({ includeProfile });
    check(status.connected, 503, "Host 暂不可用，无法读取 Bot 资料库");
    const agent = status.agents.find((item) => item.id === agentId);
    check(agent, 404, "Bot 不存在");
    return agent;
  }
  async function adminRoutes(request, response, path, origin, url) {
    const method = request.method;
    if (method !== "GET") adminMutation(request, origin);
    if (method === "GET" && path === "/admin/api/session") {
      return sendJson(response, 200, {
        initialized: auth.initialized,
        authenticated: auth.adminSession(cookie(request, adminCookie)),
        publicUrl: origin,
      });
    }
    if (
      method === "POST" &&
      ["/admin/api/setup", "/admin/api/login"].includes(path)
    ) {
      limiter.check(`admin:${request.socket.remoteAddress}`, 5);
      const body = await jsonBody(request);
      const token = path.endsWith("/setup")
        ? await auth.setup(body.setupKey, body.password)
        : await auth.login(body.password);
      session(response, token, origin);
      return sendJson(response, 200, { ok: true });
    }
    admin(request);
    if (method === 'GET' && path === '/admin/api/voice') return sendJson(response, 200, voiceConfig.publicConfig());
    if (method === 'PUT' && path === '/admin/api/voice') return sendJson(response, 200, await voiceConfig.save(await jsonBody(request, 512 * 1024)));
    if (method === 'POST' && path === '/admin/api/voice/voices') {
      limiter.check(`voice-catalog:${request.socket.remoteAddress}`, 30);
      const input = await jsonBody(request);
      return sendJson(response, 200, await listFishVoices(voiceConfig.resolveCatalogConfig(input.tts), input));
    }
    if (method === 'POST' && path === '/admin/api/voice/test') {
      limiter.check(`voice-test:${request.socket.remoteAddress}`, 6);
      const { text } = await jsonBody(request, 8192);
      check(typeof text === 'string' && text.length <= 300, 400, '试听文字最多 300 字');
      const abort = new AbortController(); response.on('close', () => abort.abort());
      const chunks = [];
      for await (const chunk of synthesis.stream(text, { signal: abort.signal })) chunks.push(chunk);
      const wav = pcmWav(Buffer.concat(chunks));
      response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
      return response.end(wav);
    }
    if (await migrateAdmin(request, response, path, migration, { url, baseUrl: canonical ?? origin })) return;
    if (await tailcatAdmin(request, response, path, network)) return;
    if (await applicationsAdmin(request, response, path, applications, webhookOrigin(request, origin), { kind: 'admin', hash: hash(cookie(request, adminCookie)) })) return;
    if (await adminExtensions(request, response, path, { harness, skills, executionNode, plugins, webhooks, verifyAgent, sharing, federation, mediaSettings, webSettings, webServices, prompts })) return;
    if (method === 'GET' && path === '/admin/api/speech')
      return sendJson(response, 200, speech.publicConfig());
    if (method === 'PUT' && path === '/admin/api/speech')
      return sendJson(response, 200, await speech.save(await jsonBody(request)));
    if (method === 'POST' && path === '/admin/api/speech/test') {
      limiter.check(`speech-test:${request.socket.remoteAddress}`, 10);
      return speech.route(request, response);
    }
    if (path === "/admin/api/connectors" || path.startsWith("/admin/api/connectors/"))
      return sendJson(response, 200, await connectors.route("admin", method, path,
        method === "GET" ? {} : await jsonBody(request, 512 * 1024), webhookOrigin(request, origin),
        { kind: "admin", hash: hash(cookie(request, adminCookie)) }));
    if (method === "GET" && path === "/admin/api/profile")
      return sendJson(response, 200, profile.current());
    if (method === "PUT" && path === "/admin/api/profile")
      return sendJson(
        response,
        200,
        await profile.save(await jsonBody(request, 3 * 1024 * 1024), { allowHostName: true }),
      );
    if (method === "POST" && path === "/admin/api/logout") {
      await auth.logout(cookie(request, adminCookie));
      session(response, "", origin);
      return sendJson(response, 200, { ok: true });
    }
    if (method === "GET" && path === "/admin/api/status") {
      const [model, host] = await Promise.all([
        models.publicConfig(),
        hostStatus(),
      ]);
      return sendJson(response, 200, {
        startedAt: bootAt,
        publicUrl: origin,
        model: { ...model, devicePolicy: modelSettings.current() },
        host: { ...host, waitingForExecutionNode: !host.connected &&
          (process.env.ROKBOT_REQUIRE_EXECUTION_NODE ?? process.env.GROKBOT_REQUIRE_EXECUTION_NODE) === '1' && !executionNode.store.value.config.enabled },
        devices: push.devices(),
        pairingKeys: auth.pairingKeys(),
        webClient: webStatus(origin),
        notifications: {
          ...notificationSettings.current(),
          count: notifications.store.value.items.length,
          onlineSubscribers: notifications.clients.size,
          providers: [
            { id: "sse", name: "在线客户端", status: "ready" },
            { id: "bark", name: "Bark", status: "ready" },
            { id: "apns", name: "Apple APNs", status: push.config.publicConfig().ready ? "ready" : "unconfigured" },
            { id: "unifiedpush", name: "UnifiedPush", status: "ready" },
            { id: "ntfy", name: "ntfy", status: "ready" },
            { id: "webhook", name: "Webhook", status: "ready" },
            { id: "fcm", name: "Firebase FCM", status: push.config.publicConfig().fcm?.ready ? "ready" : "unconfigured" },
          ],
        },
      });
    }
    if (method === "GET" && path === "/admin/api/model/routing-log")
      return sendJson(response, 200, { items: await recentRouting(join(dataDir, 'routing')) });
    if (method === "GET" && path === "/admin/api/model")
      return sendJson(response, 200, { ...(await models.publicConfig()), devicePolicy: modelSettings.current() });
    if (method === "GET" && path === "/admin/api/model/policy")
      return sendJson(response, 200, modelSettings.current());
    if (method === "PUT" && path === "/admin/api/model/policy")
      return sendJson(response, 200, await modelSettings.save(await jsonBody(request)));
    if (method === "GET" && path === "/admin/api/usage")
      return sendJson(response, 200, await usage(new URL(request.url, origin)));
    if (method === "GET" && path === "/admin/api/usage/report")
      return sendJson(response, 200, await usageReportFor(new URL(request.url, origin)));
    if (method === "PUT" && path === "/admin/api/model")
      return sendJson(
        response,
        200,
        { ...(await models.save(await jsonBody(request))), devicePolicy: modelSettings.current() },
      );
    if (method === "POST" && path === "/admin/api/model/catalog") {
      limiter.check(`model-catalog:${request.socket.remoteAddress}`, 30);
      return sendJson(response, 200, await models.catalog(await jsonBody(request)));
    }
    if (method === "POST" && path === "/admin/api/model/resolve") {
      limiter.check(`model-resolve:${request.socket.remoteAddress}`, 30);
      return sendJson(response, 200, await models.resolve(await jsonBody(request)));
    }
    if (method === "POST" && path === "/admin/api/model/sync-contexts") {
      limiter.check(`model-sync-contexts:${request.socket.remoteAddress}`, 12);
      const syncResult = await models.syncAllProviders({ force: true, clearObserved: true });
      return sendJson(response, 200, { ...(await models.publicConfig()), devicePolicy: modelSettings.current(), syncResult });
    }
    if (method === "PUT" && path === "/admin/api/model/sync-settings") {
      return sendJson(response, 200, { ...(await models.saveSyncSettings(await jsonBody(request))), devicePolicy: modelSettings.current() });
    }
    if (method === "POST" && path === "/admin/api/model/observed/clear") {
      return sendJson(response, 200, { ...(await models.clearObserved(await jsonBody(request, 64 * 1024, { allowEmpty: true }))), devicePolicy: modelSettings.current() });
    }
    if (method === "POST" && path === "/admin/api/model/classify") {
      limiter.check(`classifier-test:${request.socket.remoteAddress}`, 10);
      return sendJson(response, 200, await models.classify(await jsonBody(request)));
    }
    if (method === "POST" && path === "/admin/api/model/test") {
      limiter.check(`model-test:${request.socket.remoteAddress}`, 5);
      return sendJson(
        response,
        200,
        await models.test(await jsonBody(request)),
      );
    }
    const summarize = /^\/admin\/api\/agents\/([a-f0-9-]{1,128})\/summarize$/.exec(path);
    if (method === 'POST' && summarize) {
      const agent = await verifyAgent(summarize[1]);
      check(!agent.isRunning, 409, 'Bot 正在运行，请在任务结束后再压缩');
      limiter.check(`manual-summary:${summarize[1]}`, 4, 10 * 60_000);
      const result = await internalHostClient(hostUrl, internalToken)('localApplicationRpc', {
        action: 'rokbot.manual-summary', agentId: summarize[1],
      });
      return sendJson(response, 200, { ...result, message: '上下文已压缩' });
    }
    if (method === "POST" && path === "/admin/api/pairing-keys")
      return sendJson(response, 201, await auth.createPairing());
    if (path === "/admin/api/web-client") {
      if (method === "PUT") {
        check(String(request.headers["content-type"] ?? "").split(";")[0].trim() === "application/zip", 415, "请上传 ZIP 格式的网页版界面包");
        await webClient.install(await rawBody(request));
      }
      else if (method === "PATCH") await webClient.setEnabled((await jsonBody(request)).enabled);
      else if (method === "DELETE") await webClient.remove();
      if (["GET", "PUT", "PATCH", "DELETE"].includes(method)) return sendJson(response, 200, webStatus(origin));
    }
    if (method === "POST" && path === "/admin/api/web-client/open") {
      // Opens the web client in the administrator's own browser without a pairing code: its sign-in
      // page exchanges the ticket for a cookie of the web client's origin. The fragment stays out of logs.
      check(webClient.available, 409, "请先上传并启用网页版");
      const { deviceName, clientDeviceId } = await jsonBody(request);
      const ticket = webClient.issueTicket(
        typeof deviceName === "string" && deviceName.trim() ? deviceName : "网页版",
        { clientDeviceId },
      );
      return sendJson(response, 201, { ok: true, url: `${peerOrigin(origin, true)}/web/login#ticket=${ticket}` });
    }
    if (method === "POST" && path === "/admin/api/devices/deduplicate") {
      return sendJson(response, 200, { ok: true, ...(await push.deduplicateDevices({ revokeDevice })) });
    }
    const deviceName = /^\/admin\/api\/devices\/([a-f0-9-]{36})$/.exec(path);
    if (method === "PATCH" && deviceName) {
      const body = await jsonBody(request);
      return sendJson(response, 200, await push.rename(deviceName[1], body.name));
    }
    const revoke = /^\/admin\/api\/devices\/([a-f0-9-]{36})\/revoke$/.exec(
      path,
    );
    if (method === "POST" && revoke) {
      await revokeDevice(revoke[1]);
      return sendJson(response, 200, { ok: true });
    }
    if (path === '/admin/api/notification-settings' && ['GET', 'PUT'].includes(method))
      return sendJson(response, 200, method === 'GET' ? notificationSettings.current() : await notificationSettings.save(await jsonBody(request)));
    if (path === '/admin/api/suggestions/settings' && ['GET', 'PUT'].includes(method))
      return sendJson(response, 200, method === 'GET' ? suggestionsSettings.current() : await suggestionsSettings.updateSettings(await jsonBody(request, 64 * 1024)));
    if (path === '/admin/api/suggestions/habits' && method === 'GET')
      return sendJson(response, 200, suggestions.habitsSummary());
    if ((path === '/admin/api/suggestions/habits' && method === 'DELETE') || (path === '/admin/api/suggestions/habits/clear' && method === 'POST'))
      return sendJson(response, 200, await suggestions.clearHabits());
    if (path === '/admin/api/suggestions/phrases' && method === 'GET')
      return sendJson(response, 200, suggestionsSettings.listPhrases());
    if (path === '/admin/api/suggestions/phrases' && method === 'POST')
      return sendJson(response, 201, await suggestionsSettings.addPhrase(await jsonBody(request, 16 * 1024)));
    if (path === '/admin/api/suggestions/phrases/reorder' && ['PUT', 'POST'].includes(method))
      return sendJson(response, 200, await suggestionsSettings.reorderPhrases(await jsonBody(request, 32 * 1024)));
    const adminPhraseMatch = /^\/admin\/api\/suggestions\/phrases\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (adminPhraseMatch && ['PUT', 'PATCH'].includes(method))
      return sendJson(response, 200, await suggestionsSettings.updatePhrase(adminPhraseMatch[1], await jsonBody(request, 16 * 1024)));
    if (adminPhraseMatch && method === 'DELETE')
      return sendJson(response, 200, await suggestionsSettings.deletePhrase(adminPhraseMatch[1]));
    if (path === "/admin/api/push" && ["GET", "PUT"].includes(method))
      return sendJson(response, 200, method === "GET" ? push.config.publicConfig() : await push.config.save(await jsonBody(request)));
    const devicePush = /^\/admin\/api\/devices\/([A-Za-z0-9-]+)\/push(\/test)?$/.exec(path);
    if (devicePush && method === "PUT" && !devicePush[2]) {
      const body = await jsonBody(request);
      return sendJson(response, 200, body.provider
        ? await push.register(devicePush[1], { push: body })
        : await push.setEnabled(devicePush[1], body.enabled));
    }
    if (devicePush && method === "POST" && devicePush[2]) {
      limiter.check(`push-test:${devicePush[1]}`, 10);
      const body = await jsonBody(request); await verifyAgent(body.agentId);
      return sendJson(response, 200, await push.test(devicePush[1], body.agentId));
    }
    if (method === "POST" && path === "/admin/api/notifications/test") {
      const body = await jsonBody(request);
      const { item } = await notifications.publish({
        type: "test",
        agentId: body.agentId,
        title: "RokBot 通知测试",
        body: "通知已从你的 Host 发送。点击后返回对应会话。",
      });
      return sendJson(response, 201, item);
    }
    if (method === "GET" && path === "/admin/api/notifications")
      return sendJson(response, 200, {
        items: notifications.list().slice(-100).reverse(),
      });
    if (method === "GET" && path === "/admin/api/updates")
      return sendJson(response, 200, updates.adminOverview(origin));
    if (method === "GET" && path === "/admin/api/updates/signing-key")
      return sendJson(response, 200, updates.signingKeySummary());
    if (["PATCH", "PUT"].includes(method) && path === "/admin/api/updates/settings")
      return sendJson(response, 200, await updates.setSettings(await jsonBody(request)));
    if (method === "POST" && path === "/admin/api/updates/upload")
      return sendJson(response, 201, await updates.handleUpload(request, url));
    if (method === "POST" && path === "/admin/api/updates/publish") {
      const published = await updates.publish(await jsonBody(request), origin);
      if (published?.release?.platform === "android") {
        const versionLabel = String(
          published.release.versionName || published.release.version || "new version",
        );
        const releaseKey = String(
          published.release.id || published.release.versionCode || Date.now(),
        ).replace(/[^A-Za-z0-9_.:-]/g, "_");
        const versionCode = Number.isInteger(published.release.versionCode)
          ? published.release.versionCode
          : undefined;
        await notifications.publish({
          id: `update-android-${releaseKey}`.slice(0, 160),
          type: "update",
          agentId: "system",
          targetPlatform: "android",
          version: versionLabel.slice(0, 64),
          ...(versionCode && versionCode > 0 ? { versionCode } : {}),
          title: "有新版本可用",
          body: `RokBot ${versionLabel} 已发布，可在后台自动准备更新。`,
          deepLink: "rokbot-local://updates/android",
        }).catch(() => {});
      }
      return sendJson(response, 201, published);
    }
    const deleteUpdate = /^\/admin\/api\/updates\/([^/]+)\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (method === "DELETE" && deleteUpdate)
      return sendJson(response, 200, await updates.remove(decodeURIComponent(deleteUpdate[1]), decodeURIComponent(deleteUpdate[2])));
    throw new HttpError(404, "接口不存在");
  }
  const updateSelfOrigins = process.env.ROKBOT_UPDATE_SELF_ORIGINS ?? process.env.GROKBOT_UPDATE_SELF_ORIGINS ?? "";
  // Shared by the /local/updates/* routes and the update proxy's self-target short-circuit.
  // Callers must have authenticated the device already.
  function matchLocalUpdate(request, path) {
    const localUpdateFeed = /^\/local\/updates\/([A-Za-z0-9._-]+)\.json$/i.exec(path);
    const legacyNestedUpdateFeed = /^\/local\/updates\/(?:macos|windows|linux|darwin-arm64|darwin-x64|win32-x64|linux-x64|linux-arm64)\.json\/([A-Za-z0-9._-]+)\.json$/i.exec(path);
    const updateFeedMatch = localUpdateFeed ?? legacyNestedUpdateFeed;
    if (request.method === "GET" && updateFeedMatch) return { feed: `${updateFeedMatch[1]}.json` };
    const localUpdateFile = /^\/local\/updates\/files\/([^/]+)\/([^/]+)$/.exec(path);
    if (localUpdateFile) return { platform: decodeURIComponent(localUpdateFile[1]), filename: localUpdateFile[2] };
    return null;
  }
  async function serveLocalUpdate(request, response, path, manifestOrigin) {
    const match = matchLocalUpdate(request, path);
    if (!match) return false;
    if (match.feed) {
      sendJson(response, 200, updates.manifestFor(match.feed, manifestOrigin));
      return true;
    }
    await updates.serveFile(request, response, match.platform, match.filename);
    return true;
  }
  async function handle(request, response, web = false) {
    securityHeaders(response);
    check(
      request.url?.startsWith("/") && !request.url.startsWith("//"),
      400,
      "请求地址无效",
    );
    const path = request.url.split("?")[0];
    const origin = requestOrigin(request, web);
    const mainOrigin = web ? peerOrigin(origin, false) : origin;
    delete request.headers['x-rokbot-tailcat-ingress'];
    delete request.headers['x-grokbot-tailcat-ingress'];
    request.rokbotOrigin = origin;
    const url = new URL(request.url, origin);
    // In-app canvas links need a device credential; public links only need the canvas public.
    // On the web listener a frame is a plain navigation (no x-rokbot-web header), so the
    // signed-in browser's session cookie (HttpOnly, SameSite=Strict) is the credential there.
    if (await routeCanvas(request, response, path, url, { store: canvasStore, authorize: () => {
      if (federation.role() !== 'primary') return false;
      if (web) return Boolean(webClient.browserDevice(request)?.device);
      try { device(request, false); return true; } catch { return false; }
    } })) return;
    if (web) {
      check(origin !== mainOrigin, 403, "网页版需要与管理页不同的地址");
      if (await webRoute(request, response, path, url, origin, mainOrigin)) return;
    } else {
      if (path.startsWith("/admin/api/"))
        return adminRoutes(request, response, path, origin, url);
      if (path === "/web" || path.startsWith("/web/"))
        return webMoved(request, response, path, url, peerOrigin(origin, true));
    }
    if (await mediaInternal(request, response, path, { internalToken, mediaServices, webServices })) return;
    if (!web && await migrateInbox(request, response, path, migration, { limiter })) return;
    if (request.method === 'POST' && ['/federation/v1/pair', '/federation/v1/sync', '/federation/v1/revoke'].includes(path)) {
      limiter.check(`federation:${request.socket.remoteAddress}`, 120);
      const envelope = await jsonBody(request, 512 * 1024);
      return sendJson(response, 200, path.endsWith('/pair') ? await federation.receivePair(envelope) : path.endsWith('/revoke') ? await federation.receiveRevocation(envelope) : await federation.receiveSync(envelope));
    }
    if (request.method === 'POST' && path.startsWith('/internal/federation/')) {
      check(internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
      return sendJson(response, 200, await federationInternal(federation, path.slice('/internal/federation/'.length), await jsonBody(request)));
    }
    const hook = /^\/hooks\/v1\/([a-f0-9-]{36})$/.exec(path);
    if (hook && request.method === 'POST') {
      const result = await webhooks.receive(request, hook[1], path);
      return sendJson(response, result.duplicate ? 200 : 202, result);
    }
    const automationHook = /^\/automations\/webhook\/([a-f0-9-]{36})$/.exec(path);
    if (automationHook && request.method === 'POST') {
      const result = await automationWebhooks.receive(request, automationHook[1], {
        verifyAutomation: async (agentId, localId) => {
          let list;
          try {
            list = await internalHostClient(hostUrl, internalToken)('getAgentAutomations', { id: agentId });
          } catch (error) {
            if (error instanceof HttpError && error.status < 500) return { exists: false, enabled: false };
            throw new HttpError(503, 'Host temporarily unavailable');
          }
          const item = Array.isArray(list) ? list.find(candidate => candidate.id === localId) : null;
          if (!item || !hasWebhookTrigger(item.trigger)) return { exists: false, enabled: false };
          return { exists: true, enabled: Boolean(item.isEnabled), name: item.name, createdAt: item.createdAt };
        },
      });
      return sendJson(response, 202, result);
    }
    if (request.method === 'POST' && path.startsWith('/internal/webhooks/')) {
      check(internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
      const body = await jsonBody(request);
      if (path === '/internal/webhooks/claim') return sendJson(response, 200, await webhooks.claim(body.worker));
      if (path === '/internal/webhooks/finish') return sendJson(response, 200, await webhooks.finish(body));
      throw new HttpError(404, 'Unknown webhook operation');
    }
    if (request.method === 'POST' && path.startsWith('/internal/automation-webhooks/')) {
      check(internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
      const body = await jsonBody(request);
      if (path === '/internal/automation-webhooks/credential') {
        check(typeof body?.agentId === 'string' && typeof body?.localId === 'string', 400, 'Invalid request');
        return sendJson(response, 200, await automationWebhooks.ensureCredential({
          agentId: body.agentId, localId: body.localId, createdAt: body.createdAt,
        }));
      }
      if (path === '/internal/automation-webhooks/claim') return sendJson(response, 200, await automationWebhooks.claim(body.worker));
      if (path === '/internal/automation-webhooks/finish') return sendJson(response, 200, await automationWebhooks.finish(body));
      throw new HttpError(404, 'Unknown automation webhook operation');
    }
    if (request.method === 'POST' && path.startsWith('/internal/sharing/')) {
      check(internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
      return sendJson(response, 200, await sharing.internal(path.slice('/internal/sharing/'.length), await jsonBody(request, 21 * 1024 * 1024)));
    }
    if (request.method === "GET" && ["/health", "/healthz"].includes(path))
      return sendJson(response, 200, {
        ok: true,
        initialized: auth.initialized,
      });
    if (request.method === "POST" && path === "/connect/pair") {
      return handleConnectPair({
        request,
        response,
        origin,
        auth,
        federation,
        limiter,
        legacyBundleIdFor: id => push.bundleIdOf(id),
        onPaired: cleanupPairedResult,
      });
    }
    if (request.method === 'GET' && ['/local/notification-settings', '/local/notification-settings/events'].includes(path)) {
      const found = device(request); connections.track(found.id, response);
      return path.endsWith('/events') ? notificationSettings.subscribe(response) : sendJson(response, 200, notificationSettings.current());
    }
    if (request.method === "POST" && path === "/internal/notifications") {
      check(
        internalToken && equal(bearer(request), internalToken),
        401,
        "内部凭证无效",
      );
      if (federation.role() === 'member') { await jsonBody(request); return sendJson(response, 200, { delegated: true }); }
      const result = await notifications.publish(await jsonBody(request));
      return sendJson(response, result.created ? 201 : 200, result.item);
    }
    if (request.method === 'POST' && path === '/internal/audio/transcriptions') {
      check(internalToken && equal(bearer(request), internalToken), 401, '内部凭证无效');
      return speech.route(request, response);
    }
    if (request.method === 'POST' && path === '/local/audio/transcriptions') {
      const found = device(request, web);
      limiter.check(`speech:${found.id}`, 30);
      connections.track(found.id, response);
      return speech.route(request, response);
    }
    if (request.method === 'POST' && path === '/local/voice/session') {
      const found = device(request, web); limiter.check(`voice-session:${found.id}`, 10);
      const { agentId, audioProcessing } = await jsonBody(request, 2048);
      return sendJson(response, 200, voice.issue(found.id, await verifyAgent(agentId, { includeProfile: true }), origin, audioProcessing));
    }
    if (request.method === 'GET' && path === '/local/voice/status') {
      device(request, web);
      return sendJson(response, 200, { enabled: voiceConfig.publicConfig().enabled && speech.publicConfig().enabled });
    }
    if (request.method === "POST" && path.startsWith("/internal/connectors/")) {
      check(internalToken && equal(bearer(request), internalToken), 401, "内部凭证无效");
      return sendJson(response, 200, await connectors.internal(path.slice("/internal/connectors/".length), await jsonBody(request, 512 * 1024)));
    }
    if (request.method === "GET" && path === "/connectors/oauth/callback") {
      let result;
      try { result = await connectors.oauth.complete(url.searchParams); }
      catch {
        response.writeHead(303, { location: "/connectors/result?status=error" });
        return response.end();
      }
      if (result.returnTo === "admin") {
        response.writeHead(303, { location: `/admin?view=connectors&authorization=${result.ok ? "success" : "error"}` });
        return response.end();
      }
      response.writeHead(303, { location: `/connectors/result?status=${result.ok ? "success" : "error"}` });
      return response.end();
    }
    if (path === "/local/connectors" || path.startsWith("/local/connectors/")) {
      const found = device(request, web);
      return sendJson(response, 200, await connectors.route("local", request.method, path,
        request.method === "GET" ? {} : await jsonBody(request, 512 * 1024), webhookOrigin(request, mainOrigin),
        { kind: "device", id: found.id }));
    }
    if (path.startsWith('/local/app-intents/')) {
      const found = device(request, web), intentMethod = path.slice('/local/app-intents/'.length);
      check(request.method === 'POST' && mobileAppIntentMethods.has(intentMethod), 404, 'App Intent method not found');
      limiter.check(`app-intents:${found.id}`, 120);
      return sendJson(response, 200, await mobileAppIntentRpc(internalHostClient(hostUrl, internalToken), intentMethod,
        await jsonBody(request, 512 * 1024, { allowEmpty: true })));
    }
    if (localPreferenceRpcPaths.has(path)) {
      // The 1.26 mobile app checks team and cloud-agent review preferences before it shows the
      // Auto-review switch. A self-hosted Host has neither, which `{}` says (as desktop and iOS do).
      device(request, web);
      check(request.method === "POST", 405, "不支持的请求方法");
      await jsonBody(request, 64 * 1024, { allowEmpty: true });
      return sendJson(response, 200, {});
    }
    if (path.startsWith("/local/mobile-rpc/")) {
      const found = device(request, web), method = path.slice("/local/mobile-rpc/".length);
      check(request.method === "POST" && mobileConnectorMethods.has(method), 404, "连接应用接口不存在");
      return sendJson(response, 200, await connectors.mobile(method,
        // The original client omits the body for parameterless RPC methods.
        await jsonBody(request, 512 * 1024, { allowEmpty: true }), webhookOrigin(request, mainOrigin), { kind: "device", id: found.id }));
    }
    if (path.startsWith("/vnc/")) {
      check(["GET", "HEAD"].includes(request.method), 405, "不支持的请求方法");
      const access = vncAccess(request, url, path, origin, web);
      connections.track(access.deviceId, response);
      // The web client's computer view gains the bridge (web-routes.mjs serves its scripts).
      const page = web && request.method === "GET" && /^\/vnc\/(desktop|fork)\/vnc(_lite|_auto)?\.html$/.test(path);
      return proxyHttp(request, response, page && webClient.available
        ? { ...access, transformHtml: html => WebClient.injectVncBridge(html, path.slice(0, path.lastIndexOf("/"))) } : access);
    }
    if (await desktopCapabilities.route(request, response, path)) return;
    if (await browserProviders.route(request, response, path)) return;
    if (
      proxyLocalExec(request, response, path, {
        authenticate: device,
        connections,
        hostUrl,
        internalToken,
      })
    ) return;
    if (request.method === "GET" && path === "/connect/status") {
      const hasCredential = web ? Boolean(cookie(request, "rokbot_web")) : request.headers.authorization !== undefined;
      const summary = await models.statusSummary();
      if (!hasCredential) {
        return sendJson(response, 200, {
          ok: true,
          brand: "RokBot",
          initialized: auth.initialized,
          needsModel: summary.needsModel,
          configured: summary.configured,
          connected: false,
          hostName: profile.current().hostName,
        });
      }
      const found = device(request, web);
      return sendJson(response, 200, {
        ok: true,
        brand: "RokBot",
        initialized: auth.initialized,
        needsModel: summary.needsModel,
        configured: summary.configured,
        connected: true,
        deviceId: found.id,
        deviceName: found.name,
        platform: found.platform,
      });
    }
    if (request.method === "GET" && path === "/local/status") {
      const found = device(request, web);
      const [summary, reload, hostVersion] = await Promise.all([
        models.statusSummary(),
        models.localReloadStatus(),
        readHostVersion(),
      ]);
      return sendJson(response, 200, {
        ok: true,
        brand: "RokBot",
        initialized: auth.initialized,
        configured: summary.configured,
        needsModel: summary.needsModel,
        canConfigureModel: canDeviceConfigureModel(found),
        pairedWith: found.pairedWith ?? null,
        hostVersion,
        defaultMachineId: resolveDefaultMachineId(),
        deviceId: found.id,
        deviceName: found.name,
        platform: found.platform,
        hostName: profile.current().hostName,
        reload,
      });
    }
    if (request.method === "GET" && path === "/local/model") {
      const found = device(request, web);
      await authorizeDeviceModel(request, found);
      const current = await models.currentOrEmpty();
      const configured = isConfiguredModelRouting(current.routing);
      return sendJson(response, 200, {
        ok: true,
        config: publicModelRouting(current.routing),
        hasJevApiKey: Boolean(current.jevApiKey),
        configured,
        needsModel: !configured,
        routingMigrated: current.routingMigrated,
        ...(current.corruptConfig ? { corruptConfig: true } : {}),
        reload: await models.localReloadStatus(),
        canConfigureModel: true,
      });
    }
    if (request.method === "PUT" && path === "/local/model") {
      const found = device(request, web);
      await authorizeDeviceModel(request, found);
      const saved = await models.save(await jsonBody(request));
      const current = await models.currentOrEmpty();
      return sendJson(response, 200, {
        ok: true,
        config: publicModelRouting(current.routing),
        hasJevApiKey: saved.hasJevApiKey,
        configured: saved.configured,
        needsModel: !saved.configured,
        reload: await models.localReloadStatus(),
        canConfigureModel: true,
      });
    }
    if (request.method === "POST" && path === "/local/model/catalog") {
      const found = device(request, web);
      await authorizeDeviceModel(request, found);
      limiter.check(`local-model-catalog:${found.id}`, 30);
      return sendJson(response, 200, { ok: true, ...(await models.catalog(await jsonBody(request))) });
    }
    if (request.method === "POST" && path === "/local/model/test") {
      const found = device(request, web);
      await authorizeDeviceModel(request, found);
      limiter.check(`local-model-test:${found.id}`, 10);
      return sendJson(response, 200, await models.test(await jsonBody(request)));
    }
    if (["GET", "PUT"].includes(request.method) && path === "/local/suggestions/settings") {
      const found = device(request, web);
      limiter.check(`suggestions-settings:${found.id}`, 60);
      return sendJson(
        response,
        200,
        request.method === "GET"
          ? suggestionsSettings.current()
          : await suggestionsSettings.updateSettings(await jsonBody(request, 64 * 1024)),
      );
    }
    if (path === "/local/suggestions/phrases" && request.method === "GET") {
      device(request, web);
      return sendJson(response, 200, suggestionsSettings.listPhrases());
    }
    if (path === "/local/suggestions/phrases" && request.method === "POST") {
      const found = device(request, web);
      limiter.check(`suggestions-phrases:${found.id}`, 60);
      return sendJson(response, 201, await suggestionsSettings.addPhrase(await jsonBody(request, 16 * 1024)));
    }
    if (path === "/local/suggestions/phrases/reorder" && ["PUT", "POST"].includes(request.method)) {
      const found = device(request, web);
      limiter.check(`suggestions-phrases:${found.id}`, 60);
      return sendJson(response, 200, await suggestionsSettings.reorderPhrases(await jsonBody(request, 32 * 1024)));
    }
    const localPhraseMatch = /^\/local\/suggestions\/phrases\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (localPhraseMatch && ["PUT", "PATCH"].includes(request.method)) {
      const found = device(request, web);
      limiter.check(`suggestions-phrases:${found.id}`, 60);
      return sendJson(response, 200, await suggestionsSettings.updatePhrase(localPhraseMatch[1], await jsonBody(request, 16 * 1024)));
    }
    if (localPhraseMatch && request.method === "DELETE") {
      const found = device(request, web);
      limiter.check(`suggestions-phrases:${found.id}`, 60);
      return sendJson(response, 200, await suggestionsSettings.deletePhrase(localPhraseMatch[1]));
    }
    if (request.method === "POST" && path === "/local/suggestions/feedback") {
      // A tapped suggestion or a dismissed strip: kept on this Host to rank this Bot's suggestions.
      const found = device(request, web);
      limiter.check(`suggestions-feedback:${found.id}`, 240);
      const body = await jsonBody(request, 16 * 1024, { allowEmpty: true });
      const rawAgentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
      check(/^[A-Za-z0-9_-]{1,128}$/.test(rawAgentId), 400, "Bot ID 无效");
      return sendJson(response, 200, await suggestions.feedback({
        agentId: rawAgentId,
        action: typeof body?.action === "string" ? body.action : "",
        text: typeof body?.text === "string" ? body.text : "",
        shown: Array.isArray(body?.shown) ? body.shown : [],
      }));
    }
    if (path === "/local/suggestions/habits" && request.method === "GET") {
      device(request, web);
      return sendJson(response, 200, suggestions.habitsSummary());
    }
    if ((path === "/local/suggestions/habits" && request.method === "DELETE")
      || (path === "/local/suggestions/habits/clear" && request.method === "POST")) {
      const found = device(request, web);
      limiter.check(`suggestions-habits:${found.id}`, 20);
      return sendJson(response, 200, await suggestions.clearHabits());
    }
    if (request.method === "POST" && path === "/local/suggestions/complete") {
      const found = device(request, web);
      limiter.check(`suggestions-complete:${found.id}`, 240);
      const body = await jsonBody(request, 32 * 1024, { allowEmpty: true });
      const rawAgentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
      if (rawAgentId) check(/^[A-Za-z0-9_-]{1,128}$/.test(rawAgentId), 400, "Bot ID 无效");
      check(body?.text === undefined || typeof body.text === "string", 400, "补全内容无效");
      // A newer keystroke closes this request on the client: stop the model call too.
      const abort = new AbortController();
      const cancel = () => { if (!response.writableEnded) abort.abort(new Error("Completion request cancelled")); };
      request.once("aborted", cancel);
      response.once("close", cancel);
      const result = await suggestions.complete({
        agentId: rawAgentId,
        lastEntryId: typeof body?.lastEntryId === "string" ? body.lastEntryId.slice(0, 128) : "",
        locale: typeof body?.locale === "string" ? body.locale.slice(0, 32) : "",
        text: typeof body?.text === "string" ? body.text.slice(0, 4000) : "",
        recentMessages: Array.isArray(body?.recentMessages) ? body.recentMessages.slice(-8) : undefined,
        signal: abort.signal,
      });
      if (abort.signal.aborted || response.destroyed) return;
      return sendJson(response, 200, result);
    }
    if (request.method === "POST" && path === "/local/suggestions") {
      const found = device(request, web);
      limiter.check(`suggestions:${found.id}`, 60);
      const body = await jsonBody(request, 32 * 1024, { allowEmpty: true });
      const rawAgentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
      if (rawAgentId) check(/^[A-Za-z0-9_-]{1,128}$/.test(rawAgentId), 400, "Bot ID 无效");
      const agentId = rawAgentId;
      const lastEntryId = typeof body?.lastEntryId === "string" ? body.lastEntryId.slice(0, 128) : "";
      const locale = typeof body?.locale === "string" ? body.locale.slice(0, 32) : "";
      const recentMessages = Array.isArray(body?.recentMessages) ? body.recentMessages.slice(-8) : undefined;
      // Echoed back so a client can drop a late answer to an older request.
      const requestId = typeof body?.requestId === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(body.requestId) ? body.requestId : "";
      if (body?.prefetch === true) {
        // Entering a chat: generate in the background; the request on focus hits the cache.
        const accepted = suggestions.prefetch({ agentId, locale });
        return sendJson(response, 202, { accepted, agentId, requestId });
      }
      return sendJson(response, 200, { ...await suggestions.generate({
        agentId,
        lastEntryId,
        locale,
        recentMessages,
        // The composer's reply quotes (what the next message replies to): context only.
        quotes: Array.isArray(body?.quotes) ? body.quotes.slice(0, 3) : undefined,
        force: body?.force === true,
      }), requestId });
    }
    if (["GET", "PUT"].includes(request.method) && path === "/local/device") {
      const found = device(request, web);
      return sendJson(
        response,
        200,
        request.method === "GET"
          ? push.get(found.id)
          : await push.register(found.id, await jsonBody(request), {
              onSuperseded: ids => {
                for (const id of ids) {
                  tickets.revoke(id);
                  connections.revoke(id);
                }
              },
            }),
      );
    }
    if (await handleUpdateProxy(request, response, path, url, {
      device,
      connections,
      selfOrigins: normalizeSelfOrigins([canonical, webCanonical, updateSelfOrigins, origin]),
      // Proxy already authenticated the device; serve the manifest/file in-process with the
      // same logic as the routes below, keeping URLs on the origin the client asked for.
      serveSelf: (req, res, selfPath, selfOrigin) => serveLocalUpdate(req, res, selfPath, selfOrigin),
    })) return;
    if (matchLocalUpdate(request, path)) {
      device(request);
      await serveLocalUpdate(request, response, path, updatesOriginFor(request, web));
      return;
    }
    const iosPlist = /^\/updates\/ios\/([^/]+)\/manifest\.plist$/.exec(path);
    if (iosPlist) {
      return updates.serveIosManifestPlist(request, response, decodeURIComponent(iosPlist[1]), origin);
    }
    const iosAltStore = /^\/updates\/ios\/([^/]+)\/altstore\.json$/.exec(path);
    if (iosAltStore) {
      return updates.serveIosAltStoreJson(request, response, decodeURIComponent(iosAltStore[1]), origin);
    }
    const iosFile = /^\/updates\/ios\/([^/]+)\/([^/]+)$/.exec(path);
    if (iosFile) {
      return updates.serveIosTokenArtifact(request, response, decodeURIComponent(iosFile[1]), iosFile[2]);
    }
    if (request.method === "POST" && path === "/local/device/push/test") {
      const found = device(request);
      limiter.check(`local-push-test:${found.id}`, 10);
      const body = await jsonBody(request);
      if (body.agentId) await verifyAgent(body.agentId);
      return sendJson(response, 200, await push.test(found.id, body.agentId || "rokbot-test", { bypassForeground: body.bypassForeground !== false }));
    }
    if (path === "/local/device/revoke") {
      const found = device(request);
      check(request.method === "POST", 405, "不支持的请求方法");
      await revokeDevice(found.id);
      return sendJson(response, 200, { ok: true, deviceId: found.id });
    }
    if (request.method === "GET" && path === "/local/computers") {
      device(request);
      const status = options.computers?.() ?? { available: false, computers: [] }, computers = new Map(status.computers.map(item => [item.id, item]));
      for (const item of desktopCapabilities.list()) {
        const previous = computers.get(item.machineId);
        computers.set(item.machineId, { ...previous, id: item.machineId, label: item.label, connected: true, platform: item.platform ?? 'darwin',
          capabilities: [...new Set([...(previous?.capabilities ?? []), 'gui'])] });
      }
      return sendJson(response, 200, { available: status.available || computers.size > 0, computers: [...computers.values()] });
    }
    if (path.startsWith("/local/speedtest/")) {
      const found = device(request);
      if (await speedTest.handle(request, response, path, url, found.id)) return;
    }
    if (request.method === "GET" && path === "/local/usage") {
      device(request, web);
      return sendJson(response, 200, await usage(url));
    }
    if (request.method === "GET" && path === "/local/usage/report") {
      device(request, web);
      return sendJson(response, 200, await usageReportFor(url));
    }
    if (["GET", "PUT"].includes(request.method) && path === "/local/profile") {
      const found = device(request, web);
      connections.track(found.id, response);
      const value =
        request.method === "GET"
          ? profile.current()
          : await profile.save(await jsonBody(request, 3 * 1024 * 1024));
      return sendJson(response, 200, value);
    }
    if (request.method === "GET" && path === "/local/files/content") {
      const found = device(request, web);
      connections.track(found.id, response);
      const agentId = url.searchParams.get("agentId");
      await verifyAgent(agentId);
      const file = await library.content({
        agentId,
        name: url.searchParams.get("name"),
      });
      if (response.destroyed) return;
      const encodedName = encodeURIComponent(file.name.toWellFormed()).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      response.writeHead(200, {
        "content-type": file.contentType,
        "content-length": file.bytes.length,
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
        "content-security-policy": "default-src 'none'; sandbox",
      });
      return response.end(file.bytes);
    }
    if (await routeCanvasApi(request, response, path, url, { store: canvasStore, origin,
      device: req => device(req, web), publicOrigin: async () => configuredCanvasOrigin() ?? mainOrigin })) return;
    if (
      path === "/local/files" &&
      ["GET", "POST", "DELETE"].includes(request.method)
    ) {
      const found = device(request, web);
      connections.track(found.id, response);
      const body =
        request.method === "GET"
          ? { agentId: url.searchParams.get("agentId") }
          : await jsonBody(request, 29 * 1024 * 1024);
      await verifyAgent(body.agentId);
      if (request.method === "GET")
        return sendJson(response, 200, await library.list(body.agentId));
      if (request.method === "POST")
        return sendJson(response, 200, await library.upload(body));
      await library.remove(body);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && path === "/connect/attachment") {
      const found = device(request, web);
      connections.track(found.id, response);
      const body = await jsonBody(request);
      return sendJson(
        response,
        200,
        await attachmentDataUrl(body.url, hostDataDir, attachmentUrlRoot),
      );
    }
    if (
      request.method === "GET" &&
      ["/notifications/events", "/notifications"].includes(path)
    ) {
      const found = device(request, web);
      connections.track(found.id, response);
      if (path.endsWith("/events")) {
        if (["ios", "android"].includes(found.platform) && request.headers["x-rokbot-foreground"] === "1")
          push.trackForegroundStream(found.id, response);
        return notifications.subscribe(request, response);
      }
      return sendJson(response, 200, {
        items: notifications.list(url.searchParams.get("after")),
      });
    }
    if (path === '/local/migrate' || path.startsWith('/local/migrate/')) {
      const found = device(request, web);
      connections.track(found.id, response);
      if (await migrateDevice(request, response, path, migration, { url, baseUrl: canonical ?? mainOrigin })) return;
    }
    if (
      (request.method === "POST" &&
        /^\/api\/[a-zA-Z][a-zA-Z0-9]*$/.test(path)) ||
      (request.method === "GET" && path === "/events")
    ) {
      const found = device(request, web);
      connections.track(found.id, response);
      check(!['/api/importLocalSharedBot', '/api/localApplicationRpc', '/api/importLocalMigrationBot', '/api/importLocalMigrationUserMemory'].includes(path), 403, 'Administrator operation');
      if (taskControlMethods.has(path.slice('/api/'.length))) {
        const method = path.slice('/api/'.length), input = await jsonBody(request, 64000);
        const remote = await federation.control(method, input);
        return sendJson(response, 200, remote ? { accepted: true } : await internalHostClient(hostUrl, internalToken)(method, input));
      }
      if (connectorApiMethods.has(path.slice("/api/".length)))
        return sendJson(response, 200, await connectors.original(path.slice("/api/".length),
          await jsonBody(request, 512 * 1024), webhookOrigin(request, mainOrigin), { kind: "device", id: found.id }));
      if (clientCompatMethods.has(path.slice("/api/".length))) {
        const method = path.slice("/api/".length);
        const input = await jsonBody(request, 128 * 1024, { allowEmpty: true });
        return sendJson(response, 200, await handleClientCompatRpc(method, input, internalHostClient(hostUrl, internalToken)));
      }
      if (path === "/api/deleteAgents")
        return deleteAgentsWithLibrary(request, response, {
          hostUrl,
          internalToken,
          library,
          automationWebhooks,
        });
      if (path === '/api/getAutomationWebhookCredential') {
        const input = await jsonBody(request, 64000);
        return sendJson(response, 200, await resolveAutomationWebhookCredential({
          automationWebhooks,
          agentId: input?.id,
          localId: input?.automationId,
          verifyAgent,
          hostCall: internalHostClient(hostUrl, internalToken),
          origin: webhookOrigin(request, mainOrigin),
        }));
      }
      return proxyHttp(request, response, {
        target: hostUrl,
        path: `${path}${url.search}`,
        token: internalToken,
        rewrite: (value) => rewriteSharingUrls(tickets.rewrite(value, found.id, origin), mainOrigin),
      });
    }
    if (["GET", "HEAD"].includes(request.method) && path === "/rokbot-icon.png") {
      return sendPage(response, "rokbot-icon.png", request.method, "image/png");
    }
    const asset = pages.get(path) ?? (publicAssets.has(path.slice(1)) ? path.slice(1) : null);
    if (asset && ["GET", "HEAD"].includes(request.method)) return sendPage(response, asset, request.method);
    throw new HttpError(404, "页面不存在");
  }
  /** One listener: the main one for the admin page and the apps, or the web client's (web-routes.mjs). */
  function listener(web) {
    const target = http.createServer((request, response) => {
      handle(request, response, web).catch((error) => {
        sendJson(response, error.status ?? 500, {
          error: error.status ? error.message : "服务处理失败，请检查服务日志",
        });
        if (!error.status)
          console.error(`[selfhost] request failed: ${error.code ?? error.name}`);
      });
    });
    target.requestTimeout = 600_000;
    target.headersTimeout = 30_000;
    target.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    target.on("upgrade", (request, socket, head) => {
      try {
        request.url = normalizeVncUpgradeUrl(request.url);
        check(
          request.url?.startsWith("/") && !request.url.startsWith("//"),
          400,
          "Invalid URL",
        );
        check(
          request.headers.upgrade?.toLowerCase() === "websocket",
          400,
          "Invalid upgrade",
        );
        const origin = requestOrigin(request, web);
        delete request.headers['x-rokbot-tailcat-ingress'];
        delete request.headers['x-grokbot-tailcat-ingress'];
        request.rokbotOrigin = origin;
        const url = new URL(request.url, origin);
        check(federation.role() === 'primary', 403, 'Connect to the primary Host');
        if (url.pathname === '/local/voice/realtime') return voice.upgrade(request, socket, head);
        const access = vncAccess(request, url, request.url.split("?")[0], origin, web);
        connections.track(access.deviceId, socket);
        proxyWebSocket(request, socket, head, access);
      } catch (error) {
        console.warn(vncUpgradeRejectionLog(request, error));
        socket.end(
          `HTTP/1.1 ${error.status ?? 500} Rejected\r\nConnection: close\r\n\r\n`,
        );
      }
    });
    return target;
  }
  const server = listener(false), webServer = listener(true);
  return {
    server,
    webServer,
    auth,
    models,
    modelSettings,
    updates,
    speech,
    voice, voiceConfig, synthesis,
    mediaSettings, webSettings, mediaServices,
    harness,
    prompts,
    skills,
    executionNode,
    plugins, applications,
    webhooks,
    automationWebhooks,
    sharing,
    federation,
    network,
    desktopCapabilities,
    notifications,
    notificationSettings,
    push,
    connectors,
    tickets,
    library,
    profile,
    webClient,
    suggestions,
    suggestionsSettings,
    dataDir,
    async start(
      port = Number(process.env.ROKBOT_PORT ?? process.env.GROKBOT_PORT ?? 8000),
      bind = process.env.ROKBOT_BIND ?? process.env.GROKBOT_BIND ?? "0.0.0.0",
      webPort = port === 0 ? 0 : Number(process.env.ROKBOT_WEB_PORT ?? process.env.GROKBOT_WEB_PORT ?? 8001),
    ) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bind, resolve);
      });
      try {
        await new Promise((resolve, reject) => {
          webServer.once("error", reject);
          webServer.listen(webPort, bind, resolve);
        });
      } catch (error) {
        await new Promise(resolve => server.close(resolve));
        throw error;
      }
      federation.start();
      void network.start(`127.0.0.1:${server.address().port}`).catch(() => {});
      if (options.modelAutoSync !== false) {
        void models.getSyncSettings().then(syncSettings => {
          if (syncSettings.autoSync) return models.syncAllProviders({ onlyAuto: true });
        }).catch(error => console.warn(`[models] startup context sync failed: ${error.message}`));
      }
      return server.address();
    },
    async close() {
      await federation.close();
      await network.close();
      desktopCapabilities.close(); browserProviders.close();
      if (modelContextSyncTimer) clearInterval(modelContextSyncTimer);
      await models.close();
      await voice.close(); await synthesis.close(); await voiceConfig.close();
      await speech.close();
      notifications.close();
      suggestions.close();
      notificationSettings.close();
      await push.close();
      await connectors.close();
      connections.close();
      for (const socket of sockets) socket.destroy();
      for (const target of [server, webServer])
        if (target.listening) await new Promise((resolve) => target.close(resolve));
      await Promise.all([
        canvasLinks.pending,
        auth.store.tail,
        models.tail,
        modelSettings.store.tail,
        updates.store.tail,
        notifications.store.tail,
        notificationSettings.store.tail,
        suggestionsSettings.store.tail,
        library.tail,
        library.index.tail,
        profile.store.tail,
        harness.store.tail,
        prompts.store.tail,
        skills.store.tail,
        executionNode.store.tail,
        plugins.store.tail, plugins.operations,
        webhooks.store.tail,
        automationWebhooks.store.tail,
        sharing.store.tail,
        mediaSettings.store.tail, webSettings.store.tail, mediaServices.store.tail,
        webClient.store.tail, webClient.installing,
      ]);
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const app = await createSelfHostServer();
    const address = await app.start();
    console.log(
      JSON.stringify({
        service: "rokbot-selfhost",
        port: address.port,
        initialized: app.auth.initialized,
        ...(app.auth.initialized
          ? {}
          : { setupKeyFile: join(app.dataDir, "setup-key") }),
      }),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await app.close();
        process.exit(0);
      });
  } catch (error) {
    console.error(`[selfhost] startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
