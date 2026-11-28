package dev.rokbot.nativeapp;

import android.content.Context;
import android.media.audiofx.AcousticEchoCanceler;
import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Pure R8-safe gateway routing & endpoint classification helpers (zero okhttp3.* imports).
 * Shared by both un-obfuscated NetworkInterceptor and R8-obfuscated R8OkHttpInterceptor.
 */
public final class GatewayEndpointRouter {
    private static final Set<String> DASHBOARD_METHODS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "ListMarketplacePlugins",
            "ListPrivateMarketplacePlugins",
            "ListMarketplaces",
            "GetEffectiveUserPlugins",
            "GetAvailableMcpServers",
            "ListSandMcpTools",
            "ValidateMcpOAuthTokens",
            "InstallUserPlugin",
            "UninstallUserPlugin",
            "UpdateUserPlugin",
            "UpdateUserPluginVariables",
            "UpdateUserPluginInstall",
            "GetTeamPluginPopularity",
            "RenameMcpOAuthAccount",
            "DeleteMcpOAuthAccount",
            "CheckHttpMcpStatus",
            "CompleteMcpOAuth",
            "GetPluginDetails"
    )));

    private static final Set<String> GROKBOT_MOBILE_RPC_METHODS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "GetGrokBotMcpToolPermissions",
            "SetGrokBotMcpToolPermissions",
            "ListPublicGrokBotMarketplaceListings"
    )));

    private GatewayEndpointRouter() {}

    public static String getLastAgentId() {
        return RokBotBootstrap.getLastAgentId();
    }

    public static void setLastAgentId(String agentId) {
        RokBotBootstrap.setLastAgentId(agentId);
    }

    public static boolean shouldObserveAgentIdPath(String path) {
        return "/api/openAgentWindowed".equals(path)
                || "/api/getAgentTranscriptTail".equals(path)
                || "/api/getAgentTranscript".equals(path)
                || "/api/getAgentTranscriptWindow".equals(path)
                || "/api/sendPrompt".equals(path)
                || "/api/getAgent".equals(path)
                || "/api/updateAgent".equals(path)
                || "/api/getAgentAutomations".equals(path)
                || "/api/getAgentWorkflows".equals(path)
                || "/api/setAgentNotifyOnUpdates".equals(path)
                || "/api/markAgentRead".equals(path)
                || "/api/markAgentViewed".equals(path)
                || "/api/getForeverBoxStatus".equals(path);
    }

    public static void observeAgentIdFromJson(byte[] raw) {
        observeAgentIdFromJson(null, raw);
    }

    /**
     * Last agent (notifications, voice, ...) follows every observed request as before; the input
     * suggestions get the path too and only follow navigation signals (see SuggestionAgentTracker).
     */
    public static void observeAgentIdFromJson(String path, byte[] raw) {
        JSONObject obj = parseJsonObject(raw);
        if (obj != null) {
            String id = obj.optString("agentId", "");
            if (id.isEmpty()) id = obj.optString("id", "");
            if (id.isEmpty()) id = obj.optString("agent_id", "");
            if (!id.isEmpty() && id.length() <= 256) {
                setLastAgentId(id);
                ComposerSuggestionsOverlay.onGatewayRequest(path, id);
            }
        }
    }

    /**
     * Requests RN sends straight to the paired Host (direct / LAN mode, not a rewritten cloud
     * endpoint): only the input suggestions follow them, and only for navigation / transcript
     * paths. The last / viewing agent (notifications, voice) is left as it was.
     */
    public static boolean shouldObserveSuggestionsPath(String path) {
        return SuggestionAgentTracker.isNavigationPath(path) || SuggestionAgentTracker.isTranscriptPath(path);
    }

    public static void observeSuggestionsAgentFromJson(String path, byte[] raw) {
        JSONObject obj = parseJsonObject(raw);
        if (obj == null) return;
        String id = obj.optString("agentId", "");
        if (id.isEmpty()) id = obj.optString("id", "");
        if (id.isEmpty()) id = obj.optString("agent_id", "");
        if (!id.isEmpty() && id.length() <= 256) ComposerSuggestionsOverlay.onGatewayRequest(path, id);
    }

    public static JSONObject parseJsonObject(byte[] data) {
        if (data == null || data.length == 0) return null;
        try {
            return new JSONObject(new String(data, StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static boolean hasSseAcceptHeader(String acceptHeader) {
        return acceptHeader != null && acceptHeader.toLowerCase(Locale.US).contains("text/event-stream");
    }

    public static String resolveGatewayBaseUrl(Context context) {
        String gatewayUrl = TailcatManager.get().resolveServerUrl(context);
        if ((gatewayUrl == null || gatewayUrl.isEmpty()) && !Storage.isTailcatEnabled(context)) {
            gatewayUrl = Storage.getGatewayUrl(context);
        }
        return gatewayUrl;
    }

    public static boolean isLoopbackHost(String host) {
        String h = normalizeHost(host);
        return "127.0.0.1".equals(h) || "localhost".equals(h) || "::1".equals(h) || "[::1]".equals(h);
    }

    public static String resolveDirectServerOriginIfCandidate(Context context, String reqHost) {
        if (context == null || reqHost == null || reqHost.isEmpty()) return null;
        if (Storage.isTailcatEnabled(context)) {
            if (!isLoopbackHost(reqHost)) {
                return null;
            }
            try {
                return TailcatManager.get().resolveServerUrl(context);
            } catch (RuntimeException ignored) {
                return null;
            }
        }
        return Storage.getGatewayUrl(context);
    }

    public static int effectivePort(URI uri) {
        if (uri == null) return -1;
        int port = uri.getPort();
        if (port > 0) return port;
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme) || "wss".equalsIgnoreCase(scheme)) return 443;
        if ("http".equalsIgnoreCase(scheme) || "ws".equalsIgnoreCase(scheme)) return 80;
        return -1;
    }

    private static String stripQueryAndFragment(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        int h = s.indexOf('#');
        if (h >= 0) s = s.substring(0, h);
        return s;
    }

    public static boolean matchesServerOrigin(String requestUrl, String serverUrl) {
        if (requestUrl == null || requestUrl.isEmpty() || serverUrl == null || serverUrl.isEmpty()) {
            return false;
        }
        try {
            URI req = URI.create(stripQueryAndFragment(requestUrl));
            URI srv = URI.create(stripQueryAndFragment(serverUrl));
            String rScheme = req.getScheme();
            String sScheme = srv.getScheme();
            String rHost = normalizeHost(req.getHost());
            String sHost = normalizeHost(srv.getHost());
            if (rScheme == null || sScheme == null || !rScheme.equalsIgnoreCase(sScheme)) {
                return false;
            }
            if (rHost.isEmpty() || sHost.isEmpty() || !rHost.equals(sHost)) {
                return false;
            }
            int rPort = effectivePort(req);
            int sPort = effectivePort(srv);
            return rPort > 0 && rPort == sPort;
        } catch (Throwable ignored) {
            return false;
        }
    }

    interface PortPredicate {
        boolean test(int port);
    }

    /**
     * If Tailcat is enabled and requestUrl targets a previously active Tailcat loopback port that
     * differs from the active serverOriginUrl, rewrites scheme+host+port to serverOriginUrl while
     * preserving the original path, query, and fragment. Unrelated localhost ports are left untouched.
     */
    public static String rewriteStaleTailcatLoopbackUrl(Context context, String requestUrl, String serverOriginUrl) {
        if (context == null || !Storage.isTailcatEnabled(context)) {
            return null;
        }
        return rewriteStaleLoopbackUrlWithKnownPorts(requestUrl, serverOriginUrl,
                TailcatManager.get()::isKnownTailcatPort);
    }

    static String rewriteStaleLoopbackUrlWithKnownPorts(String requestUrl, String serverOriginUrl, PortPredicate isKnownPort) {
        if (requestUrl == null || requestUrl.isEmpty()
                || serverOriginUrl == null || serverOriginUrl.isEmpty()
                || isKnownPort == null) {
            return null;
        }
        try {
            String trimmedReq = requestUrl.trim();
            URI req = URI.create(stripQueryAndFragment(trimmedReq));
            URI srv = URI.create(stripQueryAndFragment(serverOriginUrl));
            String rScheme = req.getScheme();
            String sScheme = srv.getScheme();
            String rHost = normalizeHost(req.getHost());
            String sHost = normalizeHost(srv.getHost());
            if (rScheme == null || sScheme == null || !isLoopbackHost(rHost) || !isLoopbackHost(sHost)) {
                return null;
            }
            String rSchemeLower = rScheme.toLowerCase(Locale.US);
            boolean isWs = "ws".equals(rSchemeLower) || "wss".equals(rSchemeLower);
            boolean isHttp = "http".equals(rSchemeLower) || "https".equals(rSchemeLower);
            if (!isWs && !isHttp) {
                return null;
            }
            int rPort = effectivePort(req);
            int sPort = effectivePort(srv);
            if (rPort <= 0 || sPort <= 0 || rPort == sPort) {
                return null;
            }
            if (!isKnownPort.test(rPort)) {
                return null;
            }
            int schemeEnd = trimmedReq.indexOf("://");
            if (schemeEnd < 0) return null;
            int authStart = schemeEnd + 3;
            int suffixStart = trimmedReq.length();
            for (int i = authStart; i < trimmedReq.length(); i++) {
                char c = trimmedReq.charAt(i);
                if (c == '/' || c == '?' || c == '#') {
                    suffixStart = i;
                    break;
                }
            }
            String suffix = trimmedReq.substring(suffixStart);
            String targetScheme = isWs
                    ? ("https".equalsIgnoreCase(sScheme) ? "wss" : "ws")
                    : sScheme.toLowerCase(Locale.US);
            return targetScheme + "://" + sHost + ":" + sPort + suffix;
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static String resolveAudioProcessingMode() {
        boolean aecAvail = false;
        try {
            aecAvail = AcousticEchoCanceler.isAvailable();
        } catch (Throwable ignored) {}
        return aecAvail ? "native-aec3-buffered-v1" : "legacy";
    }

    public static void rewriteVoiceCredentialUrls(Context context, JSONObject cred) {
        if (cred == null) return;
        try {
            for (String key : new String[]{"websocketUrl", "wsUrl", "url"}) {
                String wsVal = cred.optString(key, "");
                if (!wsVal.isEmpty()) {
                    cred.put(key, HostApiClient.rewriteVoiceWebsocketUrl(context, wsVal));
                }
            }
        } catch (Throwable ignored) {}
    }

    public static String getAppIntentMethod(String path) {
        if (path == null) return null;
        String prefix = "/aiserver.v1.GrokBotService/";
        if (!path.startsWith(prefix)) return null;
        String method = path.substring(prefix.length());
        if ("ListGrokBotAgents".equals(method)
                || "SendGrokBotUserMessage".equals(method)
                || "GetGrokBotSendStatus".equals(method)) {
            return method;
        }
        return null;
    }

    public static String getDashboardMethod(String path) {
        if (path == null) return null;
        String dashPrefix = "/aiserver.v1.DashboardService/";
        if (path.startsWith(dashPrefix)) {
            String method = path.substring(dashPrefix.length());
            return DASHBOARD_METHODS.contains(method) ? method : null;
        }
        String grokPrefix = "/aiserver.v1.GrokBotService/";
        if (path.startsWith(grokPrefix)) {
            String method = path.substring(grokPrefix.length());
            return GROKBOT_MOBILE_RPC_METHODS.contains(method) ? method : null;
        }
        return null;
    }

    /** Voice-memo playback: { text, voiceId } -> { audio: base64, mimeType } (Host /local/audio/speech). */
    public static final String TEXT_TO_SPEECH_RPC = "/aiserver.v1.AiService/TextToSpeech";

    /** Adds the current Bot so the Host can apply its voice; the official request carries none. */
    public static byte[] normalizeTextToSpeechBody(byte[] raw) {
        if (raw == null) return null;
        try {
            org.json.JSONObject input = new org.json.JSONObject(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
            if (!(input.opt("text") instanceof String)) return null;
            String agentId = input.optString("agentId", "");
            String last = getLastAgentId();
            if (agentId.isEmpty() && last != null && !last.isEmpty() && last.length() <= 256) input.put("agentId", last);
            return input.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * Bot avatar page > Generate: { description, modelId, maxMode, aspectRatio } ->
     * { success: { imageData: base64, mimeType } } | { error: { error } } (Host /local/avatar/generate).
     */
    public static final String AVATAR_IMAGE_RPC = "/aiserver.v1.AiService/RunGenerateImage";

    /**
     * Keeps the prompt and aspect ratio only: the official modelId names a cloud model, and the
     * Host generates with its own default image model.
     */
    public static byte[] normalizeAvatarImageBody(byte[] raw) {
        if (raw == null || raw.length == 0) return null;
        try {
            org.json.JSONObject input = new org.json.JSONObject(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
            Object description = input.opt("description");
            if (!(description instanceof String) || ((String) description).trim().isEmpty()) return null;
            org.json.JSONObject output = new org.json.JSONObject();
            output.put("description", description);
            Object aspectRatio = input.opt("aspectRatio");
            if (aspectRatio instanceof String && !((String) aspectRatio).isEmpty()) output.put("aspectRatio", aspectRatio);
            return output.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static String rewriteRpcPath(String path) {
        if (path == null) return null;
        if ("/aiserver.v1.GrokBotService/MintSandVoiceCallSecret".equals(path)) {
            return "/local/voice/session";
        }
        if ("/aiserver.v1.AiService/TranscribeAudio".equals(path)) {
            return "/local/audio/transcriptions";
        }
        if (TEXT_TO_SPEECH_RPC.equals(path)) {
            return "/local/audio/speech";
        }
        if (AVATAR_IMAGE_RPC.equals(path)) {
            return "/local/avatar/generate";
        }
        String appIntentMethod = getAppIntentMethod(path);
        if (appIntentMethod != null) {
            return "/local/app-intents/" + appIntentMethod;
        }
        String dashMethod = getDashboardMethod(path);
        if (dashMethod != null) {
            return "/local/mobile-rpc/" + dashMethod;
        }
        return path;
    }

    /** RPCs answered on the device once paired (mirrors iOS RBLocalPreferenceResponse). */
    public static boolean isLocalPreferenceRpc(String path) {
        return "/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam".equals(path)
                || "/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings".equals(path);
    }

    public static boolean isTelemetryPath(String path) {
        return "/aiserver.v1.AnalyticsService/TrackEvents".equals(path)
                || "/aiserver.v1.AnalyticsService/SubmitLogs".equals(path);
    }

    public static String normalizeHost(String host) {
        if (host == null) return "";
        String h = host.trim().toLowerCase(Locale.US);
        while (h.endsWith(".")) {
            h = h.substring(0, h.length() - 1);
        }
        return h;
    }

    private static boolean matchesDomain(String host, String domain) {
        return host.equals(domain) || host.endsWith("." + domain);
    }

    public static boolean isTelemetryHost(String host) {
        String h = normalizeHost(host);
        if (h.isEmpty()) return false;
        return matchesDomain(h, "sentry.io")
                || matchesDomain(h, "appboy.com")
                || matchesDomain(h, "braze.com")
                || matchesDomain(h, "appsflyer.com")
                || matchesDomain(h, "appsflyersdk.com")
                || matchesDomain(h, "statsig.com")
                || matchesDomain(h, "statsigcdn.com")
                || matchesDomain(h, "statsigapi.net")
                || matchesDomain(h, "api3.cursor.sh")
                || matchesDomain(h, "u.expo.dev");
    }

    public static boolean isTargetCloudEndpoint(String host) {
        String h = normalizeHost(host);
        if (h.isEmpty()) return false;
        return matchesDomain(h, "grok.bot")
                || matchesDomain(h, "grok.ai")
                || matchesDomain(h, "grok.com")
                || matchesDomain(h, "x.ai")
                || matchesDomain(h, "api2.cursor.sh")
                || matchesDomain(h, "sand.cursor.sh")
                || matchesDomain(h, "cursor.sh")
                || matchesDomain(h, "cursor.com")
                || matchesDomain(h, "anysphere.co")
                || matchesDomain(h, "rokbot.local");
    }
}
