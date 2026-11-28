import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AvatarImage, AVATAR_IMAGE_LOCAL_PATH, AVATAR_IMAGE_RPC_PATH, avatarPrompt } from '../server/avatar-image.mjs';
import { HttpError } from '../server/security.mjs';

// The mobile Bot avatar page (Generate tab) calls /aiserver.v1.AiService/RunGenerateImage through
// the same RPC transport as TextToSpeech. Request and reply shapes, from the official Android
// 1.26.0 / 1.27.0 Hermes bundles (AvatarGeneration.request / reply / failure):
//   request  { description: <full avatar prompt>, modelId: 'grok-4.5', maxMode: false, aspectRatio: '1:1' }
//   success  { success: { imageData: <base64>, mimeType } }
//   failure  { error: { error, modelRestricted?, providerStatusCode?, contentSafetyBlocked? } }
// A failure without providerStatusCode / contentSafetyBlocked is kind "server", whose message the
// pane shows verbatim; a non-2xx reply is a thrown error, shown as the generic
// "Unable to generate avatar. Please retry." So every generation failure is HTTP 200 + error text.
const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));
// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PROMPT = 'Profile avatar for an AI agent in a chat app.\n\nSubject: a cartoon girl\n\nUse bold readable shapes.';

function fakeMedia({ available = true, generate } = {}) {
  const calls = [];
  return {
    calls,
    async available(kind) { calls.push(['available', kind]); return available; },
    async generate(kind, input, options) {
      calls.push(['generate', kind, input]);
      if (generate) return generate(kind, input, options);
      return { jobId: 'j', modelId: 'img', outputs: [{ bytes: Buffer.from(PNG_B64, 'base64'), mimeType: 'image/png' }] };
    },
  };
}
const request = { description: PROMPT, modelId: 'grok-4.5', maxMode: false, aspectRatio: '1:1' };

test('RunGenerateImage success: the client prompt is used as-is and the reply has the RPC shape', async () => {
  const media = fakeMedia();
  const { reply, failure } = await new AvatarImage({ media }).generate(request);
  assert.equal(failure, undefined);
  assert.deepEqual(reply, { success: { imageData: PNG_B64, mimeType: 'image/png' } });
  // The official client already wrapped the description in the avatar prompt; the official
  // modelId ('grok-4.5') is a cloud model and is not forwarded: the Host default image model is used.
  assert.deepEqual(media.calls.find(call => call[0] === 'generate'), ['generate', 'image', { prompt: PROMPT, aspectRatio: '1:1' }]);
});

test('not configured: a specific message, no provider call, no providerStatusCode', async () => {
  const media = fakeMedia({ available: false });
  const { reply, failure } = await new AvatarImage({ media }).generate(request);
  assert.equal(failure, 'not-configured');
  assert.match(reply.error.error, /未配置图像生成服务/);
  assert.match(reply.error.error, /媒体服务/);
  assert.match(reply.error.error, /默认图像模型/);
  assert.deepEqual(Object.keys(reply.error), ['error']);
  assert.equal(media.calls.some(call => call[0] === 'generate'), false);
  const english = await new AvatarImage({ media }).generate(request, { language: 'en-US,en;q=0.9' });
  assert.match(english.reply.error.error, /^Image generation is not configured\. Set a default image model under Media services/);
});

test('provider errors and timeouts are told apart', async () => {
  const provider = fakeMedia({ generate: () => { throw new HttpError(502, 'Service returned HTTP 401 (job 0f0e)'); } });
  const failed = await new AvatarImage({ media: provider }).generate(request);
  assert.equal(failed.failure, 'provider');
  assert.match(failed.reply.error.error, /^图像生成服务出错：Service returned HTTP 401$/);
  assert.deepEqual(Object.keys(failed.reply.error), ['error']);

  const busy = fakeMedia({ generate: () => { throw new HttpError(429, 'Media generation is busy'); } });
  assert.match((await new AvatarImage({ media: busy }).generate(request)).reply.error.error, /正忙/);

  const slow = fakeMedia({ generate: (kind, input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new HttpError(502, 'Media request interrupted (job 1)')));
  }) });
  const timedOut = await new AvatarImage({ media: slow, timeoutMs: 30 }).generate(request);
  assert.equal(timedOut.failure, 'timeout');
  assert.match(timedOut.reply.error.error, /超时/);
});

