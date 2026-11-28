import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadManifestSigningKey, signDesktopDeltas, signDesktopUpdateManifest } from '../../ci/release-sign.mjs';
import { createDeltaBuffer } from '../clients/shared/delta.mjs';
import { buildWindowsDelayedInstallCommand, createDesktopUpdater } from '../clients/desktop/updater.mjs';

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

test('Desktop autoUpdateWhenIdle toggle off skips background download; enabling triggers staged ready', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desk-toggle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const key = await loadManifestSigningKey(path.join(dir, 'key.json'));
  const payload = Buffer.from('desktop-pkg-v2.0.0-payload');
  const manifest = signDesktopUpdateManifest({
    platform: 'darwin-arm64',
    track: 'stable',
    version: '2.0.0',
    sha256: sha256(payload),
    size: payload.length,
    url: 'https://updates.example/RokBot-2.0.0.dmg',
    publishedAt: '2026-11-27T08:00:00.000Z',
  }, key.privateKey);

  let binaryFetches = 0;
  const updater = createDesktopUpdater({
    appVersion: '1.0.0',
    platformId: 'darwin-arm64',
    profileDir: dir,
    retryDelayMs: 5,
    config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
    fetchImpl: async url => {
      if (url.includes('/darwin-arm64.json')) return new Response(JSON.stringify(manifest), { status: 200 });
      binaryFetches += 1;
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    },
  });

  // Default ON for background pre-download, can be toggled OFF in Settings.
  assert.equal(updater.status().autoUpdateWhenIdle, true);
  updater.setAutoUpdateWhenIdle({ enabled: false });
  assert.equal(updater.status().autoUpdateWhenIdle, false);

  const avail = await updater.check();
  assert.equal(avail.state.type, 'available');
  assert.equal(avail.state.version, '2.0.0');
  assert.equal(binaryFetches, 0, 'Must not download binary when autoUpdateWhenIdle is OFF');

  // Re-persisted across restart as disabled
  const restartedOff = createDesktopUpdater({
    appVersion: '1.0.0',
    platformId: 'darwin-arm64',
    profileDir: dir,
    retryDelayMs: 5,
    config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
    fetchImpl: async url => {
      if (url.includes('/darwin-arm64.json')) return new Response(JSON.stringify(manifest), { status: 200 });
      binaryFetches += 1;
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    },
  });
  assert.equal(restartedOff.status().autoUpdateWhenIdle, false);
  await restartedOff.check();
  assert.equal(binaryFetches, 0);

  // Toggling ON triggers download and stages pending restart state
  const ready = await restartedOff.download();
  assert.equal(binaryFetches, 1);
  assert.equal(ready.state.type, 'ready');
  assert.equal(ready.state.pendingRestart, true);
  assert.equal(ready.state.readyMessage, '已下载，重启即可更新');
});

