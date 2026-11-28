import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAvatarImageGenerator } from '../clients/desktop/avatar-image.mjs';
import { createLocalServices } from '../clients/desktop/local-services.mjs';

// Bot avatar editor > Generate. The official renderer (1.1.0 and 1.2.3) calls
// desktop.generateAgentAvatarImage({ description }) and loads the result as an image source: the
// official main process returns a data: URL string (avatarImages.generateImage), and the renderer
// shows a thrown error's message. RokBot's main process did not implement it ("[missing local
// method] generateAgentAvatarImage"). It now asks the Host's /local/avatar/generate with the bare
// subject; the Host wraps it in an avatar prompt and generates with its default image model.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function fakeRequest(reply) {
  const calls = [];
  const request = async (endpoint, args, signal, method, headers) => {
    calls.push({ endpoint, args, method, headers, hasSignal: signal instanceof AbortSignal });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { request, calls };
}

test('generateAgentAvatarImage returns the Host image as a data: URL', async () => {
  const { request, calls } = fakeRequest({ success: { imageData: PNG_B64, mimeType: 'image/png' } });
  const generate = createAvatarImageGenerator({ request });
  assert.equal(await generate({ description: '  a cartoon girl ' }), `data:image/png;base64,${PNG_B64}`);
  assert.deepEqual(calls, [{ endpoint: '/local/avatar/generate', args: { subject: 'a cartoon girl', aspectRatio: '1:1' },
    method: 'POST', headers: { Accept: 'application/json' }, hasSignal: true }]);
});

test('the Host reason (not configured, provider, timeout) is the thrown message', async () => {
  const reason = '未配置图像生成服务：请在 Host 管理页的「媒体服务」中设置默认图像模型。';
  const { request } = fakeRequest({ error: { error: reason } });
  await assert.rejects(createAvatarImageGenerator({ request })({ description: 'cat' }), error => error.message === reason);
  const empty = fakeRequest({});
  await assert.rejects(createAvatarImageGenerator({ request: empty.request })({ description: 'cat' }), /Host|头像/);
  const blank = fakeRequest({});
  await assert.rejects(createAvatarImageGenerator({ request: blank.request })({ description: '   ' }), /描述|Describe/);
  assert.equal(blank.calls.length, 0);
});

test('the local desktop services implement generateAgentAvatarImage', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-avatar-generate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const window = { isDestroyed: () => false, on() {}, off() {}, webContents: { send() {} } };
  const { request, calls } = fakeRequest({ success: { imageData: PNG_B64, mimeType: 'image/png' } });
  const call = await createLocalServices(dir, window, { command: async () => ({}), request });
  assert.equal(call.supports('generateAgentAvatarImage'), true);
  assert.equal(await call('generateAgentAvatarImage', { description: 'a cartoon girl' }), `data:image/png;base64,${PNG_B64}`);
  assert.equal(calls[0].endpoint, '/local/avatar/generate');
});
