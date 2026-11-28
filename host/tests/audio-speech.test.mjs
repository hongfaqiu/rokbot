import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AudioSpeech, envSpeechConfig, sniffAudio, SPEECH_RPC_PATH } from '../server/audio-speech.mjs';

// Voice memos are `type: text` + `voice_memo: true`; the mobile app synthesizes them itself through
// /aiserver.v1.AiService/TextToSpeech ({ text, voiceId } -> { audio: base64, mimeType }). These
// tests drive the Host side against a local mock TTS service with a fake key.
const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));
const FAKE_KEY = 'fixture-tts-key-not-real';
// One silent MPEG-1 Layer III frame (128 kbps, 44.1 kHz, mono), repeated: a valid, playable mp3.
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc4]), Buffer.alloc(413)]);
const MP3 = Buffer.concat(Array.from({ length: 40 }, () => MP3_FRAME));
const PCM = Buffer.alloc(24_000 * 2 / 10); // 100 ms of 24 kHz mono silence

async function ffprobe(bytes, name) {
  const bin = process.env.FFPROBE ?? 'ffprobe';
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); } catch { return null; }
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-ffprobe-'));
  try {
    await writeFile(join(dir, name), bytes);
    return JSON.parse(execFileSync(bin, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(dir, name)]).toString('utf8'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function mockTts(t, { status = 200, body = MP3, type = 'audio/mpeg' } = {}) {
  const calls = [];
  const origin = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ path: request.url, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(status, { 'content-type': type });
    response.end(body);
  });
  return { endpoint: `${origin}/v1/audio/speech`, calls };
}

test('environment TTS config is optional and validated without naming a provider', () => {
  assert.equal(envSpeechConfig({}), null);
  assert.throws(() => envSpeechConfig({ ROKBOT_TTS_ENDPOINT: 'ftp://x' }), /http/);
  assert.throws(() => envSpeechConfig({ ROKBOT_TTS_ENDPOINT: 'http://u:p@x/' }), /credentials/);
  assert.throws(() => envSpeechConfig({ ROKBOT_TTS_ENDPOINT: 'http://x/' }), /MODEL/);
  assert.deepEqual(envSpeechConfig({ GROKBOT_TTS_ENDPOINT: 'http://x/s', ROKBOT_TTS_MODEL: 'm', ROKBOT_TTS_VOICE: 'v' }),
    { endpoint: 'http://x/s', apiKey: '', model: 'm', voice: 'v', format: 'mp3', timeoutMs: 60_000 });
});

test('audio is identified by its bytes', () => {
  assert.equal(sniffAudio(MP3), 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)])), 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)])), 'audio/mp4');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])), 'audio/wav');
  assert.equal(sniffAudio(Buffer.from('{"error":"nope"}')), null);
  assert.equal(sniffAudio(Buffer.alloc(4)), null);
});

test('environment TTS returns mp3 from an OpenAI-compatible endpoint', async t => {
  const tts = await mockTts(t);
  const speech = new AudioSpeech({ env: { ROKBOT_TTS_ENDPOINT: tts.endpoint, ROKBOT_TTS_API_KEY: FAKE_KEY,
    ROKBOT_TTS_MODEL: 'fixture-model', ROKBOT_TTS_VOICE: 'fixture-voice' } });
  const result = await speech.synthesize('  你好  ');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.deepEqual(result.audio, MP3);
  assert.deepEqual(tts.calls, [{ path: '/v1/audio/speech', authorization: `Bearer ${FAKE_KEY}`,
    body: { model: 'fixture-model', voice: 'fixture-voice', input: '你好', response_format: 'mp3' } }]);
});

test('environment TTS rejects non-audio bodies and hides upstream details', async t => {
  const bad = await mockTts(t, { body: Buffer.from(`{"error":"${FAKE_KEY}"}`), type: 'audio/mpeg' });
  const env = { ROKBOT_TTS_ENDPOINT: bad.endpoint, ROKBOT_TTS_API_KEY: FAKE_KEY, ROKBOT_TTS_MODEL: 'm', ROKBOT_TTS_VOICE: 'v' };
  await assert.rejects(new AudioSpeech({ env }).synthesize('hi'), error => error.status === 502 && !error.message.includes(FAKE_KEY));
  const denied = await mockTts(t, { status: 401, body: Buffer.from(FAKE_KEY) });
  await assert.rejects(new AudioSpeech({ env: { ...env, ROKBOT_TTS_ENDPOINT: denied.endpoint } }).synthesize('hi'),
    error => error.status === 502 && /API key/.test(error.message) && !error.message.includes(FAKE_KEY));
});