test('Desktop updater discards corrupt downloads, invalid signatures, and tampered staged files cleanly', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desk-discard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const key = await loadManifestSigningKey(path.join(dir, 'key.json'));
  const otherKey = await loadManifestSigningKey(path.join(dir, 'other-key.json'));
  const payload = Buffer.from('good-installer-bytes-2.1.0');
  const goodManifest = signDesktopUpdateManifest({
    platform: 'linux-x64',
    track: 'stable',
    version: '2.1.0',
    sha256: sha256(payload),
    size: payload.length,
    url: 'https://updates.example/rokbot-2.1.0.deb',
    publishedAt: '2026-11-27T08:00:00.000Z',
  }, key.privateKey);
  const badSigManifest = signDesktopUpdateManifest({
    platform: 'linux-x64',
    track: 'stable',
    version: '2.1.0',
    sha256: sha256(payload),
    size: payload.length,
    url: 'https://updates.example/rokbot-2.1.0.deb',
    publishedAt: '2026-11-27T08:00:00.000Z',
  }, otherKey.privateKey);

  let mode = 'bad-sig';
  const updater = createDesktopUpdater({
    appVersion: '2.0.0',
    platformId: 'linux-x64',
    profileDir: dir,
    retryDelayMs: 5,
    config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
    fetchImpl: async url => {
      if (url.includes('/linux-x64.json')) {
        return new Response(JSON.stringify(mode === 'bad-sig' ? badSigManifest : goodManifest), { status: 200 });
      }
      const body = mode === 'bad-bytes' ? Buffer.from('x'.repeat(payload.length)) : payload;
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    },
  });

  // 1. Untrusted manifest signature rejected before download
  const sigFail = await updater.check();
  assert.equal(sigFail.state.type, 'idle');
  assert.equal(sigFail.state.lastCheck.failure.kind, 'installer_signature_invalid');

  // 2. Corrupt download bytes discarded (.part removed, no ready artifact)
  mode = 'bad-bytes';
  const shaFail = await updater.check();
  assert.equal(shaFail.state.type, 'idle');
  assert.equal(shaFail.state.lastCheck.failure.kind, 'installer_signature_invalid');
  const updatesDir = path.join(dir, 'updates');
  const leftover = fs.existsSync(updatesDir) ? fs.readdirSync(updatesDir) : [];
  assert.deepEqual(leftover, [], 'All corrupt .part and pending metadata must be discarded');

  // 3. Good download persists ready state, then tampering staged file causes discard on next start & quitAndInstall
  mode = 'good';
  const ok = await updater.check();
  assert.equal(ok.state.type, 'ready');
  const stagedDeb = path.join(updatesDir, 'ready-stable-2.1.0.deb');
  await writeFile(stagedDeb, 'tampered-on-disk');

  await assert.rejects(() => updater.quitAndInstall(), /checksum mismatch/);
  assert.equal(fs.existsSync(stagedDeb), false, 'Tampered staged file must be deleted');
  assert.equal(fs.existsSync(path.join(updatesDir, 'pending-stable.json')), false, 'Tampered pending metadata must be deleted');
});

