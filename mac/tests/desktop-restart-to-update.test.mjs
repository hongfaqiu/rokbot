import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadManifestSigningKey, signDesktopUpdateManifest } from '../../ci/release-sign.mjs';
import { createLocalServices } from '../clients/desktop/local-services.mjs';
import { createNativeComputer } from '../clients/desktop/native-computer.mjs';
import { createDesktopUpdater } from '../clients/desktop/updater.mjs';

// Issue #27: once an update was staged, the Windows client quit by itself 30–60 s after every
// start (exit code 0) and logged "[missing local method] confirmRestartToUpdate".

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function fakeWindow() {
  return {
    isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false, isFocused: () => true,
    isVisible: () => true, isMinimized: () => false, on() {}, off() {}, webContents: { send() {} },
  };
}

async function stagedUpdater(t, { appVersion = '1.3.4', onInstallFile = async () => {} } = {}) {
  const dir = t.dir ??= await mkdtemp(path.join(os.tmpdir(), 'rokbot-restart-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = t.key ??= await loadManifestSigningKey(path.join(dir, 'key.json'));
  const payload = Buffer.from('rokbot-setup-1.3.5');
  const manifest = signDesktopUpdateManifest({
    platform: 'win32-x64', track: 'stable', version: '1.3.5', sha256: sha256(payload), size: payload.length,
    url: 'https://updates.example/RokBot-1.3.5-Setup.exe', publishedAt: '2026-11-28T08:00:00.000Z',
  }, key.privateKey);
  return createDesktopUpdater({
    appVersion, platformId: 'win32-x64', profileDir: dir, retryDelayMs: 5, onInstallFile,
    config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
    fetchImpl: async url => url.includes('/win32-x64.json')
      ? new Response(JSON.stringify(manifest), { status: 200 })
      : new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } }),
  });
}

/** The official renderer's restart-to-update listener (Zmt + _St/KM('menu') in the 1.x bundle). */
async function rendererRestartListener(call) {
  const pending = await call('getPendingRestartToUpdate');
  if (pending == null) return null;
  const confirmed = call('confirmRestartToUpdate', { version: pending.version });
  // The `menu` surface installs at once, with no dialog.
  const outcome = await call('quitAndInstallUpdate', { expectedVersion: pending.version });
  await confirmed;
  return outcome;
}

test('a staged update is not a restart request: starting the app must not install and quit', async t => {
  const installs = [];
  const updater = await stagedUpdater(t, { onInstallFile: async file => installs.push(file) });
  assert.equal((await updater.check({ download: true })).state.type, 'ready');
  const errors = t.mock.method(console, 'error', () => {});
  const call = await createLocalServices(t.dir, fakeWindow(), { command: async () => ({}), request: async () => ({}), updater });

  assert.equal(await rendererRestartListener(call), null);
  assert.deepEqual(installs, [], 'the renderer must not be told the user asked to restart');
  // A late confirm (e.g. from an older renderer) is answered, not thrown.
  assert.equal(await call('confirmRestartToUpdate', { version: '1.3.5' }), null);
  assert.equal(errors.mock.callCount(), 0);
});

test('an explicit restart request runs the official confirm + quitAndInstall flow once', async t => {
  const installs = [];
  const updater = await stagedUpdater(t, { onInstallFile: async (file, version) => installs.push({ file, version }) });
  await updater.check({ download: true });
  const events = [];
  const call = await createLocalServices(t.dir, fakeWindow(), {
    command: async () => ({}), request: async () => ({}), updater, emit: (name, value) => events.push({ name, value }),
  });

  call.requestRestartToUpdate('1.3.5');
  assert.deepEqual(events, [{ name: 'restart-to-update', value: { version: '1.3.5' } }]);
  assert.deepEqual(await rendererRestartListener(call), { status: 'requested' });
  assert.equal(installs.length, 1);
  assert.equal(installs[0].version, '1.3.5');
  assert.match(path.basename(installs[0].file), /^ready-stable-1\.3\.5\.exe$/);
  // Confirming consumed the request, so a reload of the renderer does not install again.
  assert.equal(await call('getPendingRestartToUpdate'), null);
  // A confirm for another version leaves a newer request alone (upstream JJe semantics).
  call.requestRestartToUpdate('1.3.6');
  await call('confirmRestartToUpdate', { version: '1.3.5' });
  assert.deepEqual(await call('getPendingRestartToUpdate'), { version: '1.3.6' });
});

test('if the installer ran but the app came back on the old version, the staged update is dropped', async t => {
  const first = await stagedUpdater(t);
  await first.check({ download: true });
  const updatesDir = path.join(t.dir, 'updates');
  const staged = path.join(updatesDir, 'ready-stable-1.3.5.exe');
  assert.ok(fs.existsSync(staged));
  // The silent installer is started and the app quits, but the install does not take effect.
  await first.quitAndInstall({ expectedVersion: '1.3.5' });

  const warn = t.mock.method(console, 'warn', () => {});
  const second = await stagedUpdater(t);
  assert.equal(second.status().state.type, 'idle', 'start normally instead of offering the same update again');
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.existsSync(path.join(updatesDir, 'pending-stable.json')), false);
  assert.ok(warn.mock.callCount() >= 1);
});

test('a staged update survives when handing over to the installer failed before quitting', async t => {
  const first = await stagedUpdater(t, { onInstallFile: async () => { throw new Error('spawn EACCES'); } });
  await first.check({ download: true });
  await assert.rejects(first.quitAndInstall({ expectedVersion: '1.3.5' }), /EACCES/);
  const second = await stagedUpdater(t);
  assert.equal(second.status().state.type, 'ready');
  assert.equal(second.status().state.version, '1.3.5');
});

test('synthesizeSpeech reads replies aloud through the Host /local/audio/speech endpoint', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-speech-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const call = await createLocalServices(dir, fakeWindow(), {
    command: async () => ({}),
    request: async (...args) => { requests.push(args); return { audio: 'SUQz', mimeType: 'audio/mpeg' }; },
  });
  assert.deepEqual(await call('synthesizeSpeech', { text: '你好', voiceId: 'ara' }), { audioBase64: 'SUQz', mimeType: 'audio/mpeg' });
  const [endpoint, body, signal, method, headers] = requests[0];
  assert.equal(endpoint, '/local/audio/speech');
  assert.deepEqual(body, { text: '你好', voiceId: 'ara' });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(method, 'POST');
  assert.equal(headers.Accept, 'application/json');
  await call('synthesizeSpeech', { text: 'hi' });
  assert.deepEqual(requests[1][1], { text: 'hi' });
});

test('a findComputerHelper that throws (Windows) means no computer tools, not an unhandled rejection', async () => {
  const native = await createNativeComputer({
    original: { findComputerHelper() { throw new TypeError("Cannot read properties of undefined (reading 'variant')"); } },
    profile: os.tmpdir(), decideLocalUse: () => null,
  });
  assert.deepEqual(native.tools, []);
});
