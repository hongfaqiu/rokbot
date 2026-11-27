// RokBot Android versioning: every RokBot build needs its own, growing versionCode so Android
// upgrades it in place (official 1.26.0 is 3212).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractManifestInfo, parseAxml, patchManifest, resolveRokbotVersion } from '../patchers/manifest.mjs';
import { entryBytes, readZip } from '../patchers/signing.mjs';
import { runPatchPipeline } from '../release/patch-android.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_APK = path.join(path.resolve(__dirname, '..'), 'bin/rokbot-native-base.apk');

test('Versioning: versionCode = upstream*100 + build, always above the official 3212', () => {
  const upstream = { versionCode: 3212, versionName: '1.26.0' };
  assert.deepEqual(resolveRokbotVersion(upstream, { rokbotBuild: 1 }), { versionCode: 321201, versionName: '1.26.0-rokbot.1' });
  assert.deepEqual(resolveRokbotVersion(upstream, { rokbotBuild: '2' }), { versionCode: 321202, versionName: '1.26.0-rokbot.2' });
  // Next upstream base keeps the sequence monotonic: 3213 build 1 > 3212 build 99.
  assert.ok(resolveRokbotVersion({ versionCode: 3213, versionName: '1.27.0' }, { rokbotBuild: 1 }).versionCode
    > resolveRokbotVersion(upstream, { rokbotBuild: 99 }).versionCode);
  // Explicit overrides win; nothing set keeps the upstream manifest untouched.
  assert.deepEqual(resolveRokbotVersion(upstream, { rokbotBuild: 3, versionName: '1.26.0-rc' }), { versionCode: 321203, versionName: '1.26.0-rc' });
  assert.deepEqual(resolveRokbotVersion(upstream, { versionCode: '400000' }), { versionCode: 400000, versionName: null });
  assert.deepEqual(resolveRokbotVersion(upstream, {}), { versionCode: null, versionName: null });
  assert.throws(() => resolveRokbotVersion(upstream, { rokbotBuild: 0 }), /between 1 and 99/);
  assert.throws(() => resolveRokbotVersion(upstream, { rokbotBuild: 100 }), /between 1 and 99/);
  assert.throws(() => resolveRokbotVersion(upstream, { versionCode: 3000 }), /lower than the upstream 3212/);
  assert.throws(() => resolveRokbotVersion(upstream, { versionCode: 'abc' }), /positive integer/);
});

test('Versioning manifest patch: rewrites versionCode/versionName in place, keeps upstream values otherwise', () => {
  const zip = readZip(fs.readFileSync(FIXTURE_APK));
  const axml = entryBytes(zip.entries.find(e => e.name === 'AndroidManifest.xml'));
  assert.deepEqual(extractManifestInfo(axml), { packageName: 'ai.x.grok.bot', versionCode: 3283, versionName: '1.27.0' });

  const patched = patchManifest(axml, { packageName: 'dev.rokbot.local', versionCode: 328301, versionName: '1.27.0-rokbot.1' });
  assert.deepEqual(extractManifestInfo(patched), { packageName: 'dev.rokbot.local', versionCode: 328301, versionName: '1.27.0-rokbot.1' });
  const root = parseAxml(patched).rootNodes.find(n => n.name === 'manifest');
  const vc = root.attributes.find(a => a.name === 'versionCode');
  assert.equal(vc.type, 0x10, 'versionCode must stay a TYPE_INT_DEC attribute');
  assert.equal(root.attributes.filter(a => a.name === 'versionCode').length, 1);
  assert.equal(root.attributes.filter(a => a.name === 'versionName').length, 1);

  // Without a version override the upstream numbers are preserved.
  assert.equal(extractManifestInfo(patchManifest(axml, { packageName: 'dev.rokbot.local' })).versionCode, 3283);
});

test('Versioning pipeline: --rokbot-build lands in the APK and patch-report', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-version-'));
  try {
    const out = path.join(tmp, 'out', 'rokbot.apk');
    const report = await runPatchPipeline({ inputApk: FIXTURE_APK, outputApk: out, keystore: path.join(tmp, 'k.json'), devSigning: true, rokbotBuild: 7, force: true });
    assert.equal(report.upstreamVersionCode, 3283);
    assert.equal(report.versionCode, 328307);
    assert.equal(report.versionName, '1.27.0-rokbot.7');
    const axml = entryBytes(readZip(fs.readFileSync(out)).entries.find(e => e.name === 'AndroidManifest.xml'));
    assert.deepEqual(extractManifestInfo(axml), { packageName: 'dev.rokbot.local', versionCode: 328307, versionName: '1.27.0-rokbot.7' });
    await assert.rejects(runPatchPipeline({ inputApk: FIXTURE_APK, outputApk: out, keystore: path.join(tmp, 'k.json'), devSigning: true, versionCode: 100, force: true }),
      /lower than the upstream 3283/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
