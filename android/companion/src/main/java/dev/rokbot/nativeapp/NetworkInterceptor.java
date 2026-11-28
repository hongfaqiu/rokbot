package dev.rokbot.nativeapp;

import android.content.Context;
import okhttp3.HttpUrl;
import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public class NetworkInterceptor implements Interceptor {
    private static final long MAX_TRANSCRIBE_BYTES = 36L * 1024L * 1024L;
    private static final long MAX_SPEECH_REQ_BYTES = 64L * 1024L;
    private static final int MAX_VOICE_REQ_BYTES = 16384;
    private static final long MAX_APP_INTENT_BYTES = 1024L * 1024L;
    private static final long MAX_SHARING_BYTES = 8192L;

    private final Context mContext;

    public NetworkInterceptor(Context context) {
        mContext = context.getApplicationContext();
    }

    public static String getLastAgentId() {
        return GatewayEndpointRouter.getLastAgentId();
    }

    public static void setLastAgentId(String agentId) {
        GatewayEndpointRouter.setLastAgentId(agentId);
    }

    /** Direct-Host requests: feed the input suggestions only (body is read, not consumed). */
    private void observeSuggestionsAgent(String path, RequestBody body) {
        if (body == null || !GatewayEndpointRouter.shouldObserveSuggestionsPath(path)) return;
        try {
            long len = body.contentLength();
            if (len > 65536L) return;
            byte[] raw = readRequestBodyBytes(body, 65536L);
            if (raw != null && raw.length > 0) GatewayEndpointRouter.observeSuggestionsAgentFromJson(path, raw);
        } catch (Throwable ignored) {
        }
    }

    private byte[] observeAgentId(String path, RequestBody body) {
        if (body == null || !GatewayEndpointRouter.shouldObserveAgentIdPath(path)) return null;
        try {
            long len = body.contentLength();
            if (len > 65536L) return null;
            byte[] raw = readRequestBodyBytes(body, 65536L);
            GatewayEndpointRouter.observeAgentIdFromJson(path, raw);
            return raw;
        } catch (Throwable ignored) {
            return null;
        }
    }

    @Override
    public Response intercept(Chain chain) throws IOException {
        Request request = chain.request();
        HttpUrl url = request.url();
        String host = (url != null && url.host() != null) ? GatewayEndpointRouter.normalizeHost(url.host()) : "";
        String path = url != null ? url.encodedPath() : "";
        String httpMethod = request.method() != null ? request.method().toUpperCase(Locale.US) : "GET";

        // 1. Block Telemetry & Analytics & OTA update manifest
        if (isTelemetryHost(host)
                || isTelemetryPath(path)
                || "/updates/sand-mobile/api/manifest".equals(path)) {
            return new Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(204)
                .message("No Content")
                .header("x-rokbot-telemetry-blocked", "1")
                .body(createBody("text/plain", new byte[0]))
                .build();
        }

        // 2. Intercept local RN SkillSheet publication bridge (https://rokbot.local/skill-publication)
        if (url != null && "https".equalsIgnoreCase(url.scheme())
                && "rokbot.local".equalsIgnoreCase(host)
                && "/skill-publication".equals(path)) {
            return handleSkillPublication(request);
        }

        // 3. Redirect Cloud Endpoints & Native RPCs to Self-Hosted Gateway (direct or Tailcat tunnel)
        if (!isTargetCloudEndpoint(host)) observeSuggestionsAgent(path, request.body());
        if (isTargetCloudEndpoint(host)) {
            byte[] observedRaw = observeAgentId(path, request.body());
            boolean isVoiceMint = "POST".equals(httpMethod)
                    && "/aiserver.v1.GrokBotService/MintSandVoiceCallSecret".equals(path);
            boolean isTranscribe = "POST".equals(httpMethod)
                    && "/aiserver.v1.AiService/TranscribeAudio".equals(path);
            boolean isTextToSpeech = "POST".equals(httpMethod)
                    && GatewayEndpointRouter.TEXT_TO_SPEECH_RPC.equals(path);
            boolean isAppIntent = "POST".equals(httpMethod) && getAppIntentMethod(path) != null;
            boolean isDashboard = "POST".equals(httpMethod) && getDashboardMethod(path) != null;

            String token = Storage.getToken(mContext);
            if ((isVoiceMint || isTranscribe || isTextToSpeech || isAppIntent || isDashboard) && (token == null || token.isEmpty())) {
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
                HttpUrl base = HttpUrl.parse(gatewayUrl);
                if (base != null) {
                    String rewrittenPath = rewriteRpcPath(path);

                    Request.Builder newReq = request.newBuilder();
                    if (isTranscribe) {
                        byte[] raw = readRequestBodyBytes(request.body(), MAX_TRANSCRIBE_BYTES);
                        if (raw == null || raw.length > MAX_TRANSCRIBE_BYTES) {
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
                        } catch (Exception e) {
                            return jsonErrorResponse(request, 400, "Invalid transcription payload");
                        }
                        newReq.method("POST", createJsonRequestBody(parsed.toString()));
                        newReq.removeHeader("Content-Length");
                        newReq.header("Content-Type", "application/json");
                    } else if (isVoiceMint) {
                        byte[] raw = readRequestBodyBytes(request.body(), MAX_VOICE_REQ_BYTES);
                        if (raw == null && request.body() != null) {
                            return jsonErrorResponse(request, 413, "Voice session request too large");
                        }
                        JSONObject input = raw != null ? parseJsonObject(raw) : null;
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
                        newReq.method("POST", createJsonRequestBody(normalized.toString()));
                        newReq.removeHeader("Content-Length");
                        newReq.header("Content-Type", "application/json");
                    } else if (isTextToSpeech) {
                        byte[] speechBody = GatewayEndpointRouter.normalizeTextToSpeechBody(
                                readRequestBodyBytes(request.body(), MAX_SPEECH_REQ_BYTES));
                        if (speechBody == null) {
                            return jsonErrorResponse(request, 400, Localize.t(mContext, "无法朗读这条消息。", "Could not read this message aloud."));
                        }
                        newReq.method("POST", createJsonRequestBody(new String(speechBody, StandardCharsets.UTF_8)));
                        newReq.removeHeader("Content-Length");
                        newReq.header("Content-Type", "application/json");
                    } else if (isAppIntent) {
                        byte[] raw = observedRaw != null
                                ? observedRaw
                                : readRequestBodyBytes(request.body(), MAX_APP_INTENT_BYTES);
                        if (raw == null && request.body() != null) {
                            return jsonErrorResponse(request, 413, "App-intent payload too large");
                        }
                        JSONObject input = raw != null ? parseJsonObject(raw) : null;
                        if (input == null) input = new JSONObject();
                        String agentId = input.optString("agentId", "");
                        if (!agentId.isEmpty()) GatewayEndpointRouter.setLastAgentId(agentId);
                        newReq.method("POST", createJsonRequestBody(input.toString()));
                        newReq.removeHeader("Content-Length");
                        newReq.header("Content-Type", "application/json");
                    } else if (isDashboard) {
                        byte[] raw = observedRaw != null
                                ? observedRaw
                                : readRequestBodyBytes(request.body(), MAX_APP_INTENT_BYTES);
                        if (raw == null && request.body() != null) {
                            return jsonErrorResponse(request, 413, "Dashboard payload too large");
                        }
                        JSONObject input = raw != null ? parseJsonObject(raw) : null;
                        if (input == null) input = new JSONObject();
                        newReq.method("POST", createJsonRequestBody(input.toString()));
                        newReq.removeHeader("Content-Length");
                        newReq.header("Content-Type", "application/json");
                    } else if (observedRaw != null && request.body() != null) {
                        MediaType origType = request.body().contentType();
                        newReq.method(httpMethod, RequestBody.create(
                                origType != null ? origType : MediaType.parse("application/json; charset=utf-8"),
                                observedRaw));
                    }

                    HttpUrl.Builder urlBuilder = url.newBuilder()
                        .scheme(base.scheme())
                        .host(base.host())
                        .port(base.port());
                    if (rewrittenPath != null && !rewrittenPath.equals(path)) {
                        urlBuilder.encodedPath(rewrittenPath);
                    }
                    newReq.url(urlBuilder.build());

                    if (token != null && !token.isEmpty()) {
                        newReq.header("Authorization", "Bearer " + token);
                    }
                    if (!GatewayEndpointRouter.hasSseAcceptHeader(request.header("Accept"))) {
                        newReq.header("Accept", "application/json");
                    }
                    if (RokBotBootstrap.isForeground()) {
                        newReq.header("x-rokbot-foreground", "1");
                    }
                    newReq.header("x-rokbot-client", "android-native/1.26.0");

                    Response response;
                    try {
                        response = chain.proceed(newReq.build());
                    } catch (IOException e) {
                        if (Storage.isTailcatEnabled(mContext)) {
                            TailcatManager.get().onRequestFailure(mContext);
                        }
                        throw e;
                    }
                    if (isVoiceMint && response.isSuccessful() && response.body() != null) {
                        byte[] respBytes;
                        try {
                            respBytes = readBoundedResponseBytes(response.body(), MAX_VOICE_REQ_BYTES);
                        } finally {
                            closeQuietly(response);
                        }
                        if (respBytes == null) {
                            return jsonErrorResponse(request, 502, Localize.t(mContext, "无法连接语音服务。", "Could not connect to the voice service."));
                        }
                        JSONObject cred = parseJsonObject(respBytes);
                        if (cred == null || !HostApiClient.isValidVoiceCredential(mContext, cred)) {
                            return jsonErrorResponse(request, 502, Localize.t(mContext, "无法连接语音服务。", "Could not connect to the voice service."));
                        }
                        GatewayEndpointRouter.rewriteVoiceCredentialUrls(mContext, cred);
                        return response.newBuilder()
                            .header("Content-Type", "application/json")
                            .body(createBody("application/json", cred.toString().getBytes(StandardCharsets.UTF_8)))
                            .build();
                    }
                    return response;
                }
            }
            if (isVoiceMint || isTranscribe || isTextToSpeech || isAppIntent || isDashboard) {
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
                Request.Builder directReq = request.newBuilder();
                boolean modified = false;
                if (rewrittenTailcatUrl != null) {
                    HttpUrl rewritten = HttpUrl.parse(rewrittenTailcatUrl);
                    if (rewritten != null) {
                        directReq.url(rewritten);
                        modified = true;
                    }
                }
                String auth = request.header("Authorization");
                if (auth == null || auth.isEmpty()) {
                    directReq.header("Authorization", "Bearer " + token);
                    modified = true;
                }
                if (RokBotBootstrap.isForeground()) {
                    String fgHdr = request.header("x-rokbot-foreground");
                    if (fgHdr == null || fgHdr.isEmpty()) {
                        directReq.header("x-rokbot-foreground", "1");
                        modified = true;
                    }
                }
                String clientHdr = request.header("x-rokbot-client");
                if (clientHdr == null || clientHdr.isEmpty()) {
                    directReq.header("x-rokbot-client", "android-native/1.26.0");
                    modified = true;
                }
                Request finalReq = modified ? directReq.build() : request;
                try {
                    return chain.proceed(finalReq);
                } catch (IOException e) {
                    if (Storage.isTailcatEnabled(mContext)) {
                        TailcatManager.get().onRequestFailure(mContext);
                    }
                    throw e;
                }
            }
        }

        return chain.proceed(request);
    }

    private Response handleSkillPublication(Request request) {
        if (!"POST".equalsIgnoreCase(request.method())) {
            return jsonOkResponse(request, "{\"error\":\"Invalid request\"}");
        }
        String token = Storage.getToken(mContext);
        if (token == null || token.isEmpty()) {
            return jsonOkResponse(request, "{\"error\":\"Not connected\"}");
        }
        byte[] raw = readRequestBodyBytes(request.body(), MAX_SHARING_BYTES);
        JSONObject args = raw != null ? parseJsonObject(raw) : new JSONObject();
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

    private static Response jsonOkResponse(Request request, String json) {
        return new Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .header("Content-Type", "application/json")
            .body(createBody("application/json", json.getBytes(StandardCharsets.UTF_8)))
            .build();
    }

    private static Response jsonErrorResponse(Request request, int code, String message) {
        String bodyStr;
        try {
            bodyStr = new JSONObject().put("error", message != null ? message : "Request failed").toString();
        } catch (Exception e) {
            bodyStr = "{\"error\":\"Request failed\"}";
        }
        return new Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(message != null ? message : "Error")
            .header("Content-Type", "application/json")
            .body(createBody("application/json", bodyStr.getBytes(StandardCharsets.UTF_8)))
            .build();
    }

    private static byte[] readRequestBodyBytes(RequestBody body, long maxBytes) {
        if (body == null) return new byte[0];
        try {
            long len = body.contentLength();
            if (len > maxBytes) return null;
            Class<?> bufCls = Class.forName("okio.Buffer");
            Object buf = bufCls.getDeclaredConstructor().newInstance();
            Method writeTo = null;
            for (Method m : RequestBody.class.getMethods()) {
                if ("writeTo".equals(m.getName()) && m.getParameterCount() == 1) {
                    writeTo = m;
                    break;
                }
            }
            if (writeTo == null) return null;
            writeTo.invoke(body, buf);
            byte[] data = (byte[]) bufCls.getMethod("readByteArray").invoke(buf);
            if (data != null && data.length > maxBytes) return null;
            return data != null ? data : new byte[0];
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static byte[] readBoundedResponseBytes(ResponseBody body, int maxBytes) {
        if (body == null) return new byte[0];
        long contentLen = body.contentLength();
        if (contentLen > maxBytes) return null;
        try (InputStream in = body.byteStream()) {
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

    private static void closeQuietly(Response response) {
        if (response == null) return;
        try {
            Method m = response.getClass().getMethod("close");
            m.invoke(response);
        } catch (Throwable ignored) {}
    }

    private static RequestBody createJsonRequestBody(String json) {
        byte[] bytes = (json != null ? json : "{}").getBytes(StandardCharsets.UTF_8);
        MediaType mt = MediaType.parse("application/json; charset=utf-8");
        try {
            Method m = RequestBody.class.getMethod("create", MediaType.class, byte[].class);
            return (RequestBody) m.invoke(null, mt, bytes);
        } catch (Throwable ignored) {}
        try {
            Method m = RequestBody.class.getMethod("create", byte[].class, MediaType.class);
            return (RequestBody) m.invoke(null, bytes, mt);
        } catch (Throwable t) {
            return RequestBody.create(mt, bytes);
        }
    }

    private static ResponseBody createBody(String mime, byte[] bytes) {
        MediaType mt = MediaType.parse(mime);
        try {
            Method m = ResponseBody.class.getMethod("create", MediaType.class, byte[].class);
            return (ResponseBody) m.invoke(null, mt, bytes);
        } catch (Throwable ignored) {}
        try {
            Method m = ResponseBody.class.getMethod("create", byte[].class, MediaType.class);
            return (ResponseBody) m.invoke(null, bytes, mt);
        } catch (Throwable t) {
            return ResponseBody.create(mt, bytes);
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

    public static String getAppIntentMethod(String path) {
        return GatewayEndpointRouter.getAppIntentMethod(path);
    }

    public static String getDashboardMethod(String path) {
        return GatewayEndpointRouter.getDashboardMethod(path);
    }

    public static String rewriteRpcPath(String path) {
        return GatewayEndpointRouter.rewriteRpcPath(path);
    }

    public static boolean isTelemetryPath(String path) {
        return GatewayEndpointRouter.isTelemetryPath(path);
    }

    public static boolean isTelemetryHost(String host) {
        return GatewayEndpointRouter.isTelemetryHost(host);
    }

    public static boolean isTargetCloudEndpoint(String host) {
        return GatewayEndpointRouter.isTargetCloudEndpoint(host);
    }
}
