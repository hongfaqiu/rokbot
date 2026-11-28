package dev.rokbot.nativeapp;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * R8-compatible OkHttp Interceptor (oj.v) for ai.x.grok.bot 1.16.0+.
 * Uses GatewayEndpointRouter (zero okhttp3.* class references) and HostApiClient.
 */
public final class R8OkHttpInterceptor implements oj.v {
    private static final long MAX_TRANSCRIBE_BYTES = 36L * 1024L * 1024L;
    private static final long MAX_SPEECH_REQ_BYTES = 64L * 1024L;
    private static final long MAX_AVATAR_REQ_BYTES = 128L * 1024L;
    private static final int MAX_VOICE_REQ_BYTES = 16384;
    private static final long MAX_APP_INTENT_BYTES = 1024L * 1024L;
    private static final long MAX_SHARING_BYTES = 8192L;

    private final Context mContext;

    public R8OkHttpInterceptor(Context context) {
        mContext = context.getApplicationContext();
    }

    @Override
    public oj.E a(oj.v.a chain) throws IOException {
        oj.C request = chain.r();
        oj.u url = request.p();
        String host = url != null ? GatewayEndpointRouter.normalizeHost(url.f()) : "";
        String path = url != null ? url.c() : "";
        String httpMethod = request.l() != null ? request.l().toUpperCase(Locale.US) : "GET";

        // 1. Telemetry / crash reporting / OTA update manifest suppression
        if (GatewayEndpointRouter.isTelemetryHost(host)
                || GatewayEndpointRouter.isTelemetryPath(path)
                || "/updates/sand-mobile/api/manifest".equals(path)) {
            return new oj.E.a()
                    .s(request)
                    .p(oj.B.d)
                    .g(204)
                    .m("No Content")
                    .j("x-rokbot-telemetry-blocked", "1")
                    .b(oj.F.a.d(new byte[0], oj.x.e.c("application/json")))
                    .c();
        }

        // 2. Local RN SkillSheet publication bridge (https://rokbot.local/skill-publication)
        if (url != null && "https".equalsIgnoreCase(url.q())
                && "rokbot.local".equalsIgnoreCase(host)
                && "/skill-publication".equals(path)) {
            return handleSkillPublication(request);
        }

        // 3. Rewrite official RokBot / Sand / Cursor cloud endpoints to paired RokBot Host
        if (!GatewayEndpointRouter.isTargetCloudEndpoint(host)) observeSuggestionsAgent(path, request.a());
        if (GatewayEndpointRouter.isTargetCloudEndpoint(host)) {
            byte[] observedRaw = observeAgentId(path, request.a());
            boolean isVoiceMint = "POST".equals(httpMethod)
                    && "/aiserver.v1.GrokBotService/MintSandVoiceCallSecret".equals(path);
            boolean isTranscribe = "POST".equals(httpMethod)
                    && "/aiserver.v1.AiService/TranscribeAudio".equals(path);
            boolean isTextToSpeech = "POST".equals(httpMethod)
                    && GatewayEndpointRouter.TEXT_TO_SPEECH_RPC.equals(path);
            boolean isAvatarImage = "POST".equals(httpMethod)
                    && GatewayEndpointRouter.AVATAR_IMAGE_RPC.equals(path);
            boolean isAppIntent = "POST".equals(httpMethod)
                    && GatewayEndpointRouter.getAppIntentMethod(path) != null;
            boolean isDashboard = "POST".equals(httpMethod)
                    && GatewayEndpointRouter.getDashboardMethod(path) != null;

            String token = Storage.getToken(mContext);
            if ((isVoiceMint || isTranscribe || isTextToSpeech || isAvatarImage || isAppIntent || isDashboard) && (token == null || token.isEmpty())) {
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
                String query = extractRawQuery(url != null ? url.toString() : null);
                String base = gatewayUrl.endsWith("/")
                        ? gatewayUrl.substring(0, gatewayUrl.length() - 1)
                        : gatewayUrl;
                String targetUrl = base + rewrittenPath + (query != null && !query.isEmpty() ? "?" + query : "");

                oj.C.a newReq = request.m().l(targetUrl);
                if (isVoiceMint) {
                    byte[] raw = readRequestBodyBytes(request.a(), MAX_VOICE_REQ_BYTES);
                    if (raw == null) return jsonErrorResponse(request, 413, "Voice session request too large");
                    JSONObject input = parseJsonObject(raw);
                    String agentId = input != null ? input.optString("agentId", "") : "";
                    if (agentId.isEmpty()) agentId = GatewayEndpointRouter.getLastAgentId();
                    if (agentId == null || agentId.isEmpty() || agentId.length() > 256) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "请选择 Bot。", "Choose a Bot."));
                    }
                    JSONObject normalized = new JSONObject();
                    try {
                        normalized.put("agentId", agentId);
                        normalized.put("audioProcessing", GatewayEndpointRouter.resolveAudioProcessingMode());
                    } catch (Throwable ignored) {}
                    newReq.g("POST", createJsonRequestBody(normalized.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (isTranscribe) {
                    byte[] raw = readRequestBodyBytes(request.a(), MAX_TRANSCRIBE_BYTES);
                    if (raw == null) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "无法读取录音。", "Could not read the recording."));
                    }
                    JSONObject parsed = parseJsonObject(raw);
                    if (parsed == null || !(parsed.opt("audio") instanceof String)) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "无法读取录音。", "Could not read the recording."));
                    }
                    try {
                        String audioB64 = parsed.getString("audio");
                        parsed.put("audioBase64", audioB64);
                        parsed.remove("audio");
                    } catch (Throwable e) {
                        return jsonErrorResponse(request, 400, "Invalid transcription payload");
                    }
                    newReq.g("POST", createJsonRequestBody(parsed.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (isTextToSpeech) {
                    byte[] speechBody = GatewayEndpointRouter.normalizeTextToSpeechBody(
                            readRequestBodyBytes(request.a(), MAX_SPEECH_REQ_BYTES));
                    if (speechBody == null) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "无法朗读这条消息。", "Could not read this message aloud."));
                    }
                    newReq.g("POST", createJsonRequestBody(new String(speechBody, StandardCharsets.UTF_8)));
                    newReq.e("Content-Type", "application/json");
                } else if (isAvatarImage) {
                    byte[] avatarBody = GatewayEndpointRouter.normalizeAvatarImageBody(
                            readRequestBodyBytes(request.a(), MAX_AVATAR_REQ_BYTES));
                    if (avatarBody == null) {
                        return jsonErrorResponse(request, 400, Localize.t(mContext, "请填写头像描述。", "Describe the avatar first."));
                    }
                    newReq.g("POST", createJsonRequestBody(new String(avatarBody, StandardCharsets.UTF_8)));
                    newReq.e("Content-Type", "application/json");
                } else if (isAppIntent) {
                    byte[] raw = observedRaw != null
                            ? observedRaw
                            : readRequestBodyBytes(request.a(), MAX_APP_INTENT_BYTES);
                    if (raw == null) return jsonErrorResponse(request, 413, "App-intent payload too large");
                    JSONObject input = parseJsonObject(raw);
                    if (input == null) input = new JSONObject();
                    String agentId = input.optString("agentId", "");
                    if (!agentId.isEmpty()) GatewayEndpointRouter.setLastAgentId(agentId);
                    newReq.g("POST", createJsonRequestBody(input.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (isDashboard) {
                    byte[] raw = observedRaw != null ? observedRaw : readRequestBodyBytes(request.a(), MAX_APP_INTENT_BYTES);
                    if (raw == null && request.a() != null) return jsonErrorResponse(request, 413, "Dashboard payload too large");
                    JSONObject input = raw != null ? parseJsonObject(raw) : null;
                    if (input == null) input = new JSONObject();
                    newReq.g("POST", createJsonRequestBody(input.toString()));
                    newReq.e("Content-Type", "application/json");
                } else if (observedRaw != null && request.a() != null) {
                    oj.D origBody = request.a();
                    oj.x mt = origBody.b() != null
                            ? origBody.b()
                            : oj.x.e.c("application/json; charset=utf-8");
                    newReq.g(httpMethod, oj.D.a.h(observedRaw, mt, 0, observedRaw.length));
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
                newReq.e("x-rokbot-client", "android-native/1.26.0");

                oj.E resp;
                try {
                    resp = chain.a(newReq.b());
                } catch (IOException e) {
                    if (Storage.isTailcatEnabled(mContext)) {
                        TailcatManager.get().onRequestFailure(mContext);
                    }
                    throw e;
                }

                if (isVoiceMint && resp.o0() && resp.m() != null) {
                    byte[] respBytes = readBoundedResponseBytes(resp.m(), MAX_VOICE_REQ_BYTES);
                    resp.close();
                    if (respBytes == null) {
                        return jsonErrorResponse(request, 502, Localize.t(mContext, "无法连接语音服务。", "Could not connect to the voice service."));
                    }
                    JSONObject cred = parseJsonObject(respBytes);
                    if (cred == null || !HostApiClient.isValidVoiceCredential(mContext, cred)) {
                        return jsonErrorResponse(request, 502, Localize.t(mContext, "无法连接语音服务。", "Could not connect to the voice service."));
                    }
                    GatewayEndpointRouter.rewriteVoiceCredentialUrls(mContext, cred);
                    return resp.x0()
                            .j("Content-Type", "application/json")
                            .b(oj.F.a.d(cred.toString().getBytes(StandardCharsets.UTF_8), oj.x.e.c("application/json")))
                            .c();
                }
                return resp;
            }
            if (isVoiceMint || isTranscribe || isTextToSpeech || isAvatarImage || isAppIntent || isDashboard) {
                return jsonErrorResponse(request, 401, Localize.t(mContext, "未连接 Host。", "Not connected"));
            }
        }

        // 4. Direct local Host calls: check resolved server origin (scheme+host+port, including Tailcat)
        String token = Storage.getToken(mContext);
        if (url != null && token != null && !token.isEmpty()) {
            String serverOriginUrl = GatewayEndpointRouter.resolveDirectServerOriginIfCandidate(mContext, host);
            String fullUrl = url.toString();
            String rewrittenTailcatUrl = GatewayEndpointRouter.rewriteStaleTailcatLoopbackUrl(mContext, fullUrl, serverOriginUrl);
            boolean isDirectServer = rewrittenTailcatUrl != null
                    || GatewayEndpointRouter.matchesServerOrigin(fullUrl, serverOriginUrl);
            if (isDirectServer) {
                oj.C.a directReq = request.m();
                boolean modified = false;
                if (rewrittenTailcatUrl != null) {
                    directReq.l(rewrittenTailcatUrl);
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
                    directReq.e("x-rokbot-client", "android-native/1.26.0");
                    modified = true;
                }
                oj.C finalReq = modified ? directReq.b() : request;
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

    private oj.E handleSkillPublication(oj.C request) {
        if (!"POST".equalsIgnoreCase(request.l())) {
            return jsonOkResponse(request, "{\"error\":\"Invalid request\"}");
        }
        String token = Storage.getToken(mContext);
        if (token == null || token.isEmpty()) {
            return jsonOkResponse(request, "{\"error\":\"Not connected\"}");
        }
        byte[] raw = readRequestBodyBytes(request.a(), MAX_SHARING_BYTES);
        JSONObject args = raw != null ? parseJsonObject(raw) : new JSONObject();
        if (args == null) return jsonOkResponse(request, "{\"error\":\"Invalid request\"}");
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
    private void observeSuggestionsAgent(String path, oj.D body) {
        if (body == null || !GatewayEndpointRouter.shouldObserveSuggestionsPath(path)) return;
        try {
            long len = body.a();
            if (len > 65536L) return;
            byte[] raw = readRequestBodyBytes(body, 65536L);
            if (raw != null && raw.length > 0) GatewayEndpointRouter.observeSuggestionsAgentFromJson(path, raw);
        } catch (Throwable ignored) {
        }
    }

    private byte[] observeAgentId(String path, oj.D body) {
        if (body == null || !GatewayEndpointRouter.shouldObserveAgentIdPath(path)) return null;
        try {
            long len = body.a();
            if (len > 65536L) return null;
            byte[] raw = readRequestBodyBytes(body, 65536L);
            if (raw == null || raw.length == 0) return raw;
            GatewayEndpointRouter.observeAgentIdFromJson(path, raw);
            return raw;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String extractRawQuery(String fullUrl) {
        if (fullUrl == null) return null;
        int q = fullUrl.indexOf('?');
        if (q < 0) return null;
        int h = fullUrl.indexOf('#', q);
        return h > q ? fullUrl.substring(q + 1, h) : fullUrl.substring(q + 1);
    }

    private static oj.E jsonOkResponse(oj.C request, String json) {
        return new oj.E.a()
                .s(request)
                .p(oj.B.d)
                .g(200)
                .m("OK")
                .j("Content-Type", "application/json")
                .b(oj.F.a.d(json.getBytes(StandardCharsets.UTF_8), oj.x.e.c("application/json")))
                .c();
    }

    private static oj.E jsonErrorResponse(oj.C request, int code, String message) {
        JSONObject err = new JSONObject();
        try {
            err.put("error", message != null ? message : "Error");
            err.put("code", code);
        } catch (Throwable ignored) {}
        return new oj.E.a()
                .s(request)
                .p(oj.B.d)
                .g(code)
                .m(message != null ? message : "Error")
                .j("Content-Type", "application/json")
                .b(oj.F.a.d(err.toString().getBytes(StandardCharsets.UTF_8), oj.x.e.c("application/json")))
                .c();
    }

    private static oj.D createJsonRequestBody(String json) {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        return oj.D.a.h(bytes, oj.x.e.c("application/json; charset=utf-8"), 0, bytes.length);
    }

    private static byte[] readRequestBodyBytes(oj.D body, long maxBytes) {
        if (body == null) return new byte[0];
        try {
            long len = body.a();
            if (len > maxBytes) return null;
            Dj.h buf = new Dj.h();
            body.f(buf);
            byte[] data = buf.M0();
            return data.length <= maxBytes ? data : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private static byte[] readBoundedResponseBytes(oj.F body, int maxBytes) {
        try (InputStream is = body.a()) {
            if (is == null) return new byte[0];
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int total = 0;
            int n;
            while ((n = is.read(chunk)) != -1) {
                total += n;
                if (total > maxBytes) return null;
                baos.write(chunk, 0, n);
            }
            return baos.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }

    private static JSONObject parseJsonObject(byte[] data) {
        if (data == null || data.length == 0) return null;
        try {
            return new JSONObject(new String(data, StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            return null;
        }
    }
}