test('without environment TTS the voice-chat synthesis is returned as 24 kHz mono 16-bit WAV', async t => {
  const seen = [];
  const synthesis = { async *stream(text, options) { seen.push([text, options.agent]); yield PCM.subarray(0, 100); yield PCM.subarray(100); } };
  const result = await new AudioSpeech({ synthesis, env: {} }).synthesize('hello', { agent: { id: 'a1' } });
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.audio.toString('latin1', 0, 4), 'RIFF');
  assert.equal(result.audio.toString('latin1', 8, 12), 'WAVE');
  assert.equal(result.audio.readUInt16LE(22), 1);
  assert.equal(result.audio.readUInt32LE(24), 24_000);
  assert.equal(result.audio.readUInt16LE(34), 16);
  assert.equal(result.audio.length, 44 + PCM.length);
  assert.deepEqual(seen, [['hello', { id: 'a1' }]]);
  const probe = await ffprobe(result.audio, 'speech.wav');
  if (probe) {
    assert.equal(probe.streams[0].codec_name, 'pcm_s16le');
    assert.equal(probe.streams[0].sample_rate, '24000');
    assert.equal(probe.streams[0].channels, 1);
    assert.ok(Math.abs(Number(probe.format.duration) - 0.1) < 0.01);
  }
  if (process.env.AUDIO_SPEECH_SAMPLE_DIR) await writeFile(join(process.env.AUDIO_SPEECH_SAMPLE_DIR, 'speech.wav'), result.audio);
});

test('self-host server: /local/audio/speech and the TextToSpeech RPC alias', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const tts = await mockTts(t);
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-audio-speech-'));
  const core = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const speechEnv = { ROKBOT_TTS_ENDPOINT: tts.endpoint, ROKBOT_TTS_API_KEY: FAKE_KEY,
    ROKBOT_TTS_MODEL: 'fixture-model', ROKBOT_TTS_VOICE: 'fixture-voice' };
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl,
    internalToken: 'c'.repeat(40), speechEnv });
  await host.start(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const { token } = await host.auth.pair({ password: 'AdminPass123', deviceName: 'Phone', platform: 'desktop', clientKind: 'android' });
  const json = { 'content-type': 'application/json' };
  const body = JSON.stringify({ text: '语音备忘', voiceId: 'official-voice-id' });

  // Unpaired callers never reach the TTS service.
  assert.equal((await fetch(`${origin}/local/audio/speech`, { method: 'POST', headers: json, body })).status, 401);
  assert.equal((await fetch(`${origin}${SPEECH_RPC_PATH}`, { method: 'POST', headers: json, body })).status, 401);
  assert.equal(tts.calls.length, 0);

  const auth = { ...json, authorization: `Bearer ${token}` };
  // Raw audio by default, with the type of the bytes.
  const raw = await fetch(`${origin}/local/audio/speech`, { method: 'POST', headers: { ...auth, accept: 'audio/*' }, body });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'audio/mpeg');
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.deepEqual(bytes.subarray(0, 2), Buffer.from([0xff, 0xfb]));
  assert.deepEqual(bytes, MP3);

  // The interceptors forward with Accept: application/json and get the TextToSpeech shape.
  for (const path of ['/local/audio/speech', SPEECH_RPC_PATH]) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { ...auth, accept: 'application/json' }, body });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const reply = await response.json();
    assert.equal(reply.mimeType, 'audio/mpeg');
    assert.deepEqual(Buffer.from(reply.audio, 'base64'), MP3);
  }
  // The RPC alias is JSON even when the client sends no Accept header.
  const alias = await fetch(`${origin}${SPEECH_RPC_PATH}`, { method: 'POST', headers: auth, body });
  assert.equal((await alias.json()).mimeType, 'audio/mpeg');

  assert.ok(tts.calls.every(call => call.authorization === `Bearer ${FAKE_KEY}` &&
    call.body.voice === 'fixture-voice' && call.body.model === 'fixture-model' && call.body.input === '语音备忘'));
  assert.equal((await fetch(`${origin}/local/audio/speech`, { method: 'POST', headers: auth, body: '{"text":""}' })).status, 400);
  assert.equal((await fetch(`${origin}/local/audio/speech`, { headers: auth })).status, 405);

  const probe = await ffprobe(bytes, 'speech.mp3');
  if (probe) {
    assert.equal(probe.streams[0].codec_type, 'audio');
    assert.equal(probe.streams[0].codec_name, 'mp3');
    assert.ok(Number(probe.format.duration) > 0);
  } else t.diagnostic('ffprobe not installed; set FFPROBE to verify playback');
  if (process.env.AUDIO_SPEECH_SAMPLE_DIR) await writeFile(join(process.env.AUDIO_SPEECH_SAMPLE_DIR, 'speech.mp3'), bytes);
});

test('self-host server: without TTS configured /local/audio/speech answers 503, not a cloud call', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-audio-speech-off-'));
  const coreCalls = [];
  const core = http.createServer((req, res) => { coreCalls.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl,
    internalToken: 'c'.repeat(40), speechEnv: {} });
  await host.start(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const { token } = await host.auth.pair({ password: 'AdminPass123', deviceName: 'Phone', platform: 'desktop', clientKind: 'android' });
  const response = await fetch(`${origin}${SPEECH_RPC_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{"text":"hi"}' });
  assert.equal(response.status, 503);
  assert.deepEqual(coreCalls.filter(url => url.startsWith('/aiserver')), []);
});
