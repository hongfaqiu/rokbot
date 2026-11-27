package dev.rokbot.nativeapp;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * R8-compatible OkHttp Interceptor (Xl.w) for ai.x.grok.bot 1.27.0+ (build 3283).
 * Uses verified R8-obfuscated OkHttp/Okio methods in packages Xl.* and nm.*.
 */
public final class R8OkHttpInterceptor127 implements Xl.w {
    private static final long MAX_TRANSCRIBE_BYTES = 36L * 1024L * 1024L;
    private static final int MAX_VOICE_REQ_BYTES = 16384;
    private static final long MAX_APP_INTENT_BYTES = 1024L * 1024L;
    private static final long MAX_SHARING_BYTES = 8192L;

    private final Context mContext;

    public R8OkHttpInterceptor127(Context context) {
        this.mContext = context.getApplicationContext();
    }

    @Override
    public Xl.F intercept(Xl.w.a chain) throws IOException {
        Xl.D request = chain.l();
        Xl.v url = request.p();
        String host = (url != null && url.i() != null) ? GatewayEndpointRouter.normalizeHost(url.i()) : "";
        String path = url != null ? url.d() : "";
        String httpMethod = request.l() != null ? request.l().toUpperCase(Locale.US) : "GET";

        // 1. Block telemetry & upstream OTA checks
        if (GatewayEndpointRouter.isTelemetryHost(host)
                || GatewayEndpointRouter.isTelemetryPath(path)
                || "/updates/sand-mobile/api/manifest".equals(path)) {
            return new Xl.F.a()
                    .s(request)
                    .p(Xl.C.d)
                    .g(204)
                    .m("No Content")
                    .j("x-rokbot-telemetry-blocked", "1")
                    .b(Xl.G.b.d(new byte[0], Xl.y.e.b("application/json")))
                    .c();
        }

        // 2. Local RN SkillSheet publication bridge (https://rokbot.local/skill-publication)
        if (url != null && "https".equalsIgnoreCase(url.s())
                && "rokbot.local".equalsIgnoreCase(host)
                && "/skill-publication".equals(path)) {
            return handleSkillPublication(request);
        }

        // 3. Redirect cloud endpoints & native RPCs to Self-Hosted Gateway
        if (!GatewayEndpointRouter.isTargetCloudEndpoint(host)) observeSuggestionsAgent(path, request.a());
        if (GatewayEndpointRouter.isTargetCloudEndpoint(host)) {
            byte[] observedRaw = observeAgentId(path, request.a());
            boolean isVoiceMint = "POST".equals(httpMethod)
                    && "/aiserver.v1.GrokBotService/MintSandVoiceCallSecret".equals(path);
            boolean isTranscribe = "POST".equals(httpMethod)
                    && "/aiserver.v1.AiService/TranscribeAudio".equals(path);
            boolean isAppIntent = "POST".equals(httpMethod)
                    && GatewayEndpointRouter.getAppIntentMethod(path) != null;
            boolean isDashboard = "POST".equals(httpMethod)
                    && GatewayEndpointRouter.getDashboardMethod(path) != null;

            String token = Storage.getToken(mContext);
            if ((isVoiceMint || isTranscribe || isAppIntent || isDashboard) && (token == null || token.isEmpty())) {
                return jsonErrorResponse(request, 401, Localize.t(mContext, "未连接 Host。", "Not connected"));
            }
            // Auto-review switch preference reads: a paired Host has no team or cloud-agent settings.
            if ("POST".equals(httpMethod) && GatewayEndpointRouter.isLocalPreferenceRpc(path)
                    && token != null && !token.isEmpty()) {
                return jsonOkResponse(request, "{}");
            }

            String gatewayUrl;
            try {
                gatewayUrl = GatewayEndpointRouter.resolveGatewayBaseUrl(mContext);
            } catch (RuntimeException e) {
                throw new IOException("Host tunnel unavailable: " + e.getMessage(), e);
            }

            if (gatewayUrl != null && !gatewayUrl.isEmpty()) {
                String rewrittenPath = GatewayEndpointRouter.rewriteRpcPath(path);
                String trimmedBase = gatewayUrl.endsWith("/") ? gatewayUrl.substring(0, gatewayUrl.length() - 1) : gatewayUrl;
                String rawQuery = extractRawQuery(url != null ? url.toString() : "");
                String targetUrl = trimmedBase + rewrittenPath + rawQuery;

                Xl.D.a newReq = request.m().m(targetUrl);
                if (isTranscribe) {
                    byte[] raw = readRequestBodyBytes(request.a(), MAX_TRANSCRIBE_BYTES);
                    if (raw == null || raw.length > MAX_TRANSCRIBE_BYTES) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "无法读取录音。", "Could not read the recording."));
                    }
                    JSONObject parsed = GatewayEndpointRouter.parseJsonObject(raw);
                    if (parsed == null || !(parsed.opt("audio") instanceof String)) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "无法读取录音。", "Could not read the recording."));
                    }
                    try {
                        String audioB64 = parsed.getString("audio");
                        parsed.put("audioBase64", audioB64);
                        parsed.remove("audio");
                    } catch (Exception e) {
                        return jsonErrorResponse(request, 400, "Invalid transcription payload");
                    }
                    newReq.g("POST", createJsonRequestBody(parsed.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (isVoiceMint) {
                    byte[] raw = readRequestBodyBytes(request.a(), MAX_VOICE_REQ_BYTES);
                    if (raw == null && request.a() != null) {
                        return jsonErrorResponse(request, 413, "Voice session request too large");
                    }
                    JSONObject input = raw != null ? GatewayEndpointRouter.parseJsonObject(raw) : null;
                    String agentId = input != null ? input.optString("agentId", "") : "";
                    if (agentId.isEmpty()) agentId = GatewayEndpointRouter.getLastAgentId();
                    if (agentId == null || agentId.isEmpty() || agentId.length() > 256) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "请选择 Bot。", "Choose a Bot."));
                    }
                    JSONObject normalized = new JSONObject();
                    try {
                        normalized.put("agentId", agentId);
                        normalized.put("audioProcessing", GatewayEndpointRouter.resolveAudioProcessingMode());
                    } catch (Exception e) {
                        return jsonErrorResponse(request, 400, "Invalid voice request");
                    }
                    newReq.g("POST", createJsonRequestBody(normalized.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (isAppIntent) {
                    byte[] raw = observedRaw != null ? observedRaw : readRequestBodyBytes(request.a(), MAX_APP_INTENT_BYTES);
                    if (raw == null && request.a() != null) {
                        return jsonErrorResponse(request, 413, "App-intent payload too large");
                    }
                    JSONObject input = raw != null ? GatewayEndpointRouter.parseJsonObject(raw) : null;
                    if (input == null) input = new JSONObject();
                    String agentId = input.optString("agentId", "");
                    if (!agentId.isEmpty()) GatewayEndpointRouter.setLastAgentId(agentId);
                    newReq.g("POST", createJsonRequestBody(input.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (isDashboard) {
                    byte[] raw = observedRaw != null ? observedRaw : readRequestBodyBytes(request.a(), MAX_APP_INTENT_BYTES);
                    if (raw == null && request.a() != null) {
                        return jsonErrorResponse(request, 413, "Dashboard payload too large");
                    }
                    JSONObject input = raw != null ? GatewayEndpointRouter.parseJsonObject(raw) : null;
                    if (input == null) input = new JSONObject();
                    newReq.g("POST", createJsonRequestBody(input.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (observedRaw != null && request.a() != null) {
                    Xl.E origBody = request.a();
                    Xl.y mt = origBody.b() != null
                            ? origBody.b()
                            : Xl.y.e.b("application/json; charset=utf-8");
                    newReq.g(httpMethod, Xl.E.a.i(observedRaw, mt, 0, observedRaw.length));
                }

                if (token != null && !token.isEmpty()) {
                    newReq.e("Authorization", "Bearer " + token);
                }
                if (!GatewayEndpointRouter.hasSseAcceptHeader(request.h("Accept"))) {
                    newReq.e("Accept", "application/json");
                }
                if (RokBotBootstrap.isForeground()) {
                    newReq.e("x-rokbot-foreground", "1");
                }
                newReq.e("x-rokbot-client", "android-native/1.27.0");

                Xl.F resp;
                try {
                    resp = chain.a(newReq.b());
                } catch (IOException e) {
                    if (Storage.isTailcatEnabled(mContext)) {
                        TailcatManager.get().onRequestFailure(mContext);
                    }
                    throw e;
                }
                if (isVoiceMint && resp.j0() && resp.l() != null) {
                    byte[] respBytes;
                    try {
                        respBytes = readBoundedResponseBytes(resp.l(), MAX_VOICE_REQ_BYTES);
                    } finally {
                        try { resp.close(); } catch (Throwable ignored) {}
                    }
                    if (respBytes == null) {
                        return jsonErrorResponse(request, 502, Localize.t(mContext, "无法连接语音服务。", "Could not connect to the voice service."));
                    }
                    JSONObject cred = GatewayEndpointRouter.parseJsonObject(respBytes);
                    if (cred == null || !HostApiClient.isValidVoiceCredential(mContext, cred)) {
                        return jsonErrorResponse(request, 502, Localize.t(mContext, "无法连接语音服务。", "Could not connect to the voice service."));
                    }
                    GatewayEndpointRouter.rewriteVoiceCredentialUrls(mContext, cred);
                    return resp.W0()
                            .j("Content-Type", "application/json")
                            .b(Xl.G.b.d(cred.toString().getBytes(StandardCharsets.UTF_8), Xl.y.e.b("application/json")))
                            .c();
                }
                return resp;
            }
            if (isVoiceMint || isTranscribe || isAppIntent || isDashboard) {
                return jsonErrorResponse(request, 401, Localize.t(mContext, "未连接 Host。", "Not connected"));
            }
        }

        // 4. Direct local Host calls: verify origin (scheme+host+port, including Tailcat)
        String token = Storage.getToken(mContext);
        if (url != null && token != null && !token.isEmpty()) {
            String serverOriginUrl = GatewayEndpointRouter.resolveDirectServerOriginIfCandidate(mContext, host);
            String fullUrl = url.toString();
            String rewrittenTailcatUrl = GatewayEndpointRouter.rewriteStaleTailcatLoopbackUrl(mContext, fullUrl, serverOriginUrl);
            boolean isDirectServer = rewrittenTailcatUrl != null
                    || GatewayEndpointRouter.matchesServerOrigin(fullUrl, serverOriginUrl);
            if (isDirectServer) {
                Xl.D.a directReq = request.m();
                boolean modified = false;
                if (rewrittenTailcatUrl != null) {
                    directReq.m(rewrittenTailcatUrl);
                    modified = true;
                }
                String auth = request.h("Authorization");
                if (auth == null || auth.isEmpty()) {
                    directReq.e("Authorization", "Bearer " + token);
                    modified = true;
                }
                if (RokBotBootstrap.isForeground()) {
                    String fgHdr = request.h("x-rokbot-foreground");
                    if (fgHdr == null || fgHdr.isEmpty()) {
                        directReq.e("x-rokbot-foreground", "1");
                        modified = true;
                    }
                }
                String clientHdr = request.h("x-rokbot-client");
                if (clientHdr == null || clientHdr.isEmpty()) {
                    directReq.e("x-rokbot-client", "android-native/1.27.0");
                    modified = true;
                }
                Xl.D finalReq = modified ? directReq.b() : request;
                try {
                    return chain.a(finalReq);
                } catch (IOException e) {
                    if (Storage.isTailcatEnabled(mContext)) {
                        TailcatManager.get().onRequestFailure(mContext);
                    }
                    throw e;
                }
            }
        }

        return chain.a(request);
    }

    private Xl.F handleSkillPublication(Xl.D request) {
        if (!"POST".equalsIgnoreCase(request.l())) {
            return jsonOkResponse(request, "{\"error\":\"Invalid request\"}");
        }
        String token = Storage.getToken(mContext);
        if (token == null || token.isEmpty()) {
            return jsonOkResponse(request, "{\"error\":\"Not connected\"}");
        }
        byte[] raw = readRequestBodyBytes(request.a(), MAX_SHARING_BYTES);
        JSONObject args = raw != null ? GatewayEndpointRouter.parseJsonObject(raw) : new JSONObject();
        if (args == null) {
            return jsonOkResponse(request, "{\"error\":\"Invalid request\"}");
        }
        String method = args.optString("method", "");
        String workflowId = args.optString("workflowId", "");
        String agentId = args.optString("agentId", "");
        try {
            JSONObject reply = HostApiClient.shareSkillPublication(mContext, method, workflowId, agentId);
            return jsonOkResponse(request, reply.toString());
        } catch (Throwable t) {
            return jsonOkResponse(request, "{\"error\":\"Request failed\"}");
        }
    }

    /** Direct-Host requests: feed the input suggestions only (body is read, not consumed). */
    private void observeSuggestionsAgent(String path, Xl.E body) {
        if (body == null || !GatewayEndpointRouter.shouldObserveSuggestionsPath(path)) return;
        try {
            long len = body.a();
            if (len > 65536L) return;
            byte[] raw = readRequestBodyBytes(body, 65536L);
            if (raw != null && raw.length > 0) GatewayEndpointRouter.observeSuggestionsAgentFromJson(path, raw);
        } catch (Throwable ignored) {
        }
    }

    private byte[] observeAgentId(String path, Xl.E body) {
        if (body == null || !GatewayEndpointRouter.shouldObserveAgentIdPath(path)) return null;
        try {
            long len = body.a();
            if (len > 65536L) return null;
            byte[] raw = readRequestBodyBytes(body, 65536L);
            GatewayEndpointRouter.observeAgentIdFromJson(path, raw);
            return raw;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String extractRawQuery(String fullUrl) {
        if (fullUrl == null) return "";
        int q = fullUrl.indexOf('?');
        if (q < 0) return "";
        int h = fullUrl.indexOf('#', q);
        return h >= 0 ? fullUrl.substring(q, h) : fullUrl.substring(q);
    }

    private static Xl.F jsonOkResponse(Xl.D request, String json) {
        return new Xl.F.a()
                .s(request)
                .p(Xl.C.d)
                .g(200)
                .m("OK")
                .j("Content-Type", "application/json")
                .b(Xl.G.b.d(json.getBytes(StandardCharsets.UTF_8), Xl.y.e.b("application/json")))
                .c();
    }

    private static Xl.F jsonErrorResponse(Xl.D request, int code, String message) {
        JSONObject err = new JSONObject();
        try {
            err.put("error", message != null ? message : "Request failed");
        } catch (Throwable ignored) {}
        return new Xl.F.a()
                .s(request)
                .p(Xl.C.d)
                .g(code)
                .m(message != null ? message : "Error")
                .j("Content-Type", "application/json")
                .b(Xl.G.b.d(err.toString().getBytes(StandardCharsets.UTF_8), Xl.y.e.b("application/json")))
                .c();
    }

    private static Xl.E createJsonRequestBody(String json) {
        byte[] bytes = (json != null ? json : "{}").getBytes(StandardCharsets.UTF_8);
        return Xl.E.a.i(bytes, Xl.y.e.b("application/json; charset=utf-8"), 0, bytes.length);
    }

    private static byte[] readRequestBodyBytes(Xl.E body, long maxBytes) {
        if (body == null) return new byte[0];
        try {
            long len = body.a();
            if (len > maxBytes) return null;
            nm.h buf = new nm.h();
            body.h(buf);
            byte[] data = buf.B1();
            if (data != null && data.length > maxBytes) return null;
            return data != null ? data : new byte[0];
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static byte[] readBoundedResponseBytes(Xl.G body, int maxBytes) {
        if (body == null) return new byte[0];
        try (InputStream in = body.a()) {
            if (in == null) return new byte[0];
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > maxBytes) return null;
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } catch (Throwable ignored) {
            return null;
        }
    }
}
