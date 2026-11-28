import { check, HttpError, jsonBody } from './security.mjs';
import { MAX_VOICE_TEXT } from './voice-config.mjs';
import { pcmWav } from './voice-audio.mjs';

// Voice-memo playback (`voice_memo: true` text messages). The mobile client synthesizes these
// itself through /aiserver.v1.AiService/TextToSpeech ({ text, voiceId } -> { audio, mimeType },
// audio as base64), which the native interceptors map to /local/audio/speech.
//
// Synthesis source, in order:
//  1. An OpenAI-compatible `/audio/speech` endpoint from the environment (ROKBOT_TTS_*). It is
//     asked for a compressed format (mp3 by default), which every client can play.
//  2. Otherwise the TTS service configured for voice chat (Admin > Voice), returned as 24 kHz
//     mono 16-bit WAV, the same audio /admin/api/voice/test plays.
// Nothing here names a real provider or ships a credential.

export const SPEECH_ENV = Object.freeze({
  endpoint: 'ROKBOT_TTS_ENDPOINT', apiKey: 'ROKBOT_TTS_API_KEY', model: 'ROKBOT_TTS_MODEL',
  voice: 'ROKBOT_TTS_VOICE', format: 'ROKBOT_TTS_FORMAT', timeoutMs: 'ROKBOT_TTS_TIMEOUT_MS',
});
export const SPEECH_RPC_PATH = '/aiserver.v1.AiService/TextToSpeech';
export const MAX_SPEECH_AUDIO_BYTES = 24 * 1024 * 1024;
const formats = { mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav', opus: 'audio/ogg', flac: 'audio/flac' };

const env = (source, name) => {
  const value = source[name] ?? source[name.replace(/^ROKBOT_/, 'GROKBOT_')];
  return typeof value === 'string' ? value.trim() : '';
};

/** Environment TTS configuration, or null when ROKBOT_TTS_ENDPOINT is unset. */
export function envSpeechConfig(source = process.env) {
  const address = env(source, SPEECH_ENV.endpoint);
  if (!address) return null;
  let url;
  try { url = new URL(address); } catch { throw new Error(`${SPEECH_ENV.endpoint} is not a valid URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error(`${SPEECH_ENV.endpoint} must be an http(s) URL without credentials`);
  const format = (env(source, SPEECH_ENV.format) || 'mp3').toLowerCase();
  if (!Object.hasOwn(formats, format)) throw new Error(`${SPEECH_ENV.format} must be one of ${Object.keys(formats).join(', ')}`);
  const model = env(source, SPEECH_ENV.model), voice = env(source, SPEECH_ENV.voice);
  if (!model || !voice) throw new Error(`${SPEECH_ENV.model} and ${SPEECH_ENV.voice} are required with ${SPEECH_ENV.endpoint}`);
  const timeoutMs = Number(env(source, SPEECH_ENV.timeoutMs) || 60_000);
  return { endpoint: url.href, apiKey: env(source, SPEECH_ENV.apiKey), model, voice, format,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120_000 ? timeoutMs : 60_000 };
}

/** Identifies audio by its bytes; upstream Content-Type headers are not trusted. */
export function sniffAudio(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  return null;
}

async function boundedBytes(body, limit) {
  const reader = body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      check(total <= limit, 502, 'Speech audio is too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function upstreamError(status) {
  if ([401, 403].includes(status)) return new HttpError(502, 'Speech service rejected the API key');
  if (status === 429) return new HttpError(429, 'Speech service is busy; try again');
  return new HttpError(502, `Speech service returned HTTP ${status}`);
}

export class AudioSpeech {
  constructor({ synthesis, env: source = process.env, fetch: fetcher = globalThis.fetch } = {}) {
    this.synthesis = synthesis;
    this.fetch = fetcher;
    this.env = source;
  }
  /** Re-read on every request so a restart is not needed after editing the environment file. */
  config() { return envSpeechConfig(this.env); }
  async synthesize(text, { agent, signal } = {}) {
    check(typeof text === 'string' && text.trim().length > 0, 400, 'Speech text is required');
    check(text.length <= MAX_VOICE_TEXT, 413, 'Speech text is too long');
    let config;
    try { config = this.config(); } catch (error) { throw new HttpError(503, error.message); }
    if (config) return this.synthesizeRemote(text.trim(), config, signal);
    check(this.synthesis, 503, 'Speech synthesis is not configured');
    const chunks = [];
    for await (const chunk of this.synthesis.stream(text, { signal, agent })) chunks.push(chunk);
    return { audio: pcmWav(Buffer.concat(chunks)), mimeType: 'audio/wav' };
  }
  async synthesizeRemote(text, config, signal) {
    check(text.length <= 4096, 413, 'Speech text exceeds the provider limit');
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await this.fetch(config.endpoint, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', accept: `${formats[config.format]}, audio/*`,
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, voice: config.voice, input: text, response_format: config.format }),
      });
      if (!response.ok) throw upstreamError(response.status);
      check(response.body, 502, 'Speech service returned no audio');
      const audio = await boundedBytes(response.body, MAX_SPEECH_AUDIO_BYTES);
      const mimeType = sniffAudio(audio);
      check(mimeType, 502, 'Speech service did not return playable audio');
      return { audio, mimeType };
    } catch (error) {
      if (timeout.aborted) throw new HttpError(504, 'Speech synthesis timed out');
      if (combined.aborted) throw new HttpError(499, 'Speech synthesis cancelled');
      if (error instanceof HttpError) throw error;
      // Transport errors can carry the endpoint or credentials; never echo them.
      throw new HttpError(502, 'Could not reach the speech service');
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }
  /**
   * POST { text, voiceId?, agentId? }. Replies with the audio bytes and their Content-Type, or
   * with the TextToSpeech JSON shape { audio: base64, mimeType } when the caller asks for JSON
   * (the mobile RPC path, or an Accept header that names JSON and no audio type).
   */
  async route(request, response, { json = false, resolveAgent } = {}) {
    check(request.method === 'POST', 405, 'Method not allowed');
    const body = await jsonBody(request, 64 * 1024);
    check(typeof body.text === 'string', 400, 'Speech text is required');
    const accept = String(request.headers.accept ?? '').toLowerCase();
    const wantsJson = json || (accept.includes('application/json') && !accept.includes('audio/'));
    const agentId = typeof body.agentId === 'string' && body.agentId.length <= 256 ? body.agentId : '';
    const agent = agentId && resolveAgent ? await resolveAgent(agentId).catch(() => undefined) : undefined;
    const abort = new AbortController();
    response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    const { audio, mimeType } = await this.synthesize(body.text, { agent, signal: abort.signal });
    if (response.destroyed) return;
    if (wantsJson) {
      const payload = Buffer.from(JSON.stringify({ audio: audio.toString('base64'), mimeType }));
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length,
        'cache-control': 'no-store' });
      return response.end(payload);
    }
    response.writeHead(200, { 'content-type': mimeType, 'content-length': audio.length, 'cache-control': 'no-store' });
    return response.end(audio);
  }
}
