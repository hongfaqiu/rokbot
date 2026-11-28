import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Web client runs the desktop renderer, whose avatar editor calls
// desktop.generateAgentAvatarImage({ description }) and expects a data: URL. Before, services.js
// threw "Unknown desktop service method: generateAgentAvatarImage". It now shares the desktop
// handler (mac/clients/desktop/avatar-image.mjs), which the bundle must carry.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('the Web bundle ships the shared avatar generator', async () => {
  const source = await readFile(path.join(repo, 'web/patchers/patch.mjs'), 'utf8');
  const shared = /const sharedAssets = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
  assert.match(shared, /'avatar-image\.mjs'/);
});

test('Web services answer generateAgentAvatarImage through the Host', async t => {
  const stage = await mkdtemp(path.join(tmpdir(), 'rokbot-web-avatar-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const client = path.join(stage, 'client');
  await cp(path.join(repo, 'web/client'), client, { recursive: true });
  await cp(path.join(repo, 'mac/clients/desktop'), path.join(client, 'desktop'), { recursive: true });
  const { createServices } = await import(pathToFileURL(path.join(client, 'services.js')).href);
  const calls = [];
  const services = createServices({
    gateway: { command: async () => null, request: async (...args) => { calls.push(args); return { success: { imageData: PNG_B64, mimeType: 'image/png' } }; } },
    server: 'http://127.0.0.1:1', emit: () => {}, settings: {}, systemLocale: 'en-US', theme: {}, language: {}, boot: {},
    experiments: {}, profile: {}, voice: { refresh: () => ({ featureGates: {} }), set: async () => null },
    persistence: { readClientPersistence: () => null }, attachments: {}, onSettingsChanged: () => {},
    systemDark: () => false, applyChrome: () => {},
  });
  assert.equal(services.has('generateAgentAvatarImage'), true);
  assert.equal(await services.call('generateAgentAvatarImage', { description: 'a cartoon girl' }), `data:image/png;base64,${PNG_B64}`);
  assert.equal(calls[0][0], '/local/avatar/generate');
  assert.deepEqual(calls[0][1], { subject: 'a cartoon girl', aspectRatio: '1:1' });
});