test('Desktop updater persists pending-install state across restarts, supports HTTP Range resume + retries, and prefers deltas', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desk-persist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const key = await loadManifestSigningKey(path.join(dir, 'key.json'));
  const updatesDir = path.join(dir, 'updates');
  await mkdir(updatesDir, { recursive: true });

  const oldInstaller = Buffer.concat([randomBytes(32 * 1024), Buffer.from('v1.0.0-tail')]);
  const newInstaller = Buffer.concat([oldInstaller.subarray(0, 32 * 1024), randomBytes(8 * 1024)]);
  await writeFile(path.join(updatesDir, 'ready-stable-1.0.0.exe'), oldInstaller);

  const exactDelta = createDeltaBuffer(oldInstaller, newInstaller);

  const rangeSeen = [];
  let cutFirst = true;
  let fullDownloads = 0;

  let srv;
  const baseManifest = signDesktopUpdateManifest({
    platform: 'win32-x64',
    track: 'stable',
    version: '1.1.0',
    sha256: sha256(newInstaller),
    size: newInstaller.length,
    url: '/RokBot-1.1.0-Setup.exe',
    publishedAt: '2026-11-27T08:00:00.000Z',
  }, key.privateKey);
  const deltaEntry = {
    baseSha256: sha256(oldInstaller),
    baseSize: oldInstaller.length,
    sha256: sha256(exactDelta),
    size: exactDelta.length,
    url: '/win32-1.0.0-to-1.1.0.rbdelta',
  };
  const fullManifest = signDesktopDeltas({
    ...baseManifest,
    deltas: [deltaEntry],
  }, key.privateKey);

  srv = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/win32-x64.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(fullManifest));
    }
    if (pathname === '/win32-1.0.0-to-1.1.0.rbdelta') {
      if (req.headers.range) rangeSeen.push(req.headers.range);
      if (cutFirst && !req.headers.range) {
        cutFirst = false;
        const half = Math.floor(exactDelta.length / 2);
        res.writeHead(200, { 'content-length': exactDelta.length });
        res.write(exactDelta.subarray(0, half), () => setTimeout(() => res.destroy(), 20));
        return;
      }
      if (req.headers.range) {
        const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range)?.[1] ?? 0);
        const tail = exactDelta.subarray(start);
        res.writeHead(206, {
          'content-length': tail.length,
          'content-range': `bytes ${start}-${exactDelta.length - 1}/${exactDelta.length}`,
        });
        return res.end(tail);
      }
      res.writeHead(200, { 'content-length': exactDelta.length });
      return res.end(exactDelta);
    }
    if (pathname === '/RokBot-1.1.0-Setup.exe') {
      fullDownloads += 1;
      res.writeHead(200, { 'content-length': newInstaller.length });
      return res.end(newInstaller);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;

  // 1. Background download chooses delta, resumes via HTTP Range after drop, stages ready-stable-1.1.0.exe
  const updater1 = createDesktopUpdater({
    appVersion: '1.0.0',
    platformId: 'win32-x64',
    profileDir: dir,
    retryDelayMs: 5,
    config: { updateUrl: baseUrl, updatePublicKey: key.publicKeySpkiBase64 },
  });
  const s1 = await updater1.check();
  assert.equal(s1.state.type, 'ready');
  assert.equal(s1.state.version, '1.1.0');
  assert.equal(fullDownloads, 0, 'Delta match should avoid full installer download');
  assert.ok(rangeSeen.some(h => h.startsWith('bytes=')), `Expected HTTP Range header, saw ${JSON.stringify(rangeSeen)}`);

  // 2. Cold restart BEFORE installing: restores ready state immediately with zero network fetches
  const installed = [];
  const updater2 = createDesktopUpdater({
    appVersion: '1.0.0',
    platformId: 'win32-x64',
    profileDir: dir,
    config: { updateUrl: baseUrl, updatePublicKey: key.publicKeySpkiBase64 },
    onInstallFile: async (file, version) => installed.push({ file, version }),
    fetchImpl: async () => { throw new Error('Network should not be needed to restore persisted pending state'); },
  });
  assert.equal(updater2.status().state.type, 'ready');
  assert.equal(updater2.status().state.version, '1.1.0');
  assert.equal(updater2.status().state.readyMessage, '已下载，重启即可更新');

  await updater2.quitAndInstall();
  assert.equal(installed.length, 1);
  assert.equal(installed[0].version, '1.1.0');
  assert.equal((await readFile(installed[0].file)).equals(newInstaller), true);

  // 3. Cold restart AFTER upgrading to 1.1.0: cleans up pending-stable.json and returns to idle
  const updater3 = createDesktopUpdater({
    appVersion: '1.1.0',
    platformId: 'win32-x64',
    profileDir: dir,
    config: { updateUrl: baseUrl, updatePublicKey: key.publicKeySpkiBase64 },
  });
  assert.equal(updater3.status().state.type, 'idle');
  assert.equal(fs.existsSync(path.join(updatesDir, 'pending-stable.json')), false);
});

test('Desktop Windows delayed installer waits for app exit and Linux UI patch is unconditional', async () => {
  const psArgs = buildWindowsDelayedInstallCommand("C:\\Program Files\\RokBot\\RokBot-Setup.exe", 4242);
  assert.ok(psArgs.includes('-Command'));
  const cmd = psArgs[psArgs.length - 1];
  assert.match(cmd, /Wait-Process -Id 4242/);
  assert.match(cmd, /\/S|Start-Process/);

  const linuxPatch = await readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../linux/patchers/desktop/patch.mjs'), 'utf8');
  assert.match(linuxPatch, /const updateUiPatch = await patchDesktopUpdateSettingsUi\(unpacked\);/);
  const localSvc = await readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../clients/desktop/local-services.mjs'), 'utf8');
  assert.match(localSvc, /getPendingRestartToUpdate:/);
  // A staged update is reported through getUpdateStatus only; see desktop-restart-to-update.test.mjs (#27).
  assert.match(localSvc, /confirmRestartToUpdate:/);
});