test('an image model that takes no aspect ratio is retried without one', async () => {
  const media = fakeMedia({ generate: (kind, input) => {
    if (input.aspectRatio) throw new HttpError(400, 'This model does not accept aspect_ratio; configure its size parameter');
    return { outputs: [{ bytes: Buffer.from(PNG_B64, 'base64'), mimeType: 'image/png' }] };
  } });
  const { reply } = await new AvatarImage({ media }).generate(request);
  assert.equal(reply.success.imageData, PNG_B64);
  assert.deepEqual(media.calls.filter(call => call[0] === 'generate').map(call => call[2]),
    [{ prompt: PROMPT, aspectRatio: '1:1' }, { prompt: PROMPT }]);
});

test('desktop / Web send the bare subject; the Host wraps it in its avatar prompt', async () => {
  const media = fakeMedia();
  const { reply } = await new AvatarImage({ media }).generate({ subject: '  a cartoon girl ', aspectRatio: '1:1' });
  assert.equal(reply.success.imageData, PNG_B64);
  const [, , input] = media.calls.find(call => call[0] === 'generate');
  assert.equal(input.prompt, avatarPrompt('a cartoon girl'));
  assert.match(input.prompt, /cropped to a circle/);
  assert.match(input.prompt, /\n\nSubject: a cartoon girl$/);
  assert.equal(input.aspectRatio, '1:1');
});

test('an empty description is answered without calling the provider', async () => {
  const media = fakeMedia();
  const { reply, failure } = await new AvatarImage({ media }).generate({ description: '   ' });
  assert.equal(failure, 'invalid');
  assert.match(reply.error.error, /描述/);
  assert.equal(media.calls.length, 0);
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function startHost(t, dir) {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const coreCalls = [];
  const coreUrl = await listen(t, (req, res) => { coreCalls.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl,
    internalToken: 'c'.repeat(40), speechEnv: {} });
  await host.start(0, '127.0.0.1');
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const { token } = await host.auth.pair({ password: 'AdminPass123', deviceName: 'Phone', platform: 'desktop', clientKind: 'android' });
  return { origin: `http://127.0.0.1:${host.server.address().port}`, token, coreCalls };
}

test('self-host server: RunGenerateImage and /local/avatar/generate use the Host image model', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const providerCalls = [];
  const providerUrl = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    providerCalls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
  });
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-avatar-image-'));
  await writeFile(join(dir, 'media.json'), JSON.stringify({ version: 1,
    providers: [{ id: 'fixture', name: 'Fixture', adapter: 'openai-images', baseUrl: `${providerUrl}/v1`, enabled: true, apiKey: 'fixture-key-not-real' }],
    models: [{ id: 'img', providerId: 'fixture', model: 'fixture-image', kind: 'image', enabled: true, name: 'Image', description: '', parameters: {} }],
    defaults: { image: 'img', video: '', watchVideo: '', videoReview: '' } }));
  const { origin, token, coreCalls } = await startHost(t, dir);
  const json = { 'content-type': 'application/json' };
  const body = JSON.stringify(request);

  // Unpaired callers never reach the image provider.
  for (const path of [AVATAR_IMAGE_LOCAL_PATH, AVATAR_IMAGE_RPC_PATH])
    assert.equal((await fetch(`${origin}${path}`, { method: 'POST', headers: json, body })).status, 401, path);
  assert.equal(providerCalls.length, 0);

  const auth = { ...json, authorization: `Bearer ${token}`, accept: 'application/json' };
  for (const path of [AVATAR_IMAGE_LOCAL_PATH, AVATAR_IMAGE_RPC_PATH]) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: auth, body });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await response.json(), { success: { imageData: PNG_B64, mimeType: 'image/png' } });
  }
  assert.equal(providerCalls.length, 2);
  assert.ok(providerCalls.every(call => call.path === '/v1/images/generations' && call.body.prompt === PROMPT
    && call.body.model === 'fixture-image' && call.body.size === '1024x1024'
    && call.authorization === 'Bearer fixture-key-not-real'));
  assert.deepEqual(coreCalls.filter(url => url.startsWith('/aiserver')), []);
  assert.equal((await fetch(`${origin}${AVATAR_IMAGE_LOCAL_PATH}`, { headers: auth })).status, 405);
});

test('self-host server: without an image model the avatar page gets a readable reason', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-avatar-image-off-'));
  const { origin, token } = await startHost(t, dir);
  const response = await fetch(`${origin}${AVATAR_IMAGE_RPC_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
  // HTTP 200: a non-2xx reply would make the official pane show its generic retry text instead.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-rokbot-avatar-failure'), 'not-configured');
  const reply = await response.json();
  assert.match(reply.error.error, /未配置图像生成服务/);
});
