// Unit & integration tests for Milestones M2-M5 patcher & MockHost upgrades.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ANDROID_NS, KNOWN_RES_IDS, extractManifestInfo, parseAxml, patchManifest, serializeAxml } from '../patchers/manifest.mjs';
import { findMipmapResourceId, setColorResourceValue } from '../patchers/arsc.mjs';
import { loadBytepatchRecipe, loadGatewayTemplateMetadata, patchHermesBundleSafely } from '../patchers/hermes.mjs';
import { createEntry, entryBytes, readZip, verifyApk, writeZip } from '../patchers/signing.mjs';
import { registerHooks } from 'node:module';
import { ANDROID_ICON_BACKGROUND_ARGB, runPatchPipeline } from '../release/patch-android.mjs';
import { findNotificationsHostSwitchCandidates, findTopLeftCornerButton, isBotsListReady, parseTopActivityOutput } from './emulator-e2e.mjs';
import { MockHostServer } from './mock-host.mjs';

let mcpHookRegistered = false;
async function loadHostConnectorModules() {
  if (!mcpHookRegistered) {
    mcpHookRegistered = true;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('@modelcontextprotocol/sdk/')) {
          return { url: `stub-mcp:${specifier}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url.startsWith('stub-mcp:')) {
          return {
            format: 'module',
            source: 'export class Client { async connect(){} async close(){} async listTools(){ return { tools: [] }; } }\nexport class StreamableHTTPClientTransport {}\nexport class SSEClientTransport {}',
            shortCircuit: true,
          };
        }
        return nextLoad(url, context);
      },
    });
  }
  const [{ Connectors }, { Plugins }, { Skills }] = await Promise.all([
    import('../../host/server/connectors.mjs'),
    import('../../host/server/plugins.mjs'),
    import('../../host/server/skills.mjs'),
  ]);
  return { Connectors, Plugins, Skills };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const NATIVE_ROOT = path.resolve(__dirname, '..');
const FIXTURE_APK = path.join(NATIVE_ROOT, 'bin/rokbot-native-base.apk');
const BASE_TARGET_APK = path.join(NATIVE_ROOT, 'bin/rokbot-native-base.apk');

function getAndroidAttr(node, attrName) {
  return (node.attributes || []).find(a => a.name === attrName && a.namespace === ANDROID_NS);
}

test('M2-Manifest: injects RokBotInitProvider, all 9 Activities, 2 foreground services, 2 receivers, deep links & permissions', () => {
  const inputApk = fs.existsSync(BASE_TARGET_APK) ? BASE_TARGET_APK : FIXTURE_APK;
  const zip = readZip(fs.readFileSync(inputApk));
  const origAxml = entryBytes(zip.entries.find(e => e.name === 'AndroidManifest.xml'));
  const info = extractManifestInfo(origAxml);
  assert.ok(info.packageName, 'extractManifestInfo must return packageName');

  const patchedAxml = patchManifest(origAxml, { packageName: info.packageName });
  const parsed = parseAxml(patchedAxml);
  const manifest = parsed.rootNodes.find(n => n.name === 'manifest');
  const app = manifest.children.find(n => n.name === 'application');

  // Verify RokBotInitProvider
  const provider = app.children.find(
    c => c.name === 'provider' && getAndroidAttr(c, 'name')?.value === 'dev.rokbot.nativeapp.RokBotInitProvider'
  );
  assert.ok(provider, 'RokBotInitProvider must be injected');
  assert.equal(getAndroidAttr(provider, 'authorities')?.value, `${info.packageName}.rokbot.init`);
  assert.equal(getAndroidAttr(provider, 'exported')?.value, false);
  assert.equal(getAndroidAttr(provider, 'initOrder')?.value, 999999);

  // Verify iOS-parity native modal activities (no homemade BotListActivity/ChatActivity/VoiceCallActivity/ConnectorsActivity)
  const expectedActivities = [
    'dev.rokbot.nativeapp.PairingActivity',
    'dev.rokbot.nativeapp.LibraryActivity',
    'dev.rokbot.nativeapp.PushSettingsActivity',
    'dev.rokbot.nativeapp.ProfileActivity',
    'dev.rokbot.nativeapp.UsageActivity',
    'dev.rokbot.nativeapp.ComputersActivity',
    'dev.rokbot.nativeapp.ComputerViewerActivity',
    'dev.rokbot.nativeapp.ModelsActivity',
    'dev.rokbot.nativeapp.AvatarStyleActivity',
    'dev.rokbot.nativeapp.ShareTargetActivity',
  ];
  for (const actName of expectedActivities) {
    const found = app.children.some(
      c => c.name === 'activity' && getAndroidAttr(c, 'name')?.value === actName
    );
    assert.ok(found, `Activity ${actName} must be registered`);
  }
  for (const forbiddenAct of [
    'dev.rokbot.nativeapp.BotListActivity',
    'dev.rokbot.nativeapp.ChatActivity',
    'dev.rokbot.nativeapp.VoiceCallActivity',
    'dev.rokbot.nativeapp.ConnectorsActivity',
  ]) {
    const found = app.children.some(
      c => c.name === 'activity' && getAndroidAttr(c, 'name')?.value === forbiddenAct
    );
    assert.equal(found, false, `Homemade primary UI activity ${forbiddenAct} must NOT be registered`);
  }

  // Verify official launcher MainActivity carries rokbot-local://agent deep-link filter
  const mainAct = app.children.find(
    c => c.name === 'activity' && (getAndroidAttr(c, 'name')?.value || '').endsWith('.MainActivity')
  );
  assert.ok(mainAct, 'Official MainActivity must exist in manifest');
  const hasDeepLink = (mainAct.children || []).some(
    f => f.name === 'intent-filter' && (f.children || []).some(
      d => d.name === 'data' &&
        getAndroidAttr(d, 'scheme')?.value === 'rokbot-local' &&
        getAndroidAttr(d, 'host')?.value === 'agent'
    )
  );
  assert.ok(hasDeepLink, 'Official MainActivity must expose rokbot-local://agent deep-link filter');

  // Verify NotificationService (0x1) & VoiceCallService (0x80)
  const notifSvc = app.children.find(
    c => c.name === 'service' && getAndroidAttr(c, 'name')?.value === 'dev.rokbot.nativeapp.NotificationService'
  );
  const voiceSvc = app.children.find(
    c => c.name === 'service' && getAndroidAttr(c, 'name')?.value === 'dev.rokbot.nativeapp.VoiceCallService'
  );
  assert.equal(getAndroidAttr(notifSvc, 'foregroundServiceType')?.value, 0x00000001);
  assert.equal(getAndroidAttr(voiceSvc, 'foregroundServiceType')?.value, 0x00000080);

  // Verify BootReceiver & UnifiedPushReceiver
  for (const rcvName of ['dev.rokbot.nativeapp.BootReceiver', 'dev.rokbot.nativeapp.UnifiedPushReceiver']) {
    assert.ok(
      app.children.some(c => c.name === 'receiver' && getAndroidAttr(c, 'name')?.value === rcvName),
      `Receiver ${rcvName} must be injected`
    );
  }

  // Verify audio/boot/foreground permissions
  const perms = new Set(
    manifest.children
      .filter(c => c.name === 'uses-permission')
      .map(c => getAndroidAttr(c, 'name')?.value)
  );
  for (const reqPerm of [
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.POST_NOTIFICATIONS',
  ]) {
    assert.ok(perms.has(reqPerm), `Missing permission ${reqPerm}`);
  }
});

test('M2-Manifest: patchManifest preserves original official RN LAUNCHER activity idempotently', () => {
  assert.ok(fs.existsSync(BASE_TARGET_APK), 'Base target APK must exist (run test-target/build-base.sh)');
  const zip = readZip(fs.readFileSync(BASE_TARGET_APK));
  const origAxml = entryBytes(zip.entries.find(e => e.name === 'AndroidManifest.xml'));

  const once = patchManifest(origAxml, {});
  const twice = patchManifest(once, {});
  const parsed = parseAxml(twice);
  const app = parsed.rootNodes.find(n => n.name === 'manifest').children.find(n => n.name === 'application');

  // Expo metadata disabled
  const expoEnabled = app.children.find(
    c => c.name === 'meta-data' && getAndroidAttr(c, 'name')?.value === 'expo.modules.updates.ENABLED'
  );
  assert.equal(getAndroidAttr(expoEnabled, 'value')?.value, false);

  // Official MainActivity remains primary LAUNCHER (never replaced by homemade BotListActivity)
  const launcherActivities = app.children.filter(
    c => c.name === 'activity' && (c.children || []).some(
      f => f.name === 'intent-filter' && (f.children || []).some(
        cat => cat.name === 'category' && getAndroidAttr(cat, 'name')?.value === 'android.intent.category.LAUNCHER'
      )
    )
  );
  assert.equal(launcherActivities.length, 1);
  const launcherName = getAndroidAttr(launcherActivities[0], 'name')?.value || '';
  assert.ok(launcherName === 'ai.x.grok.bot.MainActivity' || launcherName === '.MainActivity',
    `Expected original MainActivity launcher, got ${launcherName}`);
});

test('M2-Hermes: patchHermesBundleSafely handles small/mismatched real bundles without corrupting them', () => {
  const smallBundle = Buffer.from('small synthetic bundle');
  const smallRes = patchHermesBundleSafely(smallBundle, { host: 'http://127.0.0.1:18080', pairingCode: 'K7M9P2' });
  assert.equal(smallRes.patched, false);
  assert.equal(smallRes.mode, 'companion-runtime-fallback');
  assert.ok(smallRes.buffer.equals(smallBundle));

  // Large non-zero real-looking bundle whose SHA-256 differs from pinned recipe must NOT blindly splice
  const meta = loadGatewayTemplateMetadata();
  const realLikeMismatch = Buffer.alloc(meta.bodyOffset + meta.bodyCapacity + 100);
  Buffer.from([0xc6, 0x1f, 0x06, 0x03, 0x62, 0x00, 0x00, 0x00]).copy(realLikeMismatch, 0);
  const mismatchRes = patchHermesBundleSafely(realLikeMismatch, { host: 'http://127.0.0.1:18080', pairingCode: 'K7M9P2' });
  assert.equal(mismatchRes.patched, false);
  assert.equal(mismatchRes.pinMatched, false);
  assert.equal(mismatchRes.mode, 'companion-runtime-fallback');
  assert.ok(mismatchRes.buffer.equals(realLikeMismatch));
});

test('M3-Pipeline: strips legacy v1 META-INF, keeps resources.arsc uncompressed, injects preconfig & refuses android/ keystore', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-pipeline-m3-'));
  const tmpIn = path.join(tmpDir, 'in.apk');
  const tmpOut = path.join(tmpDir, 'out.apk');
  const tmpKeystore = path.join(tmpDir, 'signing.json');

  try {
    const baseZip = readZip(fs.readFileSync(BASE_TARGET_APK));
    // Simulate compressed resources.arsc and legacy v1 signatures
    const entries = baseZip.entries.map(e =>
      e.name === 'resources.arsc' ? createEntry('resources.arsc', entryBytes(e), { store: false }) : e
    );
    entries.push(createEntry('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'), { store: false }));
    entries.push(createEntry('META-INF/CERT.SF', Buffer.from('Signature-Version: 1.0\n'), { store: false }));
    entries.push(createEntry('META-INF/CERT.RSA', Buffer.from('dummy-rsa'), { store: false }));
    fs.writeFileSync(tmpIn, writeZip(entries));

    const report = await runPatchPipeline({
      inputApk: tmpIn,
      outputApk: tmpOut,
      host: 'http://127.0.0.1:18080',
      pairingCode: 'K7M9P2',
      keystore: tmpKeystore,
      devSigning: true,
      force: true,
    });

    assert.equal(report.actualPackageName, 'ai.x.grok.bot');
    assert.equal(report.actualVersionName, '1.27.0');
    assert.equal(report.mode, 'rn-official-apk-patch');
    assert.equal(report.bundlePatched, false);
    assert.equal(report.bundlePatchMode, 'companion-runtime-fallback');
    assert.ok(fs.existsSync(tmpKeystore));

    const ks = JSON.parse(fs.readFileSync(tmpKeystore, 'utf8'));
    assert.equal(ks.schema, 'rokbot-android-signing/v1');
    assert.ok(ks.privateKey && ks.certificate);

    const outZip = readZip(fs.readFileSync(tmpOut));
    assert.ok(!outZip.entries.some(e => e.name.startsWith('META-INF/')), 'Old v1 META-INF signatures must be stripped');
    const arsc = outZip.entries.find(e => e.name === 'resources.arsc');
    assert.equal(arsc.method, 0, 'resources.arsc must be stored uncompressed');
    assert.equal(arsc.dataStart % 4, 0, 'resources.arsc must be 4-byte aligned');

    const preconfigEntry = outZip.entries.find(e => e.name === 'assets/rokbot-preconfig.json');
    assert.ok(preconfigEntry, 'assets/rokbot-preconfig.json must be injected when host/code provided');
    const preconfig = JSON.parse(entryBytes(preconfigEntry).toString('utf8'));
    assert.equal(preconfig.host, 'http://127.0.0.1:18080');
    assert.equal(preconfig.pairingCode, 'K7M9P2');

    const verified = verifyApk(fs.readFileSync(tmpOut));
    assert.equal(verified.verified, true);

    // Ensure refusal if keystore points inside android/
    await assert.rejects(
      runPatchPipeline({
        inputApk: tmpIn,
        outputApk: tmpOut,
        keystore: path.join(PROJECT_ROOT, 'android/evil-signing.json'),
        force: true,
      }),
      /Security violation/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('M4-MockHost: supports name/fileName DELETE, /local/profile, /local/usage, /local/computers, and transcript persistence', async () => {
  const host = new MockHostServer({ port: 0, pairingKey: 'ABCDEF' });
  await host.start();
  try {
    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: 'ABCDEF', deviceName: 'TestUnit', platform: 'android' }),
    }).then(r => r.json());
    const auth = { Authorization: `Bearer ${pairRes.token}`, 'Content-Type': 'application/json' };

    // Profile GET & PUT (must reject omitted avatarDataUrl, accept null or valid data URL)
    const p1 = await fetch(`${host.origin}/local/profile`, { headers: auth }).then(r => r.json());
    assert.ok(p1.displayName);
    const badProfileRes = await fetch(`${host.origin}/local/profile`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ displayName: 'Missing Avatar Key' }),
    });
    assert.equal(badProfileRes.status, 400);

    const p2 = await fetch(`${host.origin}/local/profile`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ displayName: 'Updated Native', avatarDataUrl: null }),
    }).then(r => r.json());
    assert.equal(p2.displayName, 'Updated Native');
    assert.equal(p2.avatarDataUrl, null);

    // getAgentTranscriptTail must reject beforeSeq: null
    const badTailRes = await fetch(`${host.origin}/api/getAgentTranscriptTail`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default', beforeSeq: null, limit: 20 }),
    });
    assert.equal(badTailRes.status, 400);

    // Usage & Computers
    const usage = await fetch(`${host.origin}/local/usage?timeZone=UTC`, { headers: auth }).then(r => r.json());
    assert.ok(typeof usage.total === 'number' && typeof usage.input === 'number' && typeof usage.output === 'number');
    const comps = await fetch(`${host.origin}/local/computers`, { headers: auth }).then(r => r.json());
    assert.equal(comps.available, true);
    assert.ok(Array.isArray(comps.computers) && comps.computers.length >= 1);

    // sendPrompt persists into getAgentTranscriptTail
    await fetch(`${host.origin}/api/sendPrompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: crypto.randomUUID(), prompt: 'Persisted prompt' }),
    });
    const tail = await fetch(`${host.origin}/api/getAgentTranscriptTail`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default', limit: 20 }),
    }).then(r => r.json());
    assert.ok(tail.entries.some(e => e.role === 'user' && e.content === 'Persisted prompt'));
    assert.ok(tail.entries.some(e => e.role === 'assistant' && e.message?.content?.includes('Persisted prompt')));

    // DELETE /local/files with body.name (real Host contract)
    await fetch(`${host.origin}/local/files`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 'agent-default', name: 'note.txt', contentType: 'text/plain', bytesBase64: Buffer.from('abc').toString('base64') }),
    });
    await fetch(`${host.origin}/local/files`, {
      method: 'DELETE',
      headers: auth,
      body: JSON.stringify({ agentId: 'agent-default', name: 'note.txt' }),
    });
    const listAfter = await fetch(`${host.origin}/local/files?agentId=agent-default`, { headers: auth }).then(r => r.json());
    assert.equal((listAfter.files || []).length, 0);
  } finally {
    await host.stop();
  }
});

test('M5-Manifest: strips networkSecurityConfig and attaches deep links onto MainActivity while preserving LAUNCHER', () => {
  const inputApk = fs.existsSync(BASE_TARGET_APK) ? BASE_TARGET_APK : FIXTURE_APK;
  const zip = readZip(fs.readFileSync(inputApk));
  const origAxml = entryBytes(zip.entries.find(e => e.name === 'AndroidManifest.xml'));
  const info = extractManifestInfo(origAxml);

  // Inject synthetic networkSecurityConfig on application before patching to simulate real RN APK
  const parsedOrig = parseAxml(origAxml);
  const manifestOrig = parsedOrig.rootNodes.find(n => n.name === 'manifest');
  const appOrig = manifestOrig.children.find(n => n.name === 'application');
  appOrig.attributes.push({
    namespace: ANDROID_NS,
    name: 'networkSecurityConfig',
    resourceId: 0x01010527,
    type: 0x01,
    rawValue: '@xml/network_security_config',
    value: 0x7f0e0001,
    data: 0x7f0e0001,
  });

  const modifiedOrigAxml = serializeAxml(parsedOrig);
  assert.ok(
    getAndroidAttr(
      parseAxml(modifiedOrigAxml).rootNodes.find(n => n.name === 'manifest').children.find(n => n.name === 'application'),
      'networkSecurityConfig'
    ),
    'Precondition: synthetic networkSecurityConfig must be present before patching'
  );

  const patchedAxml = patchManifest(modifiedOrigAxml, {
    packageName: info.packageName,
  });
  const parsed = parseAxml(patchedAxml);
  const app = parsed.rootNodes.find(n => n.name === 'manifest').children.find(n => n.name === 'application');

  assert.equal(getAndroidAttr(app, 'usesCleartextTraffic')?.value, true);
  assert.equal(getAndroidAttr(app, 'networkSecurityConfig'), undefined);

  const mainAct = app.children.find(
    c => c.name === 'activity' && (getAndroidAttr(c, 'name')?.value || '').endsWith('.MainActivity')
  );
  if (mainAct) {
    const hasLauncher = (mainAct.children || []).some(filter =>
      filter.name === 'intent-filter' && (filter.children || []).some(
        c => c.name === 'category' && getAndroidAttr(c, 'name')?.value === 'android.intent.category.LAUNCHER'
      )
    );
    assert.equal(hasLauncher, true, 'Official MainActivity must retain LAUNCHER category');
    const hasDeepLink = (mainAct.children || []).some(filter =>
      filter.name === 'intent-filter' && (filter.children || []).some(
        d => d.name === 'data' && getAndroidAttr(d, 'scheme')?.value === 'rokbot-local'
      )
    );
    assert.equal(hasDeepLink, true, 'Official MainActivity must carry grokbot-local deep-link filter');
  }
});

test('M5-RealHostProtocol: verifies POSIX committedPath -> file:// readback, user-attachment + send-message transcript, and transcript SSE events', async () => {
  const host = new MockHostServer({ port: 0, pairingKey: 'REAL99', realHostProtocol: true });
  await host.start();
  try {
    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: 'REAL99', deviceName: 'RealProtoProbe', platform: 'android' }),
    }).then(r => r.json());
    const auth = { Authorization: `Bearer ${pairRes.token}`, 'Content-Type': 'application/json' };

    // Chunked upload returns POSIX path
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const upRes = await fetch(`${host.origin}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId: crypto.randomUUID(),
        filename: 'pixel.png',
        offset: 0,
        totalSize: png1x1.length,
        bytesBase64: png1x1.toString('base64'),
      }),
    }).then(r => r.json());
    assert.ok(upRes.committedPath.startsWith('/data/runtime/host-data/agents/'), `Expected POSIX committedPath, got ${upRes.committedPath}`);

    // Raw POSIX fails on /connect/attachment; file:// succeeds
    const rawPreview = await fetch(`${host.origin}/connect/attachment`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ url: upRes.committedPath }),
    });
    assert.equal(rawPreview.status, 400);

    const fileUriPreview = await fetch(`${host.origin}/connect/attachment`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ url: `file://${upRes.committedPath}` }),
    }).then(r => r.json());
    assert.ok(fileUriPreview.dataUrl.startsWith('data:image/png;base64,'));

    // Connect SSE stream and verify real Host channels (agent-upserted + transcript)
    const ac = new AbortController();
    const ssePromise = fetch(`${host.origin}/events`, {
      headers: { Authorization: `Bearer ${pairRes.token}`, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const sseRes = await ssePromise;
    const reader = sseRes.body.getReader();

    const nonce = crypto.randomUUID();
    await fetch(`${host.origin}/api/sendPrompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: nonce,
        prompt: 'Real proto check',
        attachmentPaths: [upRes.committedPath],
        attachmentNames: ['pixel.png'],
      }),
    });

    let rawSse = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !rawSse.includes('"send-message"')) {
      const { value, done } = await reader.read();
      if (done) break;
      rawSse += Buffer.from(value).toString('utf-8');
    }
    ac.abort();

    assert.ok(rawSse.includes('"channel":"agent-upserted"'), 'SSE must broadcast agent-upserted');
    assert.ok(rawSse.includes('"channel":"transcript"'), 'SSE must broadcast transcript events');
    assert.ok(rawSse.includes('"kind":"user-attachment"'), 'SSE must include user-attachment row');
    assert.ok(rawSse.includes('"kind":"send-message"'), 'SSE must include send-message reply row');
  } finally {
    await host.stop();
  }
});

test('M5-RealHostProtocol-FullSchemas: verifies real-host AgentSummary, slim avatars, trays/asyncTasks, flat windowed transcript, hostStatus, hostSettings fields, foreverBox windows, SSE channel filtering, and sendPrompt streaming lifecycle', async () => {
  const host = new MockHostServer({ port: 0, pairingKey: 'REAL98', realHostProtocol: true });
  await host.start();
  try {
    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: 'REAL98', deviceName: 'RealSchemaProbe', platform: 'android' }),
    }).then(r => r.json());
    const auth = { Authorization: `Bearer ${pairRes.token}`, 'Content-Type': 'application/json' };

    // 1. AgentSummary & slim avatars (no harness: 'temporal', awaitingUserResponse: null, createdAt/updatedAt)
    host.agents[0].avatarDataUrl = 'data:image/png;base64,AAAA';
    const agents = await fetch(`${host.origin}/api/listAgents`, {
      method: 'POST',
      headers: { ...auth, 'x-sand-slim-avatars': '1' },
      body: '{}',
    }).then(r => r.json());
    assert.ok(Array.isArray(agents) && agents.length >= 2);
    const defAgent = agents.find(a => a.id === 'agent-default');
    assert.ok(defAgent);
    assert.equal(defAgent.harness, undefined, 'Must NOT include harness: temporal');
    assert.equal(typeof defAgent.createdAt, 'number');
    assert.equal(typeof defAgent.updatedAt, 'number');
    assert.equal(defAgent.avatarDataUrl, null, 'Slim avatar header/mode must strip inline avatarDataUrl');
    assert.equal(defAgent.awaitingUserResponse, null, 'awaitingUserResponse must be null when idle');
    assert.equal(defAgent.isComposingMessage, false);
    assert.equal(defAgent.hasUnread, false);
    assert.equal(defAgent.unreadCount, 0);
    assert.equal(defAgent.origin, 'user');
    assert.equal(defAgent.isGroup, false);
    assert.deepEqual(defAgent.memberIds, []);
    assert.equal(defAgent.notifyOnUpdatesEnabled, true);
    assert.equal(defAgent.isHiddenFromSidebar, false);

    // Also verify updateAgent updates updatedAt
    const prevUpdatedAt = defAgent.updatedAt;
    const updRes = await fetch(`${host.origin}/api/updateAgent`, {
      method: 'POST',
      headers: { ...auth, 'x-sand-slim-avatars': '1' },
      body: JSON.stringify({ id: 'agent-default', profile: { title: 'Updated Title' } }),
    }).then(r => r.json());
    assert.ok(updRes.updatedAt >= prevUpdatedAt);
    assert.equal(updRes.avatarDataUrl, null);

    // 2. getTrays, dismissTray, clearTrays, getAsyncTasks
    host.trays.push({ kind: 'error', id: 'tray-1', agentId: 'agent-default', title: 'Test Tray' });
    const trays1 = await fetch(`${host.origin}/api/getTrays`, { method: 'POST', headers: auth, body: '{}' }).then(r => r.json());
    assert.ok(Array.isArray(trays1) && trays1.length === 1 && trays1[0].id === 'tray-1');

    const dismissRes = await fetch(`${host.origin}/api/dismissTray`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'tray-1' }),
    });
    assert.equal(dismissRes.status, 200);
    assert.ok(dismissRes.headers.get('content-type')?.includes('application/json'));
    const dismissText = await dismissRes.text();
    assert.equal(dismissText, 'null');
    assert.equal(JSON.parse(dismissText), null);

    const clearRes = await fetch(`${host.origin}/api/clearTrays`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(clearRes.status, 200);
    assert.equal(await clearRes.text(), 'null');

    const trays2 = await fetch(`${host.origin}/api/getTrays`, { method: 'POST', headers: auth, body: '{}' }).then(r => r.json());
    assert.deepEqual(trays2, []);

    const tasks = await fetch(`${host.origin}/api/getAsyncTasks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default' }),
    }).then(r => r.json());
    assert.deepEqual(tasks, []);

    // 3. Flat openAgentWindowed & getAgentTranscriptWindow + pagination + empty agent
    const fullWin = await fetch(`${host.origin}/api/openAgentWindowed`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default', limit: 50 }),
    }).then(r => r.json());
    assert.equal(fullWin.window, undefined, 'Must NOT wrap in { window: ... }');
    assert.equal(fullWin.cloudAgentPeerIds, undefined, 'Must omit cloudAgentPeerIds');
    assert.equal('nextBeforeSeq' in fullWin, false, 'Must omit nextBeforeSeq when !hasMore');
    assert.deepEqual(fullWin.threadCounts, {});
    assert.equal(fullWin.entries.length, 2);
    assert.equal(fullWin.entries[0].kind, 'message');
    assert.equal(fullWin.entries[0].role, 'user');
    assert.equal(fullWin.entries[0].isStreaming, false);
    assert.equal(fullWin.entries[1].kind, 'send-message');
    assert.equal(fullWin.entries[1].streaming, false);
    assert.equal(fullWin.entries[1].message?.type, 'text');

    const page1 = await fetch(`${host.origin}/api/getAgentTranscriptWindow`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default', limit: 1 }),
    }).then(r => r.json());
    assert.equal(page1.entries.length, 1);
    assert.equal(page1.entries[0].id, 'entry-2');
    assert.equal(page1.nextBeforeSeq, 2);

    const page2 = await fetch(`${host.origin}/api/getAgentTranscriptWindow`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default', beforeSeq: page1.nextBeforeSeq, limit: 1 }),
    }).then(r => r.json());
    assert.equal(page2.entries.length, 1);
    assert.equal(page2.entries[0].id, 'entry-1');
    assert.equal('nextBeforeSeq' in page2, false);

    const emptyCreated = await fetch(`${host.origin}/api/createAgent`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'EmptyBot' }),
    }).then(r => r.json());
    const emptyWin = await fetch(`${host.origin}/api/openAgentWindowed`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: emptyCreated.agent.id, limit: 20 }),
    }).then(r => r.json());
    assert.deepEqual(emptyWin, { entries: [], threadCounts: {} });

    // 4. getHostStatus
    const hostStatus = await fetch(`${host.origin}/api/getHostStatus`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ includeManagedCapabilities: true }),
    }).then(r => r.json());
    assert.equal(hostStatus.hostVersion, 'mock-1.0.0');
    assert.equal(hostStatus.latestHostVersion, 'mock-1.0.0');
    assert.equal(hostStatus.hostUpdateAvailable, false);
    assert.equal(hostStatus.isBusy, true); // agent-coding starts with isRunning: true
    assert.deepEqual(hostStatus.capabilities, ['orderedReplicasV1', 'sendAcceptanceV1']);

    // 5. ForeverBox windows shape
    const box = await fetch(`${host.origin}/api/ensureForeverBox`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default' }),
    }).then(r => r.json());
    assert.equal(box.imageUpdateAvailable, false);
    assert.equal(box.hostVersion, 'mock-1.0.0');
    assert.equal(box.hostUpdateAvailable, false);
    assert.equal(box.handoff, null);
    assert.deepEqual(box.windows, [{ windowIndex: 0, vncUrl: box.vncUrl }]);

    // 6. SSE ?channels= filtering, retry: 1000, box-disk-pressure, host-settings { fields }, and sendPrompt streaming
    const acFiltered = new AbortController();
    const sseFiltered = await fetch(`${host.origin}/events?channels=transcript,host-settings`, {
      headers: { Authorization: `Bearer ${pairRes.token}`, Accept: 'text/event-stream', 'x-sand-slim-avatars': '1' },
      signal: acFiltered.signal,
    });
    const acAll = new AbortController();
    const sseAll = await fetch(`${host.origin}/events`, {
      headers: { Authorization: `Bearer ${pairRes.token}`, Accept: 'text/event-stream', 'x-sand-slim-avatars': '1' },
      signal: acAll.signal,
    });

    const filteredReader = sseFiltered.body.getReader();
    const allReader = sseAll.body.getReader();

    // Verify default hostSettings + setHostSettings persistence + empty/invalid no-op (no crashy empty host-settings SSE)
    const defaultSettings = await fetch(`${host.origin}/api/getHostSettings`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    }).then(r => r.json());
    assert.deepEqual(defaultSettings.notifications, { isEnabled: false });
    assert.equal(defaultSettings.autoReviewInstructions?.isEnabled, true);
    assert.equal(defaultSettings.localToolPermission, 'ask');
    assert.equal(defaultSettings.webauthnProxyEnabled, true);
    assert.deepEqual(defaultSettings.sidebarSections, []);

    // Empty and invalid updates must NOT broadcast empty host-settings
    await fetch(`${host.origin}/api/setHostSettings`, { method: 'POST', headers: auth, body: '{}' });
    await fetch(`${host.origin}/api/setHostSettings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ userTimeZone: 'Invalid/Zone_Name' }),
    });
    const updatedSettings = await fetch(`${host.origin}/api/setHostSettings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        userTimeZone: 'America/Los_Angeles',
        osLocale: 'en-US',
        selectedTeam: { teamId: 42, accountScope: 'acct-demo' },
        pinnedAgentIds: ['agent-default', 'agent-coding', 'agent-default', ''],
      }),
    }).then(r => r.json());
    assert.equal(updatedSettings.userTimeZone, 'America/Los_Angeles');
    assert.equal(updatedSettings.osLocale, 'en-US');
    assert.equal(updatedSettings.selectedTeamId, 42);
    assert.deepEqual(updatedSettings.pinnedAgentIds, ['agent-default', 'agent-coding']);

    // sendPrompt returns exact { accepted: true } and streams appended(streaming:true) -> updated(streaming:true) -> updated(streaming:false) + full agent-upserted
    const sendRes = await fetch(`${host.origin}/api/sendPrompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: crypto.randomUUID(),
        prompt: 'Stream lifecycle test',
      }),
    }).then(r => r.json());
    assert.deepEqual(sendRes, { accepted: true });

    // interruptAgentRun broadcasts full AgentSummary in agent-upserted
    await fetch(`${host.origin}/api/interruptAgentRun`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-coding' }),
    });

    const hostStatusAfterInterrupt = await fetch(`${host.origin}/api/getHostStatus`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    }).then(r => r.json());
    assert.equal(hostStatusAfterInterrupt.isBusy, false);

    // Read both SSE streams until all expected markers arrive
    const readUntil = async (reader, checkDone) => {
      let raw = '';
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !checkDone(raw)) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += Buffer.from(value).toString('utf-8');
      }
      return raw;
    };

    const [filteredRaw, allRaw] = await Promise.all([
      readUntil(filteredReader, raw => raw.includes('"streaming":false') && raw.includes('"host-settings"')),
      readUntil(allReader, raw => raw.includes('"id":"agent-coding"') && raw.includes('"streaming":false')),
    ]);
    acFiltered.abort();
    acAll.abort();

    assert.ok(filteredRaw.startsWith('retry: 1000\n\n'), 'realHostProtocol SSE must start with retry: 1000');
    assert.equal(filteredRaw.includes('coordinator-transport-state'), false);
    assert.equal(filteredRaw.includes('transport-connected'), false);
    assert.equal(filteredRaw.includes('box-disk-pressure'), false, 'Filtered ?channels=transcript,host-settings must exclude box-disk-pressure');
    assert.equal(filteredRaw.includes('"channel":"agent-upserted"'), false, 'Filtered stream must exclude agent-upserted');

    const parseSseData = raw =>
      raw
        .split('\n\n')
        .flatMap(block => block.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))));

    const filteredEvents = parseSseData(filteredRaw);
    const settingsEvents = filteredEvents.filter(e => e.channel === 'host-settings');
    assert.equal(settingsEvents.length, 1, 'Only valid non-empty setHostSettings must emit host-settings');
    assert.ok(Array.isArray(settingsEvents[0].payload.fields));
    assert.ok(settingsEvents[0].payload.fields.includes('userTimeZone'));
    assert.ok(settingsEvents[0].payload.fields.includes('osLocale'));
    assert.ok(settingsEvents[0].payload.fields.includes('selectedTeamId'));
    assert.equal(settingsEvents[0].payload.fields.includes('selectedTeam'), false);

    const transcriptEvents = filteredEvents.filter(e => e.channel === 'transcript');
    const replyEvents = transcriptEvents.filter(e => e.payload?.entry?.kind === 'send-message');
    assert.equal(replyEvents.length, 3, 'Expected appended(streaming:true) -> updated(streaming:true) -> updated(streaming:false)');
    assert.equal(replyEvents[0].payload.type, 'appended');
    assert.equal(replyEvents[0].payload.entry.streaming, true);
    assert.equal(replyEvents[1].payload.type, 'updated');
    assert.equal(replyEvents[1].payload.entry.streaming, true);
    assert.equal(replyEvents[2].payload.type, 'updated');
    assert.equal(replyEvents[2].payload.entry.streaming, false);

    const allEvents = parseSseData(allRaw);
    assert.equal(allEvents[0].channel, 'box-disk-pressure');
    assert.equal(allEvents[0].payload, null);
    const defaultUpserts = allEvents.filter(e => e.channel === 'agent-upserted' && e.payload?.agent?.id === 'agent-default');
    const defaultRunUpsert = defaultUpserts.find(e => e.payload?.agent?.isRunning === true);
    const defaultDoneUpsert = defaultUpserts.find(e => e.payload?.agent?.isRunning === false && e.payload?.agent?.lastMessageId != null);
    assert.ok(defaultRunUpsert, 'Expected running agent-upserted for agent-default during sendPrompt');
    assert.deepEqual(defaultRunUpsert.payload.agent.lastEntry, { kind: 'text', text: 'Stream lifecycle test' });
    assert.ok(defaultDoneUpsert, 'Expected completed agent-upserted for agent-default after sendPrompt');
    const expectedReplyText = 'Echo response to "Stream lifecycle test"';
    assert.deepEqual(defaultDoneUpsert.payload.agent.lastEntry, { kind: 'text', text: expectedReplyText });
    assert.notEqual(defaultDoneUpsert.payload.agent.lastEntry.kind, 'send-message');
    assert.equal(defaultDoneUpsert.payload.agent.lastMessagePreview, expectedReplyText);
    assert.equal(defaultDoneUpsert.payload.agent.lastMessagePreviewSource, null);
    assert.equal(defaultDoneUpsert.payload.agent.lastMessageAuthorId, null);
    assert.deepEqual(defaultDoneUpsert.payload.agent.pushMessageContent, {
      v: 1,
      predecessorMessageId: 'entry-2',
      message: {
        kind: 'send-message',
        id: defaultDoneUpsert.payload.agent.lastMessageId,
        message: { type: 'text', content: expectedReplyText },
        timestampMs: defaultDoneUpsert.payload.agent.lastActivityAt,
      },
    });
    assert.equal(defaultDoneUpsert.payload.agent.avatarDataUrl, null);

    const codingUpsert = allEvents.find(e => e.channel === 'agent-upserted' && e.payload?.agent?.id === 'agent-coding');
    assert.ok(codingUpsert, 'Expected interruptAgentRun agent-upserted for agent-coding');
    assert.equal(codingUpsert.payload.agent.isRunning, false);
    assert.equal(codingUpsert.payload.agent.awaitingUserResponse, null);
    assert.equal(codingUpsert.payload.agent.avatarDataUrl, null);
    assert.equal(typeof codingUpsert.payload.agent.updatedAt, 'number');

    // First sendPrompt on a fresh agent without predecessor send-message yields pushMessageContent: null,
    // and attachment-only sendPrompt yields valid lastEntry shapes without crashing AgentRow.
    const acFresh = new AbortController();
    const sseFresh = await fetch(`${host.origin}/events?channels=agent-upserted`, {
      headers: { Authorization: `Bearer ${pairRes.token}`, Accept: 'text/event-stream', 'x-sand-slim-avatars': '1' },
      signal: acFresh.signal,
    });
    const freshReader = sseFresh.body.getReader();
    await fetch(`${host.origin}/api/sendPrompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        agentId: emptyCreated.agent.id,
        clientNonce: crypto.randomUUID(),
        prompt: 'First reply',
      }),
    });
    await fetch(`${host.origin}/api/sendPrompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        agentId: emptyCreated.agent.id,
        clientNonce: crypto.randomUUID(),
        prompt: '',
        attachmentPaths: [`/data/runtime/host-data/agents/${emptyCreated.agent.id}/attachments/photo.png`],
        attachmentNames: ['photo.png'],
      }),
    });
    const freshRaw = await readUntil(
      freshReader,
      raw => raw.includes('Echo response to \\"\\"')
    );
    acFresh.abort();
    const freshEvents = parseSseData(freshRaw).filter(
      e => e.channel === 'agent-upserted' && e.payload?.agent?.id === emptyCreated.agent.id
    );
    const firstDone = freshEvents.find(e => e.payload.agent.lastMessagePreview === 'Echo response to "First reply"');
    assert.ok(firstDone, 'Expected completed agent-upserted for fresh agent');
    assert.deepEqual(firstDone.payload.agent.lastEntry, { kind: 'text', text: 'Echo response to "First reply"' });
    assert.equal(firstDone.payload.agent.lastMessagePreviewSource, null);
    assert.equal(firstDone.payload.agent.lastMessageAuthorId, null);
    assert.equal(firstDone.payload.agent.pushMessageContent, null);

    const attRunning = freshEvents.find(
      e => e.payload.agent.isRunning === true && e.payload.agent.lastEntry?.kind === 'attachment'
    );
    assert.ok(attRunning, 'Expected attachment lastEntry while attachment-only prompt is running');
    assert.deepEqual(attRunning.payload.agent.lastEntry, {
      kind: 'attachment',
      count: 1,
      kinds: [{ kind: 'image', count: 1 }],
    });
    assert.equal(
      host._classifyAttachmentKind('notes.txt', '/data/runtime/host-data/agents/bot.png/attachments/notes.txt'),
      'text',
      'fileName extension must take precedence over parent directory names in urlOrPath'
    );
    const attDone = freshEvents.find(e => e.payload.agent.lastMessagePreview === 'Echo response to ""');
    assert.ok(attDone, 'Expected completed agent-upserted after attachment-only prompt');
    assert.deepEqual(attDone.payload.agent.lastEntry, { kind: 'text', text: 'Echo response to ""' });
    assert.equal(attDone.payload.agent.lastMessagePreviewSource, null);
    assert.equal(attDone.payload.agent.lastMessageAuthorId, null);
    assert.equal(attDone.payload.agent.pushMessageContent?.v, 1);
    assert.equal(attDone.payload.agent.pushMessageContent?.predecessorMessageId, firstDone.payload.agent.lastMessageId);

    // 7. Verify openAgentWindowed >500 default limit=500 pagination + omitted clientNonce & whitespace no-op
    const bigId = 'agent-big-transcript';
    host.transcripts.set(
      bigId,
      Array.from({ length: 505 }, (_, i) => ({
        kind: 'message',
        id: `big-${i + 1}`,
        seq: i + 1,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${i + 1}`,
        isStreaming: false,
        timestampMs: 1731760000000 + i,
      }))
    );
    const defaultWin = await fetch(`${host.origin}/api/openAgentWindowed`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: bigId }),
    }).then(r => r.json());
    assert.equal(defaultWin.entries.length, 500, 'openAgentWindowed without explicit limit must default to 500');
    assert.equal(defaultWin.entries[0].seq, 6);
    assert.equal(defaultWin.nextBeforeSeq, 6);

    const noNonceRes = await fetch(`${host.origin}/api/sendPrompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 'agent-default', prompt: '   ' }),
    }).then(r => r.json());
    assert.deepEqual(noNonceRes, { accepted: true });
    assert.equal(
      host._getOrSeedTranscript('agent-default').some(e => e.role === 'user' && e.content === '   '),
      false,
      'Whitespace-only prompt without attachments must be a host no-op'
    );
  } finally {
    await host.stop();
  }
});

test('M5-EmulatorE2E: isBotsListReady rejects Chat Screen < Back / Retry banner spoofs and ErrorBoundary, accepts full Bots List, and ranks NotificationsRow HostView', () => {
  const mkDumpsys = (activity, viewLines) => [
    `  ACTIVITY ${activity} 1234abcd pid=999`,
    '    mResumed=true',
    '    View Hierarchy:',
    '      com.android.internal.policy.DecorView{1 V.E...... ........ 0,0-1080,2400}',
    ...viewLines.map(l => `        ${l}`),
  ].join('\n');

  // 1. Chat Screen with top-left < Back button, single top-right '...' (even with nested clickable child + lower Retry banner), and wide clickable bubble
  const chatTop = parseTopActivityOutput(mkDumpsys('dev.rokbot.local/.MainActivity', [
    'com.facebook.react.views.view.ReactViewGroup{10 VFE...C.. ........ 47,152-163,267}',
    'com.facebook.react.views.view.ReactViewGroup{11 VFE...C.. ........ 917,152-1033,267}',
    'com.facebook.react.views.view.ReactViewGroup{12 VFE...C.. ........ 925,160-1025,259}',
    'com.facebook.react.views.view.ReactViewGroup{14 VFE...C.. ........ 820,275-980,340}',
    'com.facebook.react.views.view.ReactViewGroup{13 VFE...C.. ........ 42,400-1038,600}',
  ]));
  assert.ok(findTopLeftCornerButton(chatTop.views), 'Chat top-left < Back button must be locatable');
  assert.equal(isBotsListReady(chatTop), false, 'Chat Screen must NEVER pass isBotsListReady even with wide bubble and lower Retry button');

  // 2. Bots List Screen with (D) avatar, Search + '+' top-right buttons, and bot rows
  const botsListTop = parseTopActivityOutput(mkDumpsys('dev.rokbot.local/.MainActivity', [
    'com.facebook.react.views.view.ReactViewGroup{20 VFE...C.. ........ 47,152-163,267}',
    'com.facebook.react.views.view.ReactViewGroup{21 VFE...C.. ........ 777,152-893,267}',
    'com.facebook.react.views.view.ReactViewGroup{22 VFE...C.. ........ 917,152-1033,267}',
    'com.facebook.react.views.view.ReactViewGroup{23 VFE...C.. ........ 42,320-1038,520}',
    'com.facebook.react.views.view.ReactViewGroup{24 VFE...C.. ........ 42,540-1038,740}',
  ]));
  assert.equal(isBotsListReady(botsListTop), true, 'Bots List with (D), >=2 top-right buttons, and bot rows must pass');
  assert.equal(findTopLeftCornerButton(botsListTop.views)?.rect.x1, 47);

  // 3. ErrorBoundary or non-MainActivity (e.g. NexusLauncherActivity) must return false
  const errTop = parseTopActivityOutput(mkDumpsys('dev.rokbot.local/.MainActivity', [
    'com.facebook.react.views.view.ReactViewGroup{30 VFE...C.. ........ 300,1900-780,2040}',
  ]));
  assert.equal(isBotsListReady(errTop), false, 'ErrorBoundary screen must return false');

  const launcherTop = parseTopActivityOutput(mkDumpsys('com.google.android.apps.nexuslauncher/.NexusLauncherActivity', [
    'android.widget.FrameLayout{40 VFE...C.. ........ 47,152-163,267}',
    'android.widget.FrameLayout{41 VFE...C.. ........ 777,152-893,267}',
    'android.widget.FrameLayout{42 VFE...C.. ........ 917,152-1033,267}',
    'android.widget.FrameLayout{43 VFE...C.. ........ 42,320-1038,520}',
  ]));
  assert.equal(isBotsListReady(launcherTop), false, 'NexusLauncherActivity must return false');

  // 4. SettingsSheet NotificationsRow HostView candidate ranking (single title labelCount===1 preferred over subtitle toggles)
  const settingsTop = parseTopActivityOutput(mkDumpsys('dev.rokbot.local/.MainActivity', [
    'com.facebook.react.views.text.f{50 V.ED..... ........ 92,1151-825,1209}',
    'com.facebook.react.views.text.f{51 V.ED..... ........ 92,1214-825,1310}',
    'expo.modules.ui.HostView{52 V.E...... ........ 852,1167-989,1293}',
    'com.facebook.react.views.text.f{53 V.ED..... ........ 92,1383-825,1441}',
    'com.facebook.react.views.text.f{54 V.ED..... ........ 92,1446-825,1542}',
    'expo.modules.ui.HostView{55 V.E...... ........ 852,1399-989,1525}',
    'com.facebook.react.views.text.f{56 V.ED..... ........ 92,1992-825,2050}',
    'expo.modules.ui.HostView{57 V.E...... ........ 852,1958-989,2084}',
  ]));
  const switchCands = findNotificationsHostSwitchCandidates(settingsTop);
  assert.equal(switchCands.length, 3);
  assert.equal(switchCands[0].labelCount, 1);
  assert.equal(switchCands[0].hv.cy, 2021);

  const unscrolledSettingsTop = parseTopActivityOutput(mkDumpsys('dev.rokbot.local/.MainActivity', [
    'com.facebook.react.views.text.f{60 V.ED..... ........ 92,1554-825,1612}',
    'com.facebook.react.views.text.f{61 V.ED..... ........ 92,1617-825,1713}',
    'expo.modules.ui.HostView{62 V.E...... ........ 852,1531-989,1657}',
    'com.facebook.react.views.text.f{63 V.ED..... ........ 92,2123-825,2181}',
    'expo.modules.ui.HostView{64 V.E...... ........ 852,2089-989,2215}',
  ]));
  const unscrolledCands = findNotificationsHostSwitchCandidates(unscrolledSettingsTop);
  assert.equal(unscrolledCands.length, 2);
  assert.equal(unscrolledCands[0].labelCount, 1);
  assert.equal(unscrolledCands[0].hv.cy, 2152);
});

test('M5-Legacy-SlimAvatars-PerClient: in realHostProtocol=false mode, SSE & HTTP strip avatarDataUrl only for clients/requests with x-sand-slim-avatars: 1', async () => {
  const host = new MockHostServer({ port: 0, pairingKey: 'SLM992', realHostProtocol: false });
  await host.start();
  try {
    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: 'SLM992', deviceName: 'SlimProbe', platform: 'android' }),
    }).then(r => r.json());
    const auth = { Authorization: `Bearer ${pairRes.token}`, 'Content-Type': 'application/json' };
    host.agents[0].avatarDataUrl = 'data:image/png;base64,BBBB';

    // HTTP check: full vs x-sand-slim-avatars: 1
    const fullList = await fetch(`${host.origin}/api/listAgents`, { method: 'POST', headers: auth, body: '{}' }).then(r => r.json());
    assert.equal(fullList.find(a => a.id === 'agent-default')?.avatarDataUrl, 'data:image/png;base64,BBBB');
    const slimList = await fetch(`${host.origin}/api/listAgents`, {
      method: 'POST',
      headers: { ...auth, 'x-sand-slim-avatars': '1' },
      body: '{}',
    }).then(r => r.json());
    assert.equal(slimList.find(a => a.id === 'agent-default')?.avatarDataUrl, null);

    // Concurrent SSE clients: one non-slim, one slim
    const acFull = new AbortController();
    const acSlim = new AbortController();
    const sseFull = await fetch(`${host.origin}/events`, {
      headers: { Authorization: `Bearer ${pairRes.token}`, Accept: 'text/event-stream' },
      signal: acFull.signal,
    });
    const sseSlim = await fetch(`${host.origin}/events`, {
      headers: { Authorization: `Bearer ${pairRes.token}`, Accept: 'text/event-stream', 'x-sand-slim-avatars': '1' },
      signal: acSlim.signal,
    });

    await fetch(`${host.origin}/api/updateAgent`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default', profile: { title: 'KeepAvatar' } }),
    });

    const readEvent = async (reader, needle) => {
      let raw = '';
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !raw.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += Buffer.from(value).toString('utf-8');
      }
      return raw;
    };
    const [rawFull, rawSlim] = await Promise.all([
      readEvent(sseFull.body.getReader(), 'KeepAvatar'),
      readEvent(sseSlim.body.getReader(), 'KeepAvatar'),
    ]);
    acFull.abort();
    acSlim.abort();

    const parseData = raw =>
      raw.split('\n\n').flatMap(b => b.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))));
    const fullUpsert = parseData(rawFull).find(e => e.channel === 'agent-upserted');
    const slimUpsert = parseData(rawSlim).find(e => e.channel === 'agent-upserted');
    assert.equal(fullUpsert?.payload?.agent?.avatarDataUrl, 'data:image/png;base64,BBBB');
    assert.equal(slimUpsert?.payload?.agent?.avatarDataUrl, null);
  } finally {
    await host.stop();
  }
});

test('R2-Patcher: injects 16KB-aligned Tailcat arm64-v8a libs, supports --package-name renaming, and registers iOS-parity modals + ComputerViewer/ShareTarget', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-r2-pkg-'));
  const tmpOut = path.join(tmpDir, 'custom-pkg.apk');
  const tmpKeystore = path.join(tmpDir, 'signing.json');

  try {
    const report = await runPatchPipeline({
      inputApk: BASE_TARGET_APK,
      outputApk: tmpOut,
      packageName: 'dev.rokbot.customapp',
      host: 'tailcat://connect/tcABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef?port=8000',
      pairingCode: 'K7M9P2',
      keystore: tmpKeystore,
      devSigning: true,
      force: true,
    });

    assert.equal(report.packageName, 'dev.rokbot.customapp');
    assert.equal(report.originalPackageName, 'ai.x.grok.bot');
    assert.deepEqual(report.tailcatLibsInjected, [
      'lib/arm64-v8a/libgroktailcat.so',
      'lib/arm64-v8a/libgroktailcatjni.so',
    ]);

    const apkBytes = fs.readFileSync(tmpOut);
    const outZip = readZip(apkBytes);
    for (const soPath of report.tailcatLibsInjected) {
      const entry = outZip.entries.find(e => e.name === soPath);
      assert.ok(entry, `${soPath} must exist in patched APK`);
      assert.equal(entry.method, 0, `${soPath} must be STORED uncompressed`);
      assert.equal(entry.dataStart % 16384, 0, `${soPath} must be 16KB aligned (offset ${entry.dataStart})`);
    }

    const manifestAst = parseAxml(entryBytes(outZip.entries.find(e => e.name === 'AndroidManifest.xml')));
    const rootNode = manifestAst.rootNodes.find(n => n.name === 'manifest');
    const pkgAttr = rootNode.attributes.find(a => a.name === 'package');
    assert.equal(pkgAttr.value, 'dev.rokbot.customapp');

    const appNode = rootNode.children.find(n => n.name === 'application');
    const providerNames = appNode.children
      .filter(c => c.name === 'provider')
      .map(c => getAndroidAttr(c, 'authorities')?.value);
    assert.ok(providerNames.includes('dev.rokbot.customapp.rokbot.init'));

    const activityNames = new Set(
      appNode.children
        .filter(c => c.name === 'activity')
        .map(c => getAndroidAttr(c, 'name')?.value)
    );
    assert.ok(activityNames.has('ai.x.grok.bot.MainActivity'), 'Relative/original MainActivity must be expanded to original package');
    assert.equal(activityNames.has('dev.rokbot.nativeapp.BotListActivity'), false);
    assert.equal(activityNames.has('dev.rokbot.nativeapp.ChatActivity'), false);
    assert.equal(activityNames.has('dev.rokbot.nativeapp.VoiceCallActivity'), false);
    assert.equal(activityNames.has('dev.rokbot.nativeapp.ConnectorsActivity'), false);
    assert.ok(activityNames.has('dev.rokbot.nativeapp.ComputerViewerActivity'));
    assert.ok(activityNames.has('dev.rokbot.nativeapp.ShareTargetActivity'));

    const shareAct = appNode.children.find(
      c => c.name === 'activity' && getAndroidAttr(c, 'name')?.value === 'dev.rokbot.nativeapp.ShareTargetActivity'
    );
    assert.equal(getAndroidAttr(shareAct, 'exported')?.value, true);

    const verified = verifyApk(apkBytes);
    assert.equal(verified.verified, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R2-MockHost: supports createAgent, updateAgent, deleteAgents, getHostSettings/setHostSettings, readAttachmentChunk, foreverBox, mobile-rpc, app-intents, skill workflows', async () => {
  const host = new MockHostServer({ port: 0, pairingKey: 'R2TEST', realHostProtocol: true });
  await host.start();
  try {
    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: 'R2TEST', deviceName: 'R2Device', platform: 'android' }),
    }).then(r => r.json());
    const auth = { Authorization: `Bearer ${pairRes.token}`, 'Content-Type': 'application/json' };

    // TranscribeAudio host endpoint requires audioBase64 in realHostProtocol
    const badStt = await fetch(`${host.origin}/local/audio/transcriptions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ audio: 'UklGRg==' }),
    });
    assert.equal(badStt.status, 400);
    const okStt = await fetch(`${host.origin}/local/audio/transcriptions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ audioBase64: 'UklGRg==', mimeType: 'audio/wav' }),
    });
    assert.equal(okStt.status, 200);

    // Create / Update / Pin / Delete Bot
    const badCreate = await fetch(`${host.origin}/api/createAgent`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ profile: { name: 'WrongShape' } }),
    });
    assert.equal(badCreate.status, 400);

    const created = await fetch(`${host.origin}/api/createAgent`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'R2 Bot', title: 'QA Bot' }),
    }).then(r => r.json());
    const newId = created.agent.id;
    assert.equal(created.agent.name, 'R2 Bot');

    const updated = await fetch(`${host.origin}/api/updateAgent`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: newId, profile: { name: 'R2 Bot Renamed', title: 'Updated' } }),
    }).then(r => r.json());
    assert.equal(updated.name, 'R2 Bot Renamed');

    await fetch(`${host.origin}/api/setHostSettings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ pinnedAgentIds: [newId] }),
    });
    const settings = await fetch(`${host.origin}/api/getHostSettings`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    }).then(r => r.json());
    assert.deepEqual(settings.pinnedAgentIds, [newId]);

    // Non-image chunked attachment readback (/api/readAttachmentChunk)
    const docBytes = Buffer.from('Hello non-image text file!');
    const upDoc = await fetch(`${host.origin}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        agentId: newId,
        uploadId: crypto.randomUUID(),
        filename: 'report.txt',
        offset: 0,
        totalSize: docBytes.length,
        bytesBase64: docBytes.toString('base64'),
      }),
    }).then(r => r.json());

    const chunk = await fetch(`${host.origin}/api/readAttachmentChunk`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: newId, path: upDoc.committedPath, offset: 0, length: 65536 }),
    }).then(r => r.json());
    assert.equal(Buffer.from(chunk.bytesBase64, 'base64').toString('utf8'), 'Hello non-image text file!');

    // ForeverBox + Mobile RPC + App Intents + Workflows
    const box = await fetch(`${host.origin}/api/getForeverBoxStatus`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: newId }),
    }).then(r => r.json());
    assert.ok(box.vncUrl.includes('/vnc/desktop/vnc.html'));

    const plugins = await fetch(`${host.origin}/local/mobile-rpc/ListMarketplacePlugins`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    }).then(r => r.json());
    assert.ok(Array.isArray(plugins.plugins) && plugins.plugins.length >= 1);

    const intentAgents = await fetch(`${host.origin}/local/app-intents/ListGrokBotAgents`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    }).then(r => r.json());
    assert.ok(Array.isArray(intentAgents.agents));

    await fetch(`${host.origin}/api/deleteAgents`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ids: [newId] }),
    });
    const listAfter = await fetch(`${host.origin}/api/listAgents`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    }).then(r => r.json());
    assert.equal(listAfter.some(a => a.id === newId), false);
  } finally {
    await host.stop();
  }
});

test('R2-Bytepatch: verifies pinned .gbp.gz recipes and executes bytepatch-unpaired + bytepatch-hbc-synthesized when SHA-256 matches', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(NATIVE_ROOT, 'recipes/manifest.json'), 'utf8'));
  const realMeta = loadGatewayTemplateMetadata();
  assert.equal(realMeta.originalSha256, manifest.hbcSha256);
  for (const res of manifest.resources) {
    const recipe = loadBytepatchRecipe(path.join(NATIVE_ROOT, 'recipes', res.patch));
    assert.equal(recipe.schema, 'rokbot-bytepatch/v1');
    assert.equal(recipe.sourceSha256, realMeta.originalSha256);
    assert.ok(Array.isArray(recipe.ops) && recipe.ops.length > 0);
  }
  const legacyMeta = loadGatewayTemplateMetadata(path.join(NATIVE_ROOT, 'recipes/gateway-template.json'));
  for (const name of ['unpaired.hbc.gbp.gz', 'gateway-template.hbc.gbp.gz', 'gateway-template.json.gbp.gz']) {
    const recipe = loadBytepatchRecipe(path.join(NATIVE_ROOT, 'recipes', name));
    assert.equal(recipe.schema, 'rokbot-bytepatch/v1');
    assert.equal(recipe.sourceSha256, legacyMeta.originalSha256);
    assert.ok(Array.isArray(recipe.ops) && recipe.ops.length > 0);
  }

  // Exercise full bytepatch synthesis on a pinned synthetic bundle matching meta.originalSha256
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-bytepatch-'));
  try {
    const origBuf = Buffer.alloc(1024, 0x11);
    const origSha = crypto.createHash('sha256').update(origBuf).digest('hex');

    const unpairedTarget = Buffer.from(origBuf);
    unpairedTarget.write('UNPAIRED', 64, 'ascii');
    const tplHbcTarget = Buffer.alloc(1024, 0x22);
    const smallMeta = {
      originalSha256: origSha,
      opcodes: realMeta.opcodes,
      strings: realMeta.strings,
      emptyString: realMeta.emptyString,
      urlKey: realMeta.urlKey,
      tokenKey: realMeta.tokenKey,
      bodyOffset: 64,
      bodyCapacity: 700,
      bodyLengthOffset: 900,
    };
    const tplJsonBuf = Buffer.from(JSON.stringify(smallMeta));

    const writeGbp = (targetBuf, fileName) => {
      const recipe = {
        schema: 'rokbot-bytepatch/v1',
        sourceSha256: origSha,
        sourceBytes: origBuf.length,
        targetSha256: crypto.createHash('sha256').update(targetBuf).digest('hex'),
        targetBytes: targetBuf.length,
        ops: [['add', targetBuf.toString('base64')]],
      };
      fs.writeFileSync(path.join(tmpDir, fileName), gzipSync(Buffer.from(JSON.stringify(recipe))));
    };
    writeGbp(unpairedTarget, 'unpaired.hbc.gbp.gz');
    writeGbp(tplHbcTarget, 'gateway-template.hbc.gbp.gz');
    writeGbp(tplJsonBuf, 'gateway-template.json.gbp.gz');

    const unpairedRes = patchHermesBundleSafely(origBuf, { meta: smallMeta, recipesDir: tmpDir });
    assert.equal(unpairedRes.patched, true);
    assert.equal(unpairedRes.bytepatchApplied, true);
    assert.equal(unpairedRes.mode, 'bytepatch-unpaired');
    assert.ok(unpairedRes.buffer.equals(unpairedTarget));
    assert.ok(unpairedRes.gatewayTemplateHbc.equals(tplHbcTarget));

    const pairedRes = patchHermesBundleSafely(origBuf, {
      host: 'http://127.0.0.1:18080',
      pairingCode: 'K7M9P2',
      meta: smallMeta,
      recipesDir: tmpDir,
    });
    assert.equal(pairedRes.patched, true);
    assert.equal(pairedRes.bytepatchApplied, true);
    assert.equal(pairedRes.mode, 'bytepatch-hbc-synthesized');
    const expectedSha1 = crypto.createHash('sha1').update(pairedRes.buffer.subarray(0, pairedRes.buffer.length - 20)).digest();
    assert.ok(pairedRes.buffer.subarray(pairedRes.buffer.length - 20).equals(expectedSha1), 'Footer SHA-1 must match synthesized bytecode');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R2-Review: co.anysphere.sand.MainApplication auto-selects RokBotSandApplication & honors --package-name', async () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')) && fs.existsSync(path.join(d, 'build-tools/36.0.0/d8')));
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => {
      try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; }
    });
  assert.ok(sdkRoot && javacBin, 'Android SDK build-tools and javac required for DEX Sand test');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-sand-test-'));
  try {
    const stubsDir = path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java');
    const stubClasses = path.join(tmpDir, 'classes');
    const sandDexDir = path.join(tmpDir, 'dex');
    fs.mkdirSync(stubClasses, { recursive: true });
    fs.mkdirSync(sandDexDir, { recursive: true });

    const stubFiles = [
      path.join(stubsDir, 'com/facebook/react/ReactPackage.java'),
      path.join(stubsDir, 'com/facebook/react/ReactNativeHost.java'),
      path.join(stubsDir, 'com/facebook/react/ReactApplication.java'),
      path.join(stubsDir, 'co/anysphere/sand/MainApplication.java'),
    ];
    cp.execFileSync(javacBin, [
      '--release', '17', '-encoding', 'UTF-8',
      '-cp', path.join(sdkRoot, 'platforms/android-36/android.jar'),
      '-d', stubClasses,
      ...stubFiles,
    ]);

    const classFiles = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.class')) classFiles.push(full);
      }
    };
    walk(stubClasses);

    cp.execFileSync(path.join(sdkRoot, 'build-tools/36.0.0/d8'), ['--min-api', '26', '--output', sandDexDir, ...classFiles]);

    const baseZip = readZip(fs.readFileSync(BASE_TARGET_APK));
    const sandAxml = entryBytes(baseZip.entries.find(e => e.name === 'AndroidManifest.xml'));
    const updatedEntries = baseZip.entries.map(e => {
      if (e.name === 'classes.dex') return createEntry('classes.dex', fs.readFileSync(path.join(sandDexDir, 'classes.dex')));
      if (e.name === 'AndroidManifest.xml') return createEntry('AndroidManifest.xml', sandAxml, { store: true });
      return e;
    });
    const sandInputApk = path.join(tmpDir, 'sand-input.apk');
    const sandOutApk = path.join(tmpDir, 'sand-out.apk');
    fs.writeFileSync(sandInputApk, writeZip(updatedEntries));

    const report = await runPatchPipeline({
      inputApk: sandInputApk,
      outputApk: sandOutApk,
      packageName: 'dev.rokbot.customsand',
      unsigned: true,
      force: true,
    });
    assert.equal(report.setApplicationName, true);
    assert.equal(report.packageName, 'dev.rokbot.customsand');

    const outZip = readZip(fs.readFileSync(sandOutApk));
    const outAxml = entryBytes(outZip.entries.find(e => e.name === 'AndroidManifest.xml'));
    const parsed = parseAxml(outAxml);
    const manifest = parsed.rootNodes.find(n => n.name === 'manifest');
    const app = manifest.children.find(n => n.name === 'application');
    assert.equal(getAndroidAttr(manifest, 'package')?.value || manifest.attributes.find(a => a.name === 'package')?.value, 'dev.rokbot.customsand');
    assert.equal(getAndroidAttr(app, 'name')?.value, 'dev.rokbot.nativeapp.RokBotSandApplication');

    const classes = outZip.entries.filter(e => e.name.endsWith('.dex')).map(e => e.name);
    assert.ok(classes.includes('classes2.dex'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R2-Review: JVM checks on NetworkInterceptor host/RPC gates and RokBotBootstrap label parity', () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => {
      try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; }
    });
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for JVM verification');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-jvm-verify-'));
  try {
    const outClasses = path.join(tmpDir, 'classes');
    fs.mkdirSync(outClasses, { recursive: true });
    const javaFiles = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.java')) javaFiles.push(full);
      }
    };
    walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
    walk(path.join(NATIVE_ROOT, 'companion/src/main/java'));

    const harnessJava = path.join(tmpDir, 'VerifyHarness.java');
    fs.writeFileSync(harnessJava, `
import dev.rokbot.nativeapp.*;

public class VerifyHarness {
    private static void check(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
    }
    public static void main(String[] args) {
        check(!NetworkInterceptor.isTargetCloudEndpoint("evil-grok.bot"), "reject prefix spoof");
        check(!NetworkInterceptor.isTargetCloudEndpoint("grok.bot.attacker.com"), "reject suffix spoof");
        check(NetworkInterceptor.isTargetCloudEndpoint("api.grok.bot."), "allow subdomain with trailing dot");
        check(NetworkInterceptor.isTargetCloudEndpoint("rokbot.local"), "allow grokbot.local");
        check(!NetworkInterceptor.isTelemetryHost("my-sentry.io.local"), "reject spoofed telemetry substring");
        check(NetworkInterceptor.isTelemetryHost("o123.ingest.sentry.io"), "block sentry subdomain");

        check("CompleteMcpOAuth".equals(NetworkInterceptor.getDashboardMethod("/aiserver.v1.DashboardService/CompleteMcpOAuth")), "allow CompleteMcpOAuth");
        check("UpdateUserPluginInstall".equals(GatewayEndpointRouter.getDashboardMethod("/aiserver.v1.DashboardService/UpdateUserPluginInstall")), "allow UpdateUserPluginInstall");
        check("GetTeamPluginPopularity".equals(GatewayEndpointRouter.getDashboardMethod("/aiserver.v1.DashboardService/GetTeamPluginPopularity")), "allow GetTeamPluginPopularity");
        check("/local/mobile-rpc/UpdateUserPluginInstall".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.DashboardService/UpdateUserPluginInstall")), "rewrite UpdateUserPluginInstall");
        check("/local/mobile-rpc/GetTeamPluginPopularity".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.DashboardService/GetTeamPluginPopularity")), "rewrite GetTeamPluginPopularity");
        check(GatewayEndpointRouter.getDashboardMethod("/aiserver.v1.DashboardService/GetGrokBotMcpToolPermissions") == null, "reject GetGrokBotMcpToolPermissions under DashboardService");
        check(GatewayEndpointRouter.getDashboardMethod("/aiserver.v1.DashboardService/DeleteAccount") == null, "reject non-allowlisted DashboardService RPC");
        check("/aiserver.v1.DashboardService/DeleteAccount".equals(NetworkInterceptor.rewriteRpcPath("/aiserver.v1.DashboardService/DeleteAccount")), "do not rewrite non-allowlisted DashboardService RPC");
        check("/local/mobile-rpc/ListMarketplacePlugins".equals(NetworkInterceptor.rewriteRpcPath("/aiserver.v1.DashboardService/ListMarketplacePlugins")), "rewrite allowlisted DashboardService RPC");
        check("GetGrokBotMcpToolPermissions".equals(GatewayEndpointRouter.getDashboardMethod("/aiserver.v1.GrokBotService/GetGrokBotMcpToolPermissions")), "allow GetGrokBotMcpToolPermissions under GrokBotService");
        check("SetGrokBotMcpToolPermissions".equals(GatewayEndpointRouter.getDashboardMethod("/aiserver.v1.GrokBotService/SetGrokBotMcpToolPermissions")), "allow SetGrokBotMcpToolPermissions under GrokBotService");
        check("ListPublicGrokBotMarketplaceListings".equals(GatewayEndpointRouter.getDashboardMethod("/aiserver.v1.GrokBotService/ListPublicGrokBotMarketplaceListings")), "allow ListPublicGrokBotMarketplaceListings under GrokBotService");
        check("/local/mobile-rpc/GetGrokBotMcpToolPermissions".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.GrokBotService/GetGrokBotMcpToolPermissions")), "rewrite GetGrokBotMcpToolPermissions to /local/mobile-rpc");
        check("/local/mobile-rpc/SetGrokBotMcpToolPermissions".equals(NetworkInterceptor.rewriteRpcPath("/aiserver.v1.GrokBotService/SetGrokBotMcpToolPermissions")), "rewrite SetGrokBotMcpToolPermissions via NetworkInterceptor");
        check("/local/mobile-rpc/ListPublicGrokBotMarketplaceListings".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.GrokBotService/ListPublicGrokBotMarketplaceListings")), "rewrite ListPublicGrokBotMarketplaceListings to /local/mobile-rpc");
        check("/local/app-intents/ListGrokBotAgents".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.GrokBotService/ListGrokBotAgents")), "rewrite ListGrokBotAgents to AppIntents");
        check("/local/app-intents/SendGrokBotUserMessage".equals(NetworkInterceptor.rewriteRpcPath("/aiserver.v1.GrokBotService/SendGrokBotUserMessage")), "rewrite AppIntents RPC");
        check("/local/app-intents/GetGrokBotSendStatus".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.GrokBotService/GetGrokBotSendStatus")), "rewrite GetGrokBotSendStatus to AppIntents");
        check("/aiserver.v1.GrokBotService/UnknownMethod".equals(GatewayEndpointRouter.rewriteRpcPath("/aiserver.v1.GrokBotService/UnknownMethod")), "do not rewrite unknown GrokBotService RPC");

        check(RokBotBootstrap.resolveNativeTargetForLabel("Log in or sign up") == PairingActivity.class, "Log in or sign up");
        check(RokBotBootstrap.resolveNativeTargetForLabel("登录或注册") == PairingActivity.class, "登录或注册");
        check(RokBotBootstrap.resolveNativeTargetForLabel("连接服务端") == PairingActivity.class, "连接服务端");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Host Connection") == PairingActivity.class, "Host Connection");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Profile") == ProfileActivity.class, "Profile");
        check(RokBotBootstrap.resolveNativeTargetForLabel("个人资料") == ProfileActivity.class, "个人资料");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Notifications") == PushSettingsActivity.class, "Notifications");
        check(RokBotBootstrap.resolveNativeTargetForLabel("通知") == PushSettingsActivity.class, "通知");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Library") == LibraryActivity.class, "Library");
        check(RokBotBootstrap.resolveNativeTargetForLabel("资料库") == LibraryActivity.class, "资料库");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Bot Computer") == ComputersActivity.class, "Bot Computer");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Bot 电脑") == ComputersActivity.class, "Bot 电脑");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Usage") == UsageActivity.class, "Usage");
        check(RokBotBootstrap.resolveNativeTargetForLabel("用量") == UsageActivity.class, "用量");
        check(RokBotBootstrap.resolveNativeTargetForLabel("模型配置") == ModelsActivity.class, "模型配置");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Model Settings") == ModelsActivity.class, "Model Settings");
        check(RokBotBootstrap.resolveNativeTargetForLabel("检查更新") == UpdateActivity.class, "检查更新");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Software Update") == UpdateActivity.class, "Software Update");
        check(RokBotBootstrap.resolveNativeTargetForLabel("应用更新") == UpdateActivity.class, "应用更新");
        check(RokBotBootstrap.resolveNativeTargetForLabel("App Updates") == UpdateActivity.class, "App Updates");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Bot 图标样式") == AvatarStyleActivity.class, "Bot 图标样式");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Bot Icon Style") == AvatarStyleActivity.class, "Bot Icon Style");
        check(RokBotBootstrap.resolveNativeTargetForLabel("数据迁移") == MigrateActivity.class, "数据迁移");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Data Migration") == MigrateActivity.class, "Data Migration");
        check(RokBotBootstrap.resolveNativeTargetForLabel("外观") == null, "official Appearance row stays in RN");
        check(RokBotBootstrap.resolveNativeTargetForLabel("语言") == null, "official Language row stays in RN");
        check(RokBotBootstrap.resolveNativeTargetForLabel("消息") == null, "Bots list stays in RN");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Bots") == null, "Bots stays in RN");
        check(RokBotBootstrap.resolveNativeTargetForLabel("连接器") == null, "Connectors stay in RN");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Connectors") == null, "Connectors stay in RN");
        NetworkInterceptor.setLastAgentId("agent-coding");
        check("agent-coding".equals(NetworkInterceptor.getLastAgentId()), "track last agentId");
        System.out.println("JVM_HARNESS_OK");
    }
}
`);
    cp.execFileSync(javacBin, [
      '--release', '17', '-encoding', 'UTF-8',
      '-cp', path.join(sdkRoot, 'platforms/android-36/android.jar'),
      '-d', outClasses,
      ...javaFiles,
      harnessJava,
    ]);
    const out = cp.execFileSync(javaBin, [
      '-cp', `${outClasses}:${path.join(sdkRoot, 'platforms/android-36/android.jar')}`,
      'VerifyHarness',
    ], { encoding: 'utf8' });
    assert.ok(out.includes('JVM_HARNESS_OK'), `Unexpected output: ${out}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R2-Review: MockHost publicUrl canonical mismatch & sizeBytes contract', async () => {
  const host = new MockHostServer({ realHostProtocol: true, publicUrl: 'http://127.0.0.1:19999' });
  await host.start();
  try {
    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: 'ABCDEF', deviceName: 'Test Phone', platform: 'android' }),
    }).then(r => r.json());
    assert.equal(pairRes.gatewayUrl, 'http://127.0.0.1:19999');
    assert.notEqual(new URL(pairRes.gatewayUrl).port, String(host.actualPort));

    const auth = { Authorization: `Bearer ${pairRes.token}`, 'Content-Type': 'application/json' };
    const voiceRes = await fetch(`${host.origin}/local/voice/session`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 'agent-default', audioProcessing: 'legacy' }),
    }).then(r => r.json());
    assert.equal(voiceRes.websocketUrl, 'ws://127.0.0.1:19999/local/voice/realtime');

    const boxRes = await fetch(`${host.origin}/api/getForeverBoxStatus`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'agent-default' }),
    }).then(r => r.json());
    assert.ok(boxRes.vncUrl.startsWith('http://127.0.0.1:19999/vnc/desktop/vnc.html'));

    const upRes = await fetch(`${host.origin}/local/files?agentId=agent-default`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        agentId: 'agent-default',
        fileName: 'hello.txt',
        contentType: 'text/plain',
        base64: Buffer.from('123456789012345678901').toString('base64'),
      }),
    });
    assert.equal(upRes.status, 200);
    const listRes = await fetch(`${host.origin}/local/files?agentId=agent-default`, {
      headers: { Authorization: `Bearer ${pairRes.token}` },
    }).then(r => r.json());
    assert.equal(listRes.files[0].sizeBytes, 21);
  } finally {
    await host.stop();
  }
});

test('CLI guard: --standalone fails closed while --verify-only validates package-name and APK metadata', async () => {
  const { runPatchPipeline } = await import('../release/patch-android.mjs');
  const targetApk = fs.existsSync(BASE_TARGET_APK) ? BASE_TARGET_APK : FIXTURE_APK;

  await assert.rejects(
    () => runPatchPipeline({
      standalone: true,
      verifyOnly: true,
      packageName: 'ai.x.grok.bot',
    }),
    /--standalone Windows WebView wrapper mode is removed/
  );

  await assert.rejects(
    () => runPatchPipeline({
      inputApk: targetApk,
      verifyOnly: true,
      packageName: 'not a valid package!',
    }),
    /valid Android applicationId/
  );

  const report = await runPatchPipeline({
    inputApk: targetApk,
    verifyOnly: true,
    packageName: 'ai.x.grok.bot',
  });
  assert.equal(report.verified, true);
  assert.ok(/^[0-9a-f]{64}$/.test(report.inputSha256), 'verifyOnly must return SHA-256 of input');
  assert.ok(report.entryCount > 0);
  assert.equal(report.targetPinnedPackage, 'ai.x.grok.bot');
  assert.equal(typeof report.pairipDetected, 'boolean');
  assert.ok(Array.isArray(report.pairipMarkers));
});

test('Pairip detection, libpairipcore.so stripping, and incomplete split XAPK fail-closed guards', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-pairip-guard-'));
  try {
    const baseZip = readZip(fs.readFileSync(fs.existsSync(BASE_TARGET_APK) ? BASE_TARGET_APK : FIXTURE_APK));
    const manifestEntry = baseZip.entries.find(e => e.name === 'AndroidManifest.xml');
    const primaryDexEntry = baseZip.entries.find(e => e.name === 'classes.dex');

    // 1. APK with Pairip DEX markers reports pairipDetected + exact class markers in --verify-only
    const dexPairipPath = path.join(tmpDir, 'pairip-dex.apk');
    const fakePairipDex = Buffer.concat([
      Buffer.from('dex\n039\0'),
      Buffer.from('Lcom/pairip/SignatureCheck;\0Lcom/pairip/VMRunner;\0Lcom/pairip/application/Application;\0Lcom/pairip/licensecheck/LicenseClient;\0')
    ]);
    fs.writeFileSync(dexPairipPath, writeZip([
      createEntry('AndroidManifest.xml', entryBytes(manifestEntry), { store: true }),
      createEntry('classes.dex', fakePairipDex, { store: false }),
    ]));

    const dexVerify = await runPatchPipeline({ inputApk: dexPairipPath, verifyOnly: true });
    assert.equal(dexVerify.verified, true);
    assert.equal(dexVerify.pairipDetected, true);
    for (const marker of [
      'com.pairip.SignatureCheck',
      'com.pairip.VMRunner',
      'com.pairip.application.Application',
      'com.pairip.licensecheck.LicenseClient',
    ]) {
      assert.ok(dexVerify.pairipMarkers.includes(marker), `Missing Pairip marker ${marker}`);
    }

    // 2. APK with native libpairipcore.so reports marker in --verify-only and strips .so during patch
    const nativePairipPath = path.join(tmpDir, 'pairip-so.apk');
    const outPath = path.join(tmpDir, 'out-patched.apk');
    fs.writeFileSync(nativePairipPath, writeZip([
      createEntry('AndroidManifest.xml', entryBytes(manifestEntry), { store: true }),
      createEntry('classes.dex', entryBytes(primaryDexEntry), { store: false }),
      createEntry('lib/arm64-v8a/libpairipcore.so', Buffer.from('\x7fELFmock'), { store: true }),
    ]));

    const soVerify = await runPatchPipeline({ inputApk: nativePairipPath, verifyOnly: true });
    assert.equal(soVerify.verified, true);
    assert.equal(soVerify.pairipDetected, true);
    assert.ok(soVerify.pairipMarkers.includes('libpairipcore.so'));

    const patchReport = await runPatchPipeline({ inputApk: nativePairipPath, outputApk: outPath, devSigning: true, force: true });
    assert.equal(patchReport.pairipDetected, true);
    assert.ok(fs.existsSync(outPath), 'Patched APK must be written when Pairip is cleanly stripped/neutralized');
    const outBytes = fs.readFileSync(outPath);
    assert.equal(verifyApk(outBytes).verified, true);
    const outZip = readZip(outBytes);
    assert.equal(
      outZip.entries.some(e => /(^|\/)libpairipcore\.so$/i.test(e.name)),
      false,
      'libpairipcore.so must be stripped from output APK'
    );

    // 3. Incomplete XAPK / split APK missing AndroidManifest.xml fails closed
    const badBaseSplit = writeZip([createEntry('classes.dex', entryBytes(primaryDexEntry), { store: false })]);
    const xapkPath = path.join(tmpDir, 'official-split.xapk');
    fs.writeFileSync(xapkPath, writeZip([
      createEntry('manifest.json', Buffer.from('{"package_name":"ai.x.grok.bot","split_apks":[{"file":"ai.x.grok.bot.apk"}]}')),
      createEntry('ai.x.grok.bot.apk', badBaseSplit),
    ]));
    await assert.rejects(
      () => runPatchPipeline({ inputApk: xapkPath, verifyOnly: true }),
      /does not contain AndroidManifest\.xml/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R3-Review: JVM verification of SSE cancellation, R8OkHttpHook Expo/FS wrapping, interceptor headers, UI guards & Fc.o.i vs Fc.o.j', async () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => {
      try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; }
    });
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for R3 JVM verification');
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');

  const sockets = new Set();
  const observedSseHeaders = [];
  const sseServer = http.createServer((req, res) => {
    sockets.add(req.socket);
    req.socket.on('close', () => sockets.delete(req.socket));
    if (req.url === '/notifications/events') {
      observedSseHeaders.push(req.headers);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      });
      res.write(': ping\n\n');
      res.write('id: evt-1\nevent: notification\ndata: {"line":1}\ndata: line2\n\n');
      // Deliberately hold TCP socket open until client cancels via Closeable.close()
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"expired"}');
  });
  await new Promise(resolve => sseServer.listen(0, '127.0.0.1', resolve));
  const { port: ssePort } = sseServer.address();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-r3-jvm-'));
  try {
    const outClasses = path.join(tmpDir, 'classes');
    const overrideSrc = path.join(tmpDir, 'override-src');
    const overrideClasses = path.join(tmpDir, 'override-classes');
    const testSrc = path.join(tmpDir, 'test-src');
    const testClasses = path.join(tmpDir, 'test-classes');
    for (const d of [outClasses, overrideSrc, overrideClasses, testSrc, testClasses]) {
      fs.mkdirSync(d, { recursive: true });
    }

    // 1. Compile real companion + compile-stubs strictly against android.jar
    const javaFiles = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.java')) javaFiles.push(full);
      }
    };
    walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
    walk(path.join(NATIVE_ROOT, 'companion/src/main/java'));
    cp.execFileSync(javacBin, [
      '--release', '17', '-encoding', 'UTF-8',
      '-cp', androidJar,
      '-d', outClasses,
      ...javaFiles,
    ]);

    // 2. Compile tiny runtime overrides (ahead of android.jar ONLY at java runtime)
    const writeOverride = (rel, code) => {
      const f = path.join(overrideSrc, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, code);
      return f;
    };
    const ovFiles = [
      writeOverride('android/util/Log.java', `package android.util;
public final class Log {
    public static int d(String t, String m) { return 0; }
    public static int i(String t, String m) { return 0; }
    public static int w(String t, String m) { return 0; }
    public static int w(String t, String m, Throwable tr) { return 0; }
    public static int e(String t, String m) { return 0; }
    public static int e(String t, String m, Throwable tr) { return 0; }
}`),
      writeOverride('android/util/Base64.java', `package android.util;
public final class Base64 {
    public static final int DEFAULT = 0;
    public static final int NO_WRAP = 2;
    public static String encodeToString(byte[] input, int flags) {
        return java.util.Base64.getEncoder().encodeToString(input);
    }
    public static byte[] decode(String str, int flags) {
        return java.util.Base64.getDecoder().decode(str);
    }
}`),
      writeOverride('android/net/Uri.java', `package android.net;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
public class Uri {
    private final String raw;
    private final URI uri;
    public Uri(String raw) {
        this.raw = raw != null ? raw : "";
        URI u = null;
        try { u = URI.create(this.raw); } catch (Throwable ignored) {}
        this.uri = u;
    }
    public static Uri parse(String s) { return new Uri(s); }
    public String getScheme() { return uri != null ? uri.getScheme() : null; }
    public String getHost() { return uri != null ? uri.getHost() : null; }
    public int getPort() { return uri != null ? uri.getPort() : -1; }
    public String getPath() { return uri != null ? uri.getPath() : null; }
    public String getQuery() { return uri != null ? uri.getQuery() : null; }
    public String getQueryParameter(String key) {
        if (key == null || uri == null || uri.getRawQuery() == null) return null;
        for (String kv : uri.getRawQuery().split("&")) {
            int eq = kv.indexOf('=');
            String k = URLDecoder.decode(eq >= 0 ? kv.substring(0, eq) : kv, StandardCharsets.UTF_8);
            if (key.equals(k)) {
                return eq >= 0 ? URLDecoder.decode(kv.substring(eq + 1), StandardCharsets.UTF_8) : "";
            }
        }
        return null;
    }
    @Override public String toString() { return raw; }
    public static final class Builder {
        private String scheme = "", authority = "", path = "", query = "";
        public Builder scheme(String s) { scheme = s != null ? s : ""; return this; }
        public Builder authority(String a) { authority = a != null ? a : ""; return this; }
        public Builder path(String p) { path = p != null ? p : ""; return this; }
        public Builder appendPath(String seg) {
            if (seg != null && !seg.isEmpty()) {
                path = (path.endsWith("/") ? path : path + "/") + seg;
            }
            return this;
        }
        public Builder appendQueryParameter(String k, String v) {
            String pair = k + "=" + (v != null ? v : "");
            query = query.isEmpty() ? pair : (query + "&" + pair);
            return this;
        }
        public Uri build() {
            return parse(scheme + "://" + authority + (path.startsWith("/") || path.isEmpty() ? path : "/" + path) + (query.isEmpty() ? "" : "?" + query));
        }
    }
}`),
      writeOverride('org/json/JSONArray.java', `package org.json;
import java.util.*;
public class JSONArray {
    private final List<Object> items = new ArrayList<>();
    public JSONArray() {}
    public JSONArray(Collection<?> c) { if (c != null) items.addAll(c); }
    public int length() { return items.size(); }
    public Object opt(int i) { return (i >= 0 && i < items.size()) ? items.get(i) : null; }
    public String optString(int i) { Object v = opt(i); return v == null ? "" : String.valueOf(v); }
    public JSONObject optJSONObject(int i) { Object v = opt(i); return v instanceof JSONObject ? (JSONObject) v : null; }
    public JSONArray put(Object v) { items.add(v); return this; }
    @Override public String toString() { return items.toString(); }
}`),
      writeOverride('org/json/JSONObject.java', `package org.json;
import java.util.*;
public class JSONObject {
    public static final Object NULL = new Object() { @Override public String toString() { return "null"; } };
    private final Map<String, Object> map = new LinkedHashMap<>();
    public JSONObject() {}
    public JSONObject(String json) {
        if (json == null) return;
        String s = json.trim();
        if (!s.startsWith("{") || !s.endsWith("}")) return;
        s = s.substring(1, s.length() - 1).trim();
        if (s.isEmpty()) return;
        int depth = 0; boolean inStr = false; char prev = 0;
        List<String> parts = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' && prev != '\\\\') inStr = !inStr;
            else if (!inStr) {
                if (c == '{' || c == '[') depth++;
                else if (c == '}' || c == ']') depth--;
                else if (c == ',' && depth == 0) { parts.add(s.substring(start, i)); start = i + 1; }
            }
            prev = c;
        }
        parts.add(s.substring(start));
        for (String p : parts) {
            int col = p.indexOf(':');
            if (col <= 0) continue;
            String k = unquote(p.substring(0, col).trim());
            String v = p.substring(col + 1).trim();
            if ("null".equals(v)) map.put(k, NULL);
            else if ("true".equals(v)) map.put(k, Boolean.TRUE);
            else if ("false".equals(v)) map.put(k, Boolean.FALSE);
            else if (v.startsWith("\\"")) map.put(k, unquote(v));
            else if (v.startsWith("{")) map.put(k, new JSONObject(v));
            else { try { map.put(k, Long.parseLong(v)); } catch (Exception e) { map.put(k, v); } }
        }
    }
    private static String unquote(String s) {
        if (s.startsWith("\\"") && s.endsWith("\\"") && s.length() >= 2) return s.substring(1, s.length() - 1);
        return s;
    }
    public boolean has(String k) { return map.containsKey(k); }
    public boolean isNull(String k) { return !map.containsKey(k) || map.get(k) == NULL; }
    public Object opt(String k) { return map.get(k); }
    public String optString(String k, String def) {
        Object v = map.get(k);
        return (v == null || v == NULL) ? def : String.valueOf(v);
    }
    public String getString(String k) { return optString(k, ""); }
    public boolean optBoolean(String k, boolean def) {
        Object v = map.get(k);
        return v instanceof Boolean ? (Boolean) v : def;
    }
    public JSONObject put(String k, Object v) { map.put(k, v == null ? NULL : v); return this; }
    public Object remove(String k) { return map.remove(k); }
    @Override public String toString() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(e.getKey()).append("\\":");
            Object v = e.getValue();
            if (v == NULL) sb.append("null");
            else if (v instanceof Boolean || v instanceof Number || v instanceof JSONObject || v instanceof JSONArray) sb.append(v);
            else sb.append('"').append(String.valueOf(v).replace("\\"", "\\\\\\"")).append('"');
        }
        return sb.append('}').toString();
    }
}`),
      writeOverride('oj/A.java', `package oj;
import java.util.*;
import java.util.concurrent.*;
public class A {
    public static final class Dispatcher {
        public ExecutorService d = Executors.newCachedThreadPool();
    }
    public static final class Pool {
        public int evictCount = 0;
        public void a() { evictCount++; }
    }
    public Dispatcher a = new Dispatcher();
    public Pool b = new Pool();
    public List<v> c = new ArrayList<>();
    public List<v> z() { return c; }
    public Pool n() { return b; }
    public a C() { return new a(c); }
    public static class a {
        private final List<v> list = new ArrayList<>();
        public a() {}
        public a(List<v> existing) { if (existing != null) list.addAll(existing); }
        public a a(v interceptor) { list.add(interceptor); return this; }
        public a b(v interceptor) { list.add(interceptor); return this; }
        public a f(long d, TimeUnit u) { return this; }
        public a P(long d, TimeUnit u) { return this; }
        public a Q(long d, TimeUnit u) { return this; }
        public a g(n cookieJar) { return this; }
        public A c() { A cli = new A(); cli.c.addAll(list); return cli; }
    }
}`),
      writeOverride('oj/u.java', `package oj;
import java.net.URI;
public class u {
    private final String raw;
    private final URI uri;
    public u() { this("http://localhost/"); }
    public u(String s) {
        this.raw = s;
        this.uri = URI.create(s);
    }
    public String c() { return uri.getRawPath() != null ? uri.getRawPath() : ""; }
    public String f() { return uri.getHost() != null ? uri.getHost() : ""; }
    public String q() { return uri.getScheme() != null ? uri.getScheme() : ""; }
    public boolean i() { return "https".equalsIgnoreCase(q()); }
    public static u l(String s) { return new u(s); }
    @Override public String toString() { return raw; }
}`),
      writeOverride('oj/C.java', `package oj;
import java.util.*;
public class C {
    public final u url;
    public final String method;
    public final Map<String, String> headers;
    public final D body;
    public C() { this(new u(), "GET", new LinkedHashMap<>(), null); }
    public C(u url, String method, Map<String, String> headers, D body) {
        this.url = url; this.method = method; this.headers = headers; this.body = body;
    }
    public u p() { return url; }
    public String l() { return method; }
    public t j() { return null; }
    public D a() { return body; }
    public a m() { return new a(url, method, headers, body); }
    public String h(String name) {
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }
    public static class a {
        private u url;
        private String method;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private D body;
        public a() { this(new u(), "GET", Collections.emptyMap(), null); }
        public a(u url, String method, Map<String, String> hdrs, D body) {
            this.url = url; this.method = method; this.body = body;
            if (hdrs != null) this.headers.putAll(hdrs);
        }
        public a l(String s) { this.url = u.l(s); return this; }
        public a g(String m, D b) { this.method = m; this.body = b; return this; }
        public a e(String name, String value) {
            headers.keySet().removeIf(k -> k.equalsIgnoreCase(name));
            headers.put(name, value);
            return this;
        }
        public a a(String name, String value) { return e(name, value); }
        public a i(String name) { headers.keySet().removeIf(k -> k.equalsIgnoreCase(name)); return this; }
        public C b() { return new C(url, method, new LinkedHashMap<>(headers), body); }
    }
}`),
      writeOverride('android/graphics/Rect.java', `package android.graphics;
public final class Rect {
    public int left;
    public int top;
    public int right;
    public int bottom;
    public Rect() {}
    public Rect(int left, int top, int right, int bottom) {
        this.left = left; this.top = top; this.right = right; this.bottom = bottom;
    }
    public int width() { return right - left; }
    public int height() { return bottom - top; }
    public int centerX() { return (left + right) >> 1; }
    public int centerY() { return (top + bottom) >> 1; }
    public boolean contains(int x, int y) {
        return left < right && top < bottom && x >= left && x < right && y >= top && y < bottom;
    }
}`),
      writeOverride('android/view/ViewParent.java', `package android.view;
public interface ViewParent {}`),
      writeOverride('android/view/View.java', `package android.view;
import android.content.Context;
import android.content.res.Resources;
public class View {
    public static final int VISIBLE = 0;
    public static final int INVISIBLE = 4;
    public static final int GONE = 8;
    public interface OnClickListener { void onClick(View v); }
    public View() {}
    public View(Context c) {}
    public int getId() { return 0; }
    public int getVisibility() { return VISIBLE; }
    public boolean isShown() { return true; }
    public Resources getResources() { return null; }
    public int getLeft() { return 0; }
    public int getTop() { return 0; }
    public int getRight() { return getWidth(); }
    public int getBottom() { return getHeight(); }
    public int getWidth() { return 0; }
    public int getHeight() { return 0; }
    public void getLocationOnScreen(int[] outLocation) {
        if (outLocation != null && outLocation.length >= 2) {
            outLocation[0] = 0; outLocation[1] = 0;
        }
    }
    public boolean isClickable() { return false; }
    public boolean hasOnClickListeners() { return false; }
    public void setOnClickListener(OnClickListener l) {}
    public CharSequence getContentDescription() { return null; }
    public Object getTag(int key) { return null; }
    public void setTag(int key, Object tag) {}
    public ViewParent getParent() { return null; }
}`),
      writeOverride('android/view/ViewGroup.java', `package android.view;
import android.content.Context;
public class ViewGroup extends View implements ViewParent {
    public ViewGroup() {}
    public ViewGroup(Context c) { super(c); }
    public int getChildCount() { return 0; }
    public View getChildAt(int index) { return null; }
}`),
      writeOverride('android/widget/TextView.java', `package android.widget;
import android.content.Context;
import android.view.View;
public class TextView extends View {
    public TextView() {}
    public TextView(Context c) { super(c); }
    public CharSequence getText() { return ""; }
    public void setText(CharSequence text) {}
}`),
      writeOverride('android/widget/CompoundButton.java', `package android.widget;
import android.content.Context;
public abstract class CompoundButton extends TextView {
    public CompoundButton() {}
    public CompoundButton(Context c) { super(c); }
}`),
      writeOverride('android/widget/HorizontalScrollView.java', `package android.widget;
import android.content.Context;
import android.view.ViewGroup;
public class HorizontalScrollView extends ViewGroup {
    public HorizontalScrollView() {}
    public HorizontalScrollView(Context c) { super(c); }
}`),
      writeOverride('android/widget/ScrollView.java', `package android.widget;
import android.content.Context;
import android.view.ViewGroup;
public class ScrollView extends ViewGroup {
    public ScrollView() {}
    public ScrollView(Context c) { super(c); }
}`),
    ];
    cp.execFileSync(javacBin, [
      '--release', '17', '-encoding', 'UTF-8',
      '-cp', `${outClasses}:${androidJar}`,
      '-d', overrideClasses,
      ...ovFiles,
    ]);

    // 3. Write synthetic R8/Expo + UI/DeepLink + SSE test harness
    const writeTest = (rel, code) => {
      const f = path.join(testSrc, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, code);
      return f;
    };
    const testFiles = [
      writeTest('Ae/k.java', `package Ae; public class k { public static oj.A a = new oj.A(); }`),
      writeTest('expo/modules/filesystem/FileSystemDownloadTask.java', `package expo.modules.filesystem; public class FileSystemDownloadTask { public static oj.A k = new oj.A(); }`),
      writeTest('expo/modules/filesystem/FileSystemUploadTask.java', `package expo.modules.filesystem; public class FileSystemUploadTask { public static oj.A h = new oj.A(); }`),
      writeTest('b8/a.java', `package b8; public class a { public static oj.A b = new oj.A(); public static oj.A c = new oj.A(); }`),
      writeTest('Ce/k.java', `package Ce; public class k { public oj.A a = null; }`),
      writeTest('Lc/d.java', `package Lc; public class d { public oj.A b = new oj.A(); }`),
      writeTest('xg/B0.java', `package xg; public class B0 { public oj.A a = null; }`),
      writeTest('bf/r.java', `package bf; public class r { public Object module; public r(Object m) { this.module = m; } }`),
      writeTest('bf/s.java', `package bf; import java.util.*; public class s { public Map<String, r> b = new LinkedHashMap<>(); }`),
      writeTest('bf/d.java', `package bf; public class d { public s j = new s(); }`),
      writeTest('bf/p.java', `package bf; public class p { public d a = new d(); }`),
      writeTest('expo/modules/adapters/react/NativeModulesProxy.java', `package expo.modules.adapters.react; public class NativeModulesProxy { public bf.p mKotlinInteropModuleRegistry = new bf.p(); }`),
      writeTest('expo/modules/ui/HostView.java', `package expo.modules.ui;
import android.content.res.Resources;
import android.view.*;
import java.util.*;
public class HostView extends ViewGroup {
    public int leftPx, topPx, wPx, hPx;
    public int visibility = View.VISIBLE;
    public boolean clickable;
    public CharSequence desc;
    public Resources res;
    public ViewParent parent;
    public final List<View> children = new ArrayList<>();
    @Override public int getChildCount() { return children.size(); }
    @Override public View getChildAt(int i) { return children.get(i); }
    @Override public int getLeft() { return leftPx; }
    @Override public int getTop() { return topPx; }
    @Override public int getRight() { return leftPx + wPx; }
    @Override public int getBottom() { return topPx + hPx; }
    @Override public int getWidth() { return wPx; }
    @Override public int getHeight() { return hPx; }
    @Override public int getVisibility() { return visibility; }
    @Override public boolean isShown() { return visibility == View.VISIBLE && (!(parent instanceof View) || ((View) parent).isShown()); }
    @Override public Resources getResources() { return res != null ? res : (parent instanceof View ? ((View) parent).getResources() : null); }
    @Override public void getLocationOnScreen(int[] loc) { loc[0] = leftPx; loc[1] = topPx; }
    @Override public boolean isClickable() { return clickable; }
    @Override public boolean hasOnClickListeners() { return clickable; }
    @Override public CharSequence getContentDescription() { return desc; }
    @Override public ViewParent getParent() { return parent; }
}`),
      writeTest('pe/j.java', `package pe; import android.content.Intent; public interface j { boolean onNewIntent(Intent intent); }`),
      writeTest('pe/k.java', `package pe; import android.app.Activity; public interface k { void onDidCreate(Activity activity); }`),
      writeTest('Fc/o.java', `package Fc; import java.util.*; public class o {
          public List<pe.j> i = new ArrayList<>();
          public List<pe.k> j = new ArrayList<>();
          public Object reactDelegate;
          public boolean onNewIntent(android.content.Intent intent) { return true; }
      }`),
      writeTest('com/facebook/react/n.java', `package com.facebook.react; public class n extends android.app.Activity {}`),
      writeTest('com/facebook/react/ReactDelegate.java', `package com.facebook.react; import android.content.Intent; public class ReactDelegate {
          public interface HostIface { void onNewIntent(Intent intent); }
          public HostIface mReactHost;
          public void onNewIntent(Intent intent) { if (mReactHost != null) mReactHost.onNewIntent(intent); }
      }`),
      writeTest('VerifyR3Harness.java', `
import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Resources;
import android.graphics.Rect;
import android.net.Uri;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.CompoundButton;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;
import android.widget.TextView;
import dev.rokbot.nativeapp.*;
import java.io.Closeable;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.security.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import sun.misc.Unsafe;

public class VerifyR3Harness {
    private static Unsafe unsafe;
    static {
        try {
            Field f = Unsafe.class.getDeclaredField("theUnsafe");
            f.setAccessible(true);
            unsafe = (Unsafe) f.get(null);
        } catch (Exception e) { throw new RuntimeException(e); }
    }
    @SuppressWarnings("unchecked")
    private static <T> T alloc(Class<T> c) {
        try { return (T) unsafe.allocateInstance(c); }
        catch (Exception e) { throw new RuntimeException(e); }
    }
    private static void check(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
    }

    // Minimal in-memory AndroidKeyStore provider so Storage AES-GCM roundtrips cleanly on desktop JVM
    public static final class FakeKeyStoreSpi extends KeyStoreSpi {
        private static final SecretKey KEY = new SecretKeySpec(new byte[32], "AES");
        @Override public KeyStore.Entry engineGetEntry(String a, KeyStore.ProtectionParameter p) { return new KeyStore.SecretKeyEntry(KEY); }
        @Override public Key engineGetKey(String a, char[] p) { return KEY; }
        @Override public Certificate[] engineGetCertificateChain(String a) { return null; }
        @Override public Certificate engineGetCertificate(String a) { return null; }
        @Override public Date engineGetCreationDate(String a) { return new Date(); }
        @Override public void engineSetKeyEntry(String a, Key k, char[] p, Certificate[] c) {}
        @Override public void engineSetKeyEntry(String a, byte[] k, Certificate[] c) {}
        @Override public void engineSetCertificateEntry(String a, Certificate c) {}
        @Override public void engineDeleteEntry(String a) {}
        @Override public Enumeration<String> engineAliases() { return Collections.enumeration(List.of("rokbot-native-device-credential")); }
        @Override public boolean engineContainsAlias(String a) { return "rokbot-native-device-credential".equals(a); }
        @Override public int engineSize() { return 1; }
        @Override public boolean engineIsKeyEntry(String a) { return true; }
        @Override public boolean engineIsCertificateEntry(String a) { return false; }
        @Override public String engineGetCertificateAlias(Certificate c) { return null; }
        @Override public void engineStore(java.io.OutputStream s, char[] p) {}
        @Override public void engineLoad(java.io.InputStream s, char[] p) {}
    }

    static class MemPrefs implements SharedPreferences {
        final Map<String, Object> data = new HashMap<>();
        @Override public Map<String, ?> getAll() { return data; }
        @Override public String getString(String k, String d) { Object v = data.get(k); return v instanceof String ? (String) v : d; }
        @Override @SuppressWarnings("unchecked") public Set<String> getStringSet(String k, Set<String> d) { return d; }
        @Override public int getInt(String k, int d) { Object v = data.get(k); return v instanceof Integer ? (Integer) v : d; }
        @Override public long getLong(String k, long d) { Object v = data.get(k); return v instanceof Long ? (Long) v : d; }
        @Override public float getFloat(String k, float d) { Object v = data.get(k); return v instanceof Float ? (Float) v : d; }
        @Override public boolean getBoolean(String k, boolean d) { Object v = data.get(k); return v instanceof Boolean ? (Boolean) v : d; }
        @Override public boolean contains(String k) { return data.containsKey(k); }
        @Override public Editor edit() {
            return new Editor() {
                final Map<String, Object> pending = new HashMap<>();
                final Set<String> removals = new HashSet<>();
                boolean clearAll = false;
                @Override public Editor putString(String k, String v) { pending.put(k, v); return this; }
                @Override public Editor putStringSet(String k, Set<String> v) { return this; }
                @Override public Editor putInt(String k, int v) { pending.put(k, v); return this; }
                @Override public Editor putLong(String k, long v) { pending.put(k, v); return this; }
                @Override public Editor putFloat(String k, float v) { pending.put(k, v); return this; }
                @Override public Editor putBoolean(String k, boolean v) { pending.put(k, v); return this; }
                @Override public Editor remove(String k) { removals.add(k); return this; }
                @Override public Editor clear() { clearAll = true; return this; }
                @Override public boolean commit() { apply(); return true; }
                @Override public void apply() {
                    if (clearAll) data.clear();
                    for (String r : removals) data.remove(r);
                    data.putAll(pending);
                }
            };
        }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
    }

    static class FakeResources extends Resources {
        DisplayMetrics dm;
        FakeResources() { super(null, null, null); }
        @Override public DisplayMetrics getDisplayMetrics() { return dm; }
    }

    static class FakeApp extends Application {
        MemPrefs prefs;
        @Override public Context getApplicationContext() { return this; }
        @Override public SharedPreferences getSharedPreferences(String name, int mode) { return prefs; }
    }

    static class FakeReactActivity extends com.facebook.react.n {
        FakeApp app;
        FakeResources res;
        Intent intent;
        public Fc.o mDelegate;
        @Override public Context getApplicationContext() { return app; }
        @Override public SharedPreferences getSharedPreferences(String name, int mode) { return app.prefs; }
        @Override public Resources getResources() { return res; }
        @Override public Intent getIntent() { return intent; }
        @Override public void setIntent(Intent i) { intent = i; }
    }

    static class FakeIntent extends Intent {
        Uri data;
        Map<String, Object> extras;
        @Override public Uri getData() { return data; }
        @Override public Intent setData(Uri d) { data = d; return this; }
        @Override public Intent putExtra(String n, String v) {
            if (extras == null) extras = new HashMap<>();
            extras.put(n, v);
            return this;
        }
    }

    static class FakeViewGroup extends ViewGroup {
        int leftPx, topPx, wPx, hPx;
        int visibility = View.VISIBLE;
        boolean clickable;
        CharSequence desc;
        Resources res;
        final List<View> children = new ArrayList<>();
        final Map<Integer, Object> tags = new HashMap<>();
        ViewParent parent;
        void attachParent(ViewParent p) { parent = p; }
        void addMockChild(View v) {
            children.add(v);
            if (v instanceof FakeViewGroup) ((FakeViewGroup) v).attachParent(this);
            else if (v instanceof FakeTextView) ((FakeTextView) v).attachParent(this);
            else if (v instanceof expo.modules.ui.HostView) ((expo.modules.ui.HostView) v).parent = this;
            else if (v instanceof FakeHorizontalScrollView) ((FakeHorizontalScrollView) v).attachParent(this);
            else if (v instanceof FakeScrollView) ((FakeScrollView) v).attachParent(this);
            else if (v instanceof FakeCompoundButton) ((FakeCompoundButton) v).attachParent(this);
        }
        @Override public int getChildCount() { return children.size(); }
        @Override public View getChildAt(int idx) { return children.get(idx); }
        @Override public int getLeft() { return leftPx; }
        @Override public int getTop() { return topPx; }
        @Override public int getRight() { return leftPx + wPx; }
        @Override public int getBottom() { return topPx + hPx; }
        @Override public int getWidth() { return wPx; }
        @Override public int getHeight() { return hPx; }
        @Override public int getVisibility() { return visibility; }
        @Override public boolean isShown() { return visibility == View.VISIBLE && (!(parent instanceof View) || ((View) parent).isShown()); }
        @Override public Resources getResources() { return res != null ? res : (parent instanceof View ? ((View) parent).getResources() : null); }
        @Override public void getLocationOnScreen(int[] loc) { loc[0] = leftPx; loc[1] = topPx; }
        @Override public boolean isClickable() { return clickable; }
        @Override public boolean hasOnClickListeners() { return clickable; }
        @Override public CharSequence getContentDescription() { return desc; }
        @Override public Object getTag(int key) { return tags.get(key); }
        @Override public void setTag(int key, Object v) { if (v == null) tags.remove(key); else tags.put(key, v); }
        @Override public ViewParent getParent() { return parent; }
    }

    static class FakeTextView extends TextView {
        int leftPx, topPx, wPx, hPx;
        int visibility = View.VISIBLE;
        boolean clickable;
        CharSequence text = "";
        CharSequence desc;
        Resources res;
        final Map<Integer, Object> tags = new HashMap<>();
        ViewParent parent;
        FakeTextView() {}
        void attachParent(ViewParent p) { parent = p; }
        @Override public CharSequence getText() { return text; }
        @Override public void setText(CharSequence t) { text = t; }
        @Override public int getLeft() { return leftPx; }
        @Override public int getTop() { return topPx; }
        @Override public int getRight() { return leftPx + wPx; }
        @Override public int getBottom() { return topPx + hPx; }
        @Override public int getWidth() { return wPx; }
        @Override public int getHeight() { return hPx; }
        @Override public int getVisibility() { return visibility; }
        @Override public boolean isShown() { return visibility == View.VISIBLE && (!(parent instanceof View) || ((View) parent).isShown()); }
        @Override public Resources getResources() { return res != null ? res : (parent instanceof View ? ((View) parent).getResources() : null); }
        @Override public void getLocationOnScreen(int[] loc) { loc[0] = leftPx; loc[1] = topPx; }
        @Override public boolean isClickable() { return clickable; }
        @Override public boolean hasOnClickListeners() { return clickable; }
        @Override public CharSequence getContentDescription() { return desc; }
        @Override public Object getTag(int key) { return tags.get(key); }
        @Override public void setTag(int key, Object v) { if (v == null) tags.remove(key); else tags.put(key, v); }
        @Override public ViewParent getParent() { return parent; }
    }

    static class FakeHorizontalScrollView extends HorizontalScrollView {
        int leftPx, topPx, wPx, hPx;
        int visibility = View.VISIBLE;
        Resources res;
        final List<View> children = new ArrayList<>();
        ViewParent parent;
        void attachParent(ViewParent p) { parent = p; }
        void addMockChild(View v) {
            children.add(v);
            if (v instanceof FakeViewGroup) ((FakeViewGroup) v).attachParent(this);
            else if (v instanceof FakeTextView) ((FakeTextView) v).attachParent(this);
        }
        @Override public int getChildCount() { return children.size(); }
        @Override public View getChildAt(int idx) { return children.get(idx); }
        @Override public int getWidth() { return wPx; }
        @Override public int getHeight() { return hPx; }
        @Override public int getVisibility() { return visibility; }
        @Override public boolean isShown() { return visibility == View.VISIBLE && (!(parent instanceof View) || ((View) parent).isShown()); }
        @Override public Resources getResources() { return res != null ? res : (parent instanceof View ? ((View) parent).getResources() : null); }
        @Override public void getLocationOnScreen(int[] loc) { loc[0] = leftPx; loc[1] = topPx; }
        @Override public ViewParent getParent() { return parent; }
    }

    static class FakeScrollView extends ScrollView {
        int leftPx, topPx, wPx, hPx;
        int visibility = View.VISIBLE;
        Resources res;
        final List<View> children = new ArrayList<>();
        ViewParent parent;
        void attachParent(ViewParent p) { parent = p; }
        void addMockChild(View v) {
            children.add(v);
            if (v instanceof FakeViewGroup) ((FakeViewGroup) v).attachParent(this);
            else if (v instanceof FakeTextView) ((FakeTextView) v).attachParent(this);
        }
        @Override public int getChildCount() { return children.size(); }
        @Override public View getChildAt(int idx) { return children.get(idx); }
        @Override public int getWidth() { return wPx; }
        @Override public int getHeight() { return hPx; }
        @Override public int getVisibility() { return visibility; }
        @Override public boolean isShown() { return visibility == View.VISIBLE && (!(parent instanceof View) || ((View) parent).isShown()); }
        @Override public Resources getResources() { return res != null ? res : (parent instanceof View ? ((View) parent).getResources() : null); }
        @Override public void getLocationOnScreen(int[] loc) { loc[0] = leftPx; loc[1] = topPx; }
        @Override public ViewParent getParent() { return parent; }
    }

    static class FakeCompoundButton extends CompoundButton {
        int leftPx, topPx, wPx, hPx;
        int visibility = View.VISIBLE;
        boolean clickable = true;
        CharSequence desc;
        Resources res;
        ViewParent parent;
        void attachParent(ViewParent p) { parent = p; }
        @Override public int getWidth() { return wPx; }
        @Override public int getHeight() { return hPx; }
        @Override public int getVisibility() { return visibility; }
        @Override public boolean isShown() { return visibility == View.VISIBLE && (!(parent instanceof View) || ((View) parent).isShown()); }
        @Override public Resources getResources() { return res != null ? res : (parent instanceof View ? ((View) parent).getResources() : null); }
        @Override public void getLocationOnScreen(int[] loc) { loc[0] = leftPx; loc[1] = topPx; }
        @Override public boolean isClickable() { return clickable; }
        @Override public boolean hasOnClickListeners() { return clickable; }
        @Override public CharSequence getContentDescription() { return desc; }
        @Override public ViewParent getParent() { return parent; }
    }

    public static void main(String[] args) throws Exception {
        int ssePort = Integer.parseInt(args[0]);
        Security.insertProviderAt(new Provider("AndroidKeyStore", "1.0", "test") {{
            put("KeyStore.AndroidKeyStore", FakeKeyStoreSpi.class.getName());
        }}, 1);

        FakeApp app = alloc(FakeApp.class);
        app.prefs = new MemPrefs();
        DisplayMetrics dm = alloc(DisplayMetrics.class);
        dm.density = 2.0f;
        FakeResources res = alloc(FakeResources.class);
        res.dm = dm;

        // A. Live HTTP Chunked SSE + Immediate Cancellation (<1.5s while server holds open)
        CountDownLatch gotEvent = new CountDownLatch(1);
        AtomicReference<Closeable> streamRef = new AtomicReference<>();
        AtomicReference<String> evtPayload = new AtomicReference<>();
        AtomicReference<Throwable> sseErr = new AtomicReference<>();
        long t0 = System.currentTimeMillis();
        Thread sseThread = new Thread(() -> {
            try {
                HostApiClient.openSseStream(
                        "http://127.0.0.1:" + ssePort, "tok-123", "/notifications/events",
                        "cursor-0", true, () -> true,
                        new HostApiClient.SseListener() {
                            @Override public void onOpening(Closeable stream) { streamRef.set(stream); }
                            @Override public void onConnected() {}
                            @Override public void onEvent(String id, String event, String data) {
                                evtPayload.set(id + "|" + event + "|" + data);
                                gotEvent.countDown();
                            }
                        });
            } catch (Throwable t) { sseErr.set(t); }
        });
        sseThread.setDaemon(true);
        sseThread.start();
        check(gotEvent.await(5, TimeUnit.SECONDS), "SSE event not received: " + sseErr.get());
        check("evt-1|notification|{\\"line\\":1}\\nline2".equals(evtPayload.get()), "Multi-line chunked SSE mismatch: " + evtPayload.get());
        streamRef.get().close();
        sseThread.join(1500);
        check(!sseThread.isAlive(), "Socket.close() must unblock SSE reader immediately");
        check(System.currentTimeMillis() - t0 < 3000, "SSE cancellation took too long");

        // B. R8OkHttpHook: t8.f.b + Ae.k.a + FileSystemDownloadTask/UploadTask + b8.a + depth-6 Expo modules + refresh pool evict/dedup
        R8OkHttpHook.install(app);
        check(t8.f.f().z().size() == 1, "t8.f.b should have 1 interceptor");
        check(Ae.k.a.z().size() == 1, "Ae.k.a should be hooked without early return from t8.f");
        check(expo.modules.filesystem.FileSystemDownloadTask.k.z().size() == 1, "FileSystemDownloadTask.k must be hooked");
        check(expo.modules.filesystem.FileSystemUploadTask.h.z().size() == 1, "FileSystemUploadTask.h must be hooked");
        check(b8.a.b.z().size() == 1 && b8.a.c.z().size() == 1, "b8.a clients must be hooked");

        // Install again without refresh & with refresh(): NEVER duplicate interceptors, MUST evict pools
        R8OkHttpHook.install(app);
        int beforeEvict = Ae.k.a.n().evictCount;
        R8OkHttpHook.refresh(app);
        check(t8.f.f().z().size() == 1, "refresh must not duplicate t8.f.b interceptor");
        check(Ae.k.a.z().size() == 1, "refresh must not duplicate Ae.k.a interceptor");
        check(expo.modules.filesystem.FileSystemDownloadTask.k.z().size() == 1, "refresh must not duplicate DownloadTask interceptor");
        check(Ae.k.a.n().evictCount > beforeEvict, "refresh must evict connection pools on tracked clients");

        // Depth-6 Expo module tree: NativeModulesProxy -> bf.p -> bf.d -> bf.s -> bf.r -> Ce.k / Lc.d / xg.B0
        final expo.modules.adapters.react.NativeModulesProxy nmp = new expo.modules.adapters.react.NativeModulesProxy();
        Ce.k ceK = new Ce.k();
        Lc.d lcD = new Lc.d();
        xg.B0 xgB0 = new xg.B0();
        nmp.mKotlinInteropModuleRegistry.a.j.b.put("ce", new bf.r(ceK));
        nmp.mKotlinInteropModuleRegistry.a.j.b.put("lc", new bf.r(lcD));
        nmp.mKotlinInteropModuleRegistry.a.j.b.put("xg", new bf.r(xgB0));
        Object fakeReactCtx = new Object() {
            public Collection<Object> getNativeModules() { return List.of(nmp); }
        };
        R8OkHttpHook.hookReactContext(app, fakeReactCtx);
        check(ceK.a == t8.f.f(), "Ce.k null client should be pre-populated with hooked client");
        check(xgB0.a == t8.f.f(), "xg.B0 null client should be pre-populated with hooked client");
        check(lcD.b.z().size() == 1, "Lc.d client at depth 6 must be wrapped with R8OkHttpInterceptor");

        // C. R8OkHttpInterceptor SSE Accept header preservation & Direct-Host origin matching
        Storage.saveCredentials(app, "tok-secret-123", "http://127.0.0.1:" + ssePort, "dev-1");
        check(Storage.isPaired(app), "FakeKeyStore Storage must report paired");
        R8OkHttpInterceptor interceptor = new R8OkHttpInterceptor(app);
        AtomicReference<oj.C> forwardedSse = new AtomicReference<>();
        oj.C sseReq = new oj.C.a().l("https://api2.cursor.sh/events").e("Accept", "TEXT/EVENT-STREAM; charset=utf-8").b();
        interceptor.a(new oj.v.a() {
            @Override public oj.C r() { return sseReq; }
            @Override public oj.E a(oj.C req) { forwardedSse.set(req); return new oj.E(); }
        });
        check(forwardedSse.get() != null && "TEXT/EVENT-STREAM; charset=utf-8".equals(forwardedSse.get().h("Accept")),
                "R8OkHttpInterceptor must preserve case-insensitive Accept: text/event-stream on /events");
        check(GatewayEndpointRouter.matchesServerOrigin("http://127.0.0.1:" + ssePort + "/local/files?q=hello world#top",
                "http://127.0.0.1:" + ssePort), "matchesServerOrigin must tolerate space/fragment in query");
        check(!GatewayEndpointRouter.matchesServerOrigin("https://127.0.0.1:" + ssePort + "/local/files",
                "http://127.0.0.1:" + ssePort), "matchesServerOrigin must reject scheme mismatch");
        check(GatewayEndpointRouter.isLoopbackHost("127.0.0.1") && !GatewayEndpointRouter.isLoopbackHost("example.com"),
                "isLoopbackHost check");

        // D. Localize.observeAppLanguage
        Localize.observeAppLanguage("调试");
        check("zh".equals(Localize.getObservedLanguage()), "observeAppLanguage zh");
        Localize.observeAppLanguage("Usage");
        check("en".equals(Localize.getObservedLanguage()), "observeAppLanguage en");

        // E. RokBotBootstrap UI matching, SettingsSheet / SidebarIdentityBar guards, Fabric view recycling & Fc.o.i vs Fc.o.j
        FakeReactActivity reactAct = alloc(FakeReactActivity.class);
        reactAct.app = app;
        reactAct.res = res;
        reactAct.mDelegate = new Fc.o();
        reactAct.mDelegate.j.add(a -> {});
        com.facebook.react.ReactDelegate rd = new com.facebook.react.ReactDelegate();
        AtomicReference<Uri> hostDeliveredUri = new AtomicReference<>();
        rd.mReactHost = intent -> hostDeliveredUri.set(intent.getData());
        reactAct.mDelegate.reactDelegate = rd;

        Method hookDeepLink = RokBotBootstrap.class.getDeclaredMethod("hookDeepLinkDelivery", Activity.class);
        hookDeepLink.setAccessible(true);
        hookDeepLink.invoke(null, reactAct);
        check(reactAct.mDelegate.i.size() == 1, "Fc.o.i must receive bootstrap pe.j listener");
        check(reactAct.mDelegate.j.size() == 1, "Fc.o.j (List<pe.k>) must NEVER be injected with pe.j proxy");
        for (pe.k handler : reactAct.mDelegate.j) {
            handler.onDidCreate(reactAct);
        }
        FakeIntent hotIntent = alloc(FakeIntent.class);
        hotIntent.data = Uri.parse("rokbot-local://agent/agent-xyz");
        reactAct.mDelegate.i.get(0).onNewIntent(hotIntent);
        check("grokbot://app/v1/chat?id=agent-xyz".equals(String.valueOf(hotIntent.getData())),
                "pe.j proxy must normalize rokbot-local:// URI before ExpoLinking reads it: " + hotIntent.getData());
        FakeIntent hostIntent = alloc(FakeIntent.class);
        hostIntent.data = Uri.parse("rokbot-local://agent/agent-host-1");
        rd.onNewIntent(hostIntent);
        check("grokbot://app/v1/chat?id=agent-host-1".equals(String.valueOf(hostDeliveredUri.get())),
                "ReactDelegate host proxy must normalize URI before mReactHost.onNewIntent: " + hostDeliveredUri.get());

        Method resolveViewM = RokBotBootstrap.class.getDeclaredMethod("resolveNativeTargetForView", Activity.class, View.class);
        Method scanViewsM = RokBotBootstrap.class.getDeclaredMethod("scanAndWireRnViews", Activity.class, View.class);
        resolveViewM.setAccessible(true);
        scanViewsM.setAccessible(true);

        // 1) Avatar in SidebarIdentityBar must NEVER be hijacked
        FakeViewGroup avatarGroup = new FakeViewGroup();
        avatarGroup.wPx = 80; avatarGroup.hPx = 80; // 40dp x 40dp
        avatarGroup.desc = "dev-gateway@localhost avatar";
        avatarGroup.clickable = true;
        check(resolveViewM.invoke(null, reactAct, avatarGroup) == null, "dev-gateway@localhost avatar must NOT be hijacked");

        // 2) SidebarIdentityBar narrow row (260dp x 46dp) must NOT hijack to ProfileActivity
        FakeViewGroup sidebarRow = new FakeViewGroup();
        sidebarRow.wPx = 520; sidebarRow.hPx = 92; // 260dp x 46dp
        FakeTextView sidebarTxt = new FakeTextView();
        sidebarTxt.wPx = 300; sidebarTxt.hPx = 40;
        sidebarTxt.text = "dev-gateway@localhost";
        sidebarRow.addMockChild(sidebarTxt);
        check(resolveViewM.invoke(null, reactAct, sidebarTxt) == null, "SidebarIdentityBar row <=300dp must NOT hijack");

        // 3) SettingsSheet Account card (340dp x 60dp) SHOULD rewrite and open ProfileActivity, then invalidate on Fabric recycle
        FakeViewGroup accountCard = new FakeViewGroup();
        accountCard.wPx = 680; accountCard.hPx = 120; // 340dp x 60dp
        FakeTextView accountTxt = new FakeTextView();
        accountTxt.wPx = 400; accountTxt.hPx = 48;
        accountTxt.text = "dev-gateway@localhost";
        accountCard.addMockChild(accountTxt);
        scanViewsM.invoke(null, reactAct, accountCard);
        check("127.0.0.1".equals(String.valueOf(accountTxt.getText())), "Account text should rewrite to Host IP: " + accountTxt.getText());
        check(resolveViewM.invoke(null, reactAct, accountTxt) == ProfileActivity.class, "Account card >300x50 should open ProfileActivity");
        // Recycle TextView to ordinary message text
        accountTxt.text = "Regular chat bubble";
        check(resolveViewM.invoke(null, reactAct, accountTxt) == null, "Recycled Fabric TextView must clear stale Profile override tag");

        // 3b) Host profile (GET /local/profile, F1): title -> displayName, second line -> hostName,
        //     persisted to profileCache, and a later profile change repaints the existing rewrite.
        FakeViewGroup profileCard = new FakeViewGroup();
        profileCard.wPx = 680; profileCard.hPx = 120; // 340dp x 60dp SettingsSheet account row
        FakeTextView profileTitle = new FakeTextView();
        profileTitle.topPx = 10; profileTitle.wPx = 400; profileTitle.hPx = 48; profileTitle.text = "dev-gateway@localhost";
        FakeTextView profileSub = new FakeTextView();
        profileSub.topPx = 62; profileSub.wPx = 400; profileSub.hPx = 36; profileSub.text = "dev-gateway@localhost";
        profileCard.addMockChild(profileTitle);
        profileCard.addMockChild(profileSub);
        Method applyProfileM = Class.forName("dev.rokbot.nativeapp.HostProfile")
                .getDeclaredMethod("apply", android.content.Context.class, org.json.JSONObject.class);
        applyProfileM.setAccessible(true);
        org.json.JSONObject hostProfile = new org.json.JSONObject();
        hostProfile.put("displayName", "IKUN");
        hostProfile.put("hostName", "Grok Bot Host");
        hostProfile.put("avatarDataUrl", org.json.JSONObject.NULL);
        applyProfileM.invoke(null, reactAct, hostProfile);
        org.json.JSONObject cachedProfile = Storage.getProfileCache(app);
        check(cachedProfile != null && "IKUN".equals(cachedProfile.optString("displayName", "")), "HostProfile.apply must persist profileCache");
        scanViewsM.invoke(null, reactAct, profileCard);
        check("IKUN".equals(String.valueOf(profileTitle.getText())), "Account title must show Host displayName: " + profileTitle.getText());
        // rokbot.5: a Host still named after the old brand is shown with the rokbot name (display only).
        check("RokBot Host".equals(String.valueOf(profileSub.getText())), "Account subtitle must show Host hostName (rebranded): " + profileSub.getText());
        check("Grok Bot Host".equals(Storage.getProfileCache(app).optString("hostName", "")), "Stored profile keeps the Host's own hostName");
        check(resolveViewM.invoke(null, reactAct, profileTitle) == ProfileActivity.class, "Rewritten account row must still open ProfileActivity");
        org.json.JSONObject renamed = new org.json.JSONObject();
        renamed.put("displayName", "Xiaobai");
        renamed.put("hostName", "RokBot Host");
        applyProfileM.invoke(null, reactAct, renamed);
        scanViewsM.invoke(null, reactAct, profileCard);
        check("Xiaobai".equals(String.valueOf(profileTitle.getText())), "Profile change must repaint rewritten title: " + profileTitle.getText());
        check("RokBot Host".equals(String.valueOf(profileSub.getText())), "Profile change must repaint rewritten subtitle: " + profileSub.getText());
        org.json.JSONObject invalidProfile = new org.json.JSONObject();
        invalidProfile.put("displayName", "");
        applyProfileM.invoke(null, reactAct, invalidProfile);
        check("Xiaobai".equals(Storage.getProfileCache(app).optString("displayName", "")), "Empty displayName must not replace the cached profile");

        // 4) SettingsSheet wide "Debug" row (340dp x 52dp) must NOT hijack, while compact toolbar icon (44dp x 40dp) DOES open PairingActivity
        FakeViewGroup settingsDebugRow = new FakeViewGroup();
        settingsDebugRow.wPx = 680; settingsDebugRow.hPx = 104; // 340dp x 52dp
        FakeTextView settingsDebugTxt = new FakeTextView();
        settingsDebugTxt.wPx = 100; settingsDebugTxt.hPx = 48; settingsDebugTxt.clickable = true;
        settingsDebugTxt.text = "Debug";
        settingsDebugRow.addMockChild(settingsDebugTxt);
        check(resolveViewM.invoke(null, reactAct, settingsDebugTxt) == null, "Wide SettingsSheet Debug row must NOT hijack");

        FakeTextView toolbarLink = new FakeTextView();
        toolbarLink.wPx = 88; toolbarLink.hPx = 80; toolbarLink.clickable = true; // 44dp x 40dp
        toolbarLink.desc = "link";
        check(resolveViewM.invoke(null, reactAct, toolbarLink) == PairingActivity.class, "Compact toolbar link icon must open PairingActivity");

        // 5) SettingsSheet header bar ("Close" sibling) with "Connect to Host" -> PairingActivity vs 1-child list row -> null
        FakeViewGroup sheetHeader = new FakeViewGroup();
        sheetHeader.wPx = 1080; sheetHeader.hPx = 184; sheetHeader.res = res;
        FakeTextView sheetClose = new FakeTextView();
        sheetClose.wPx = 116; sheetClose.hPx = 116; sheetClose.clickable = true; sheetClose.text = "Close";
        FakeTextView sheetConnect = new FakeTextView();
        sheetConnect.wPx = 220; sheetConnect.hPx = 80; sheetConnect.clickable = true; sheetConnect.text = "Connect to Host";
        sheetHeader.addMockChild(sheetClose);
        sheetHeader.addMockChild(sheetConnect);
        check(resolveViewM.invoke(null, reactAct, sheetConnect) == PairingActivity.class, "SettingsSheet header Connect to Host must open PairingActivity");

        FakeViewGroup singleConnectRow = new FakeViewGroup();
        singleConnectRow.wPx = 680; singleConnectRow.hPx = 104; singleConnectRow.res = res;
        FakeTextView singleConnectTxt = new FakeTextView();
        singleConnectTxt.wPx = 220; singleConnectTxt.hPx = 48; singleConnectTxt.clickable = true; singleConnectTxt.text = "Connect to Host";
        singleConnectRow.addMockChild(singleConnectTxt);
        check(resolveViewM.invoke(null, reactAct, singleConnectTxt) == null, "Wide 1-child Connect to Host row must NOT hijack");

        // 6) Flattened InsetGroup #2de NotificationsRow + HostView switch -> full-row hit rect strictly above Appearance vs NotificationsToggle subtitle rejection
        Method findAtPointM = RokBotBootstrap.class.getDeclaredMethod("findNativeTargetAtPoint", Activity.class, View.class, float.class, float.class);
        findAtPointM.setAccessible(true);

        FakeViewGroup notifGroup = new FakeViewGroup();
        notifGroup.leftPx = 42; notifGroup.topPx = 1000; notifGroup.wPx = 996; notifGroup.hPx = 600; notifGroup.res = res;
        FakeTextView notifTxt = new FakeTextView();
        notifTxt.leftPx = 92; notifTxt.topPx = 1074; notifTxt.wPx = 733; notifTxt.hPx = 58; notifTxt.text = "Notifications";
        expo.modules.ui.HostView notifSw = new expo.modules.ui.HostView();
        notifSw.leftPx = 852; notifSw.topPx = 1040; notifSw.wPx = 137; notifSw.hPx = 126; notifSw.desc = "Notifications";
        FakeViewGroup appearanceRow = new FakeViewGroup();
        appearanceRow.leftPx = 45; appearanceRow.topPx = 1202; appearanceRow.wPx = 990; appearanceRow.hPx = 132; appearanceRow.clickable = true;
        FakeTextView appearanceTxt = new FakeTextView();
        appearanceTxt.leftPx = 92; appearanceTxt.topPx = 1239; appearanceTxt.wPx = 367; appearanceTxt.hPx = 58; appearanceTxt.text = "Appearance";
        appearanceRow.addMockChild(appearanceTxt);
        notifGroup.addMockChild(notifTxt);
        notifGroup.addMockChild(notifSw);
        notifGroup.addMockChild(appearanceRow);

        check(resolveViewM.invoke(null, reactAct, notifSw) == null, "HostView switch with Notifications desc must NOT resolve directly");
        check(resolveViewM.invoke(null, reactAct, notifTxt) == PushSettingsActivity.class, "Flattened NotificationsRow TextView must resolve PushSettingsActivity");
        Object hitOnText = findAtPointM.invoke(null, reactAct, notifGroup, 200f, 1100f);
        check(hitOnText != null, "Hit on Notifications text must succeed");
        Field hitTargetF = hitOnText.getClass().getDeclaredField("target");
        hitTargetF.setAccessible(true);
        check(hitTargetF.get(hitOnText) == PushSettingsActivity.class, "Hit on Notifications text must target PushSettingsActivity");
        Object hitOnSwitch = findAtPointM.invoke(null, reactAct, notifGroup, 920f, 1100f);
        check(hitOnSwitch != null && hitTargetF.get(hitOnSwitch) == PushSettingsActivity.class, "Hit on HostView switch area must intercept whole NotificationsRow -> PushSettingsActivity");
        check(findAtPointM.invoke(null, reactAct, notifGroup, 300f, 1260f) == null, "Tap inside Appearance row below divider must NOT open PushSettingsActivity");

        // NotificationsToggle with subtitle (AgentProfileScreen) must be excluded
        FakeViewGroup agentProfileGroup = new FakeViewGroup();
        agentProfileGroup.leftPx = 42; agentProfileGroup.topPx = 400; agentProfileGroup.wPx = 996; agentProfileGroup.hPx = 260; agentProfileGroup.res = res;
        FakeTextView agentNotifTitle = new FakeTextView();
        agentNotifTitle.leftPx = 92; agentNotifTitle.topPx = 440; agentNotifTitle.wPx = 733; agentNotifTitle.hPx = 58; agentNotifTitle.text = "Notifications";
        FakeTextView agentNotifSub = new FakeTextView();
        agentNotifSub.leftPx = 92; agentNotifSub.topPx = 503; agentNotifSub.wPx = 733; agentNotifSub.hPx = 48; agentNotifSub.text = "Alerts when replies finish";
        expo.modules.ui.HostView agentNotifSw = new expo.modules.ui.HostView();
        agentNotifSw.leftPx = 852; agentNotifSw.topPx = 456; agentNotifSw.wPx = 137; agentNotifSw.hPx = 126;
        agentProfileGroup.addMockChild(agentNotifTitle);
        agentProfileGroup.addMockChild(agentNotifSub);
        agentProfileGroup.addMockChild(agentNotifSw);
        check(resolveViewM.invoke(null, reactAct, agentNotifTitle) == null, "NotificationsToggle with subtitle must NOT hijack");
        check(findAtPointM.invoke(null, reactAct, agentProfileGroup, 200f, 470f) == null, "NotificationsToggle point hit with subtitle must stay in RN");

        // 7) "Usage, 12%" + SVG multi-node (<= 32 nodes) -> UsageActivity
        FakeViewGroup usageCard = new FakeViewGroup();
        usageCard.leftPx = 0; usageCard.topPx = 200; usageCard.wPx = 680; usageCard.hPx = 120; usageCard.clickable = true; usageCard.res = res;
        for (int i = 0; i < 20; i++) {
            FakeViewGroup svgNode = new FakeViewGroup();
            svgNode.leftPx = 10; svgNode.topPx = 210; svgNode.wPx = 24; svgNode.hPx = 24;
            usageCard.addMockChild(svgNode);
        }
        FakeTextView usageTxt = new FakeTextView();
        usageTxt.leftPx = 40; usageTxt.topPx = 220; usageTxt.wPx = 300; usageTxt.hPx = 48; usageTxt.text = "Usage, 12%";
        usageCard.addMockChild(usageTxt);
        check(resolveViewM.invoke(null, reactAct, usageTxt) == UsageActivity.class, "Usage, 12% comma-prefix with SVG <= 32 nodes must open UsageActivity");
        Object hitUsage = findAtPointM.invoke(null, reactAct, usageCard, 50f, 230f);
        check(hitUsage != null && hitTargetF.get(hitUsage) == UsageActivity.class, "Point hit on Usage card with SVG nodes must target UsageActivity");

        // 7b) rokbot.5 settings rows (InsetGroupNavRow, full width) -> ModelsActivity / UpdateActivity;
        //     the same words on a small control stay in RN.
        FakeViewGroup modelsRow = new FakeViewGroup();
        modelsRow.leftPx = 45; modelsRow.topPx = 1400; modelsRow.wPx = 990; modelsRow.hPx = 132; modelsRow.clickable = true; modelsRow.res = res;
        FakeTextView modelsTxt = new FakeTextView();
        modelsTxt.leftPx = 92; modelsTxt.topPx = 1437; modelsTxt.wPx = 300; modelsTxt.hPx = 58; modelsTxt.text = "模型配置";
        modelsRow.addMockChild(modelsTxt);
        check(resolveViewM.invoke(null, reactAct, modelsTxt) == ModelsActivity.class, "模型配置 settings row must open ModelsActivity");
        FakeViewGroup updateRow = new FakeViewGroup();
        updateRow.leftPx = 45; updateRow.topPx = 1532; updateRow.wPx = 990; updateRow.hPx = 132; updateRow.clickable = true; updateRow.res = res;
        FakeTextView updateTxt = new FakeTextView();
        updateTxt.leftPx = 92; updateTxt.topPx = 1569; updateTxt.wPx = 360; updateTxt.hPx = 58; updateTxt.text = "Software Update";
        updateRow.addMockChild(updateTxt);
        check(resolveViewM.invoke(null, reactAct, updateTxt) == UpdateActivity.class, "Software Update settings row must open UpdateActivity");
        Object hitUpdate = findAtPointM.invoke(null, reactAct, updateRow, 600f, 1600f);
        check(hitUpdate != null && hitTargetF.get(hitUpdate) == UpdateActivity.class, "Tap anywhere on the Software Update row must target UpdateActivity");
        FakeViewGroup smallPill = new FakeViewGroup();
        smallPill.wPx = 260; smallPill.hPx = 96; smallPill.clickable = true; smallPill.res = res;
        FakeTextView smallTxt = new FakeTextView();
        smallTxt.wPx = 200; smallTxt.hPx = 48; smallTxt.text = "检查更新";
        smallPill.addMockChild(smallTxt);
        check(resolveViewM.invoke(null, reactAct, smallTxt) == null, "Small 检查更新 control must stay in RN");

        // 8) SidebarIdentityBar ("Connect apps" / "Update to latest version") exclusion
        FakeViewGroup sidebarAppsCard = new FakeViewGroup();
        sidebarAppsCard.wPx = 680; sidebarAppsCard.hPx = 120; sidebarAppsCard.res = res;
        FakeTextView sidebarEmail = new FakeTextView();
        sidebarEmail.wPx = 400; sidebarEmail.hPx = 48; sidebarEmail.text = "dev-gateway@localhost";
        FakeTextView connectAppsTxt = new FakeTextView();
        connectAppsTxt.wPx = 220; connectAppsTxt.hPx = 40; connectAppsTxt.text = "Connect apps";
        sidebarAppsCard.addMockChild(sidebarEmail);
        sidebarAppsCard.addMockChild(connectAppsTxt);
        scanViewsM.invoke(null, reactAct, sidebarAppsCard);
        check("Xiaobai".equals(String.valueOf(sidebarEmail.getText())), "SidebarIdentityBar must show Host displayName: " + sidebarEmail.getText());
        check(resolveViewM.invoke(null, reactAct, sidebarEmail) == null, "SidebarIdentityBar with Connect apps must NOT open ProfileActivity");

        FakeViewGroup sidebarFooterWrap = new FakeViewGroup();
        sidebarFooterWrap.wPx = 720; sidebarFooterWrap.hPx = 280; sidebarFooterWrap.res = res; // 140dp <= 180dp
        FakeViewGroup sidebarCardOnly = new FakeViewGroup();
        sidebarCardOnly.wPx = 680; sidebarCardOnly.hPx = 120;
        FakeTextView sidebarEmail2 = new FakeTextView();
        sidebarEmail2.wPx = 400; sidebarEmail2.hPx = 48; sidebarEmail2.text = "dev-gateway@localhost";
        FakeTextView updateFooterTxt = new FakeTextView();
        updateFooterTxt.wPx = 300; updateFooterTxt.hPx = 40; updateFooterTxt.text = "Update to latest version";
        sidebarCardOnly.addMockChild(sidebarEmail2);
        sidebarFooterWrap.addMockChild(sidebarCardOnly);
        sidebarFooterWrap.addMockChild(updateFooterTxt);
        check(resolveViewM.invoke(null, reactAct, sidebarEmail2) == null, "SidebarIdentityBar with Update to latest version sibling must stay in RN");

        // 9) ProfileTabs HorizontalScrollView & multi-tab "Library" exclusion vs real Library row
        FakeHorizontalScrollView hsv = new FakeHorizontalScrollView();
        hsv.wPx = 700; hsv.hPx = 100; hsv.res = res;
        FakeTextView hsvLib = new FakeTextView();
        hsvLib.wPx = 440; hsvLib.hPx = 96; hsvLib.clickable = true; hsvLib.text = "Library";
        hsv.addMockChild(hsvLib);
        check(resolveViewM.invoke(null, reactAct, hsvLib) == null, "ProfileTabs HorizontalScrollView Library must NOT hijack");

        FakeViewGroup multiTabBar = new FakeViewGroup();
        multiTabBar.wPx = 760; multiTabBar.hPx = 100; multiTabBar.res = res;
        FakeTextView tab1 = new FakeTextView(); tab1.wPx = 180; tab1.hPx = 96; tab1.clickable = true; tab1.text = "Files";
        FakeTextView tab2 = new FakeTextView(); tab2.wPx = 420; tab2.hPx = 96; tab2.clickable = true; tab2.text = "Library";
        FakeTextView tab3 = new FakeTextView(); tab3.wPx = 180; tab3.hPx = 96; tab3.clickable = true; tab3.text = "Apps";
        multiTabBar.addMockChild(tab1); multiTabBar.addMockChild(tab2); multiTabBar.addMockChild(tab3);
        check(resolveViewM.invoke(null, reactAct, tab2) == null, "Multi-tab row (>=3 clickable text tabs) Library must NOT hijack");

        FakeTextView realLib = new FakeTextView();
        realLib.wPx = 440; realLib.hPx = 96; realLib.clickable = true; realLib.res = res; realLib.text = "Library";
        check(resolveViewM.invoke(null, reactAct, realLib) == LibraryActivity.class, "Standalone wide Library row must open LibraryActivity");

        // 10) Live 1.16.0 4-level SidebarIdentityBar (#148 -> #104 -> #102 -> #fc -> #e2 + #140 Connect apps + >48 nodes)
        FakeViewGroup sbRoot = new FakeViewGroup();
        sbRoot.wPx = 1080; sbRoot.hPx = 420; sbRoot.res = res;
        FakeViewGroup sbRow1Wrap = new FakeViewGroup(); sbRow1Wrap.wPx = 1080; sbRow1Wrap.hPx = 210;
        FakeViewGroup sbRow1Inner = new FakeViewGroup(); sbRow1Inner.wPx = 1080; sbRow1Inner.hPx = 210;
        FakeViewGroup sbCard = new FakeViewGroup(); sbCard.wPx = 1080; sbCard.hPx = 210;
        for (int i = 0; i < 6; i++) { FakeViewGroup pad = new FakeViewGroup(); pad.wPx = 20; pad.hPx = 20; sbCard.addMockChild(pad); }
        FakeTextView sbEmail4 = new FakeTextView();
        sbEmail4.wPx = 400; sbEmail4.hPx = 58; sbEmail4.text = "dev-gateway@localhost";
        sbCard.addMockChild(sbEmail4);
        sbRow1Inner.addMockChild(sbCard);
        sbRow1Wrap.addMockChild(sbRow1Inner);
        FakeViewGroup sbRow2 = new FakeViewGroup(); sbRow2.wPx = 1080; sbRow2.hPx = 210;
        for (int i = 0; i < 45; i++) { FakeViewGroup svgDeco = new FakeViewGroup(); svgDeco.wPx = 12; svgDeco.hPx = 12; sbRow2.addMockChild(svgDeco); }
        FakeTextView sbConnectApps = new FakeTextView(); sbConnectApps.wPx = 300; sbConnectApps.hPx = 58; sbConnectApps.text = "Connect apps";
        sbRow2.addMockChild(sbConnectApps);
        sbRoot.addMockChild(sbRow1Wrap);
        sbRoot.addMockChild(sbRow2);
        scanViewsM.invoke(null, reactAct, sbRoot);
        check("Xiaobai".equals(String.valueOf(sbEmail4.getText())), "4-level SidebarIdentityBar (>48 nodes) must show Host displayName: " + sbEmail4.getText());
        check(resolveViewM.invoke(null, reactAct, sbEmail4) == null, "4-level SidebarIdentityBar must NOT hijack ProfileActivity");

        // 11) Wrapped right-slot header bar (depth=1 inside 70dp header) with 160dp Connect to Host pill -> PairingActivity
        FakeViewGroup sheetHeaderWrap = new FakeViewGroup(); sheetHeaderWrap.wPx = 1080; sheetHeaderWrap.hPx = 184; sheetHeaderWrap.res = res;
        FakeViewGroup leftCloseSlot = new FakeViewGroup(); leftCloseSlot.wPx = 116; leftCloseSlot.hPx = 116; leftCloseSlot.clickable = true;
        FakeViewGroup rightConnectSlot = new FakeViewGroup(); rightConnectSlot.wPx = 320; rightConnectSlot.hPx = 80;
        FakeTextView rightConnectTxt = new FakeTextView(); rightConnectTxt.wPx = 300; rightConnectTxt.hPx = 70; rightConnectTxt.clickable = true; rightConnectTxt.text = "Connect to Host";
        rightConnectSlot.addMockChild(rightConnectTxt);
        sheetHeaderWrap.addMockChild(leftCloseSlot);
        sheetHeaderWrap.addMockChild(rightConnectSlot);
        check(resolveViewM.invoke(null, reactAct, rightConnectTxt) == PairingActivity.class, "Wrapped right-slot Connect to Host pill inside header bar must open PairingActivity");

        // 12) ScrollView viewport clipping stops ghost hits on scrolled-above NotificationsRow
        FakeScrollView sv = new FakeScrollView();
        sv.leftPx = 0; sv.topPx = 300; sv.wPx = 1080; sv.hPx = 1800; sv.res = res;
        FakeViewGroup svContent = new FakeViewGroup(); svContent.leftPx = 0; svContent.topPx = 100; svContent.wPx = 1080; svContent.hPx = 2400;
        FakeViewGroup clippedNotif = new FakeViewGroup(); clippedNotif.leftPx = 42; clippedNotif.topPx = 220; clippedNotif.wPx = 996; clippedNotif.hPx = 160;
        FakeTextView clippedNotifTxt = new FakeTextView(); clippedNotifTxt.leftPx = 92; clippedNotifTxt.topPx = 260; clippedNotifTxt.wPx = 500; clippedNotifTxt.hPx = 58; clippedNotifTxt.text = "Notifications";
        expo.modules.ui.HostView clippedSw = new expo.modules.ui.HostView(); clippedSw.leftPx = 852; clippedSw.topPx = 240; clippedSw.wPx = 137; clippedSw.hPx = 126;
        clippedNotif.addMockChild(clippedNotifTxt);
        clippedNotif.addMockChild(clippedSw);
        svContent.addMockChild(clippedNotif);
        sv.addMockChild(svContent);
        check(findAtPointM.invoke(null, reactAct, sv, 200f, 260f) == null, "Scrolled-above NotificationsRow outside ScrollView top must NOT intercept touch");
        Object hitInsideSv = findAtPointM.invoke(null, reactAct, sv, 200f, 340f);
        check(hitInsideSv != null && hitTargetF.get(hitInsideSv) == PushSettingsActivity.class, "Visible portion of NotificationsRow inside ScrollView must still open PushSettingsActivity");

        // 13) 1.26.0 4-level unpaired onboarding CTA (#68 clickable 986x126 -> #66 -> #5e 225x66 -> #5c -> #54/#58)
        // Must intercept both center taps and far-edge taps (no contentDescription on #68), plus waiting-for-browser labels
        FakeApp unpairedApp = alloc(FakeApp.class);
        unpairedApp.prefs = new MemPrefs();
        FakeReactActivity unpairedAct = alloc(FakeReactActivity.class);
        unpairedAct.app = unpairedApp;
        unpairedAct.res = res;
        FakeViewGroup ctaOuter = new FakeViewGroup();
        ctaOuter.leftPx = 47; ctaOuter.topPx = 2079; ctaOuter.wPx = 986; ctaOuter.hPx = 126; ctaOuter.clickable = true; ctaOuter.res = res;
        FakeViewGroup ctaInner = new FakeViewGroup();
        ctaInner.leftPx = 47; ctaInner.topPx = 2079; ctaInner.wPx = 986; ctaInner.hPx = 126;
        FakeViewGroup ctaCenter = new FakeViewGroup();
        ctaCenter.leftPx = 427; ctaCenter.topPx = 2109; ctaCenter.wPx = 225; ctaCenter.hPx = 66;
        FakeViewGroup ctaTextBox = new FakeViewGroup();
        ctaTextBox.leftPx = 427; ctaTextBox.topPx = 2109; ctaTextBox.wPx = 225; ctaTextBox.hPx = 66;
        FakeTextView ctaTxt1 = new FakeTextView();
        ctaTxt1.leftPx = 427; ctaTxt1.topPx = 2109; ctaTxt1.wPx = 225; ctaTxt1.hPx = 66; ctaTxt1.text = "连接服务端";
        FakeViewGroup ctaOverlay = new FakeViewGroup();
        ctaOverlay.leftPx = 427; ctaOverlay.topPx = 2109; ctaOverlay.wPx = 225; ctaOverlay.hPx = 66;
        FakeTextView ctaTxt2 = new FakeTextView();
        ctaTxt2.leftPx = 427; ctaTxt2.topPx = 2109; ctaTxt2.wPx = 225; ctaTxt2.hPx = 66; ctaTxt2.text = "连接服务端";
        ctaOverlay.addMockChild(ctaTxt2);
        ctaTextBox.addMockChild(ctaTxt1);
        ctaTextBox.addMockChild(ctaOverlay);
        ctaCenter.addMockChild(ctaTextBox);
        ctaInner.addMockChild(ctaCenter);
        ctaOuter.addMockChild(ctaInner);
        Field hitRectF = hitOnText.getClass().getDeclaredField("hitRect");
        hitRectF.setAccessible(true);
        Object hitCtaEdge = findAtPointM.invoke(null, unpairedAct, ctaOuter, 60f, 2140f);
        check(hitCtaEdge != null && hitTargetF.get(hitCtaEdge) == PairingActivity.class,
                "Far-left edge tap on unpaired 1.26.0 CTA must hit PairingActivity");
        Object hitCtaCenter = findAtPointM.invoke(null, unpairedAct, ctaOuter, 540f, 2140f);
        check(hitCtaCenter != null && hitTargetF.get(hitCtaCenter) == PairingActivity.class,
                "Center tap on 4-level nested 1.26.0 CTA must hit PairingActivity");
        android.graphics.Rect ctaHitRect = (android.graphics.Rect) hitRectF.get(hitCtaCenter);
        check(ctaHitRect != null && ctaHitRect.width() == 986 && ctaHitRect.height() == 126,
                "Deep nested CTA hitRect must expand to outer clickable 986x126 button: " + ctaHitRect);
        check(RokBotBootstrap.resolveNativeTargetForLabel("正在等待浏览器...") == PairingActivity.class,
                "Waiting-for-browser zh label must route to PairingActivity");
        check(RokBotBootstrap.resolveNativeTargetForLabel("Waiting for browser...") == PairingActivity.class,
                "Waiting-for-browser en label must route to PairingActivity");

        System.out.println("R3_JVM_VERIFY_OK");
    }
}
`),
    ];

    cp.execFileSync(javacBin, [
      '--release', '17', '-encoding', 'UTF-8',
      '-cp', `${overrideClasses}:${outClasses}:${androidJar}`,
      '-d', testClasses,
      ...testFiles,
    ]);

    const runOut = await new Promise((resolve, reject) => {
      const child = cp.spawn(javaBin, [
        '-cp', `${overrideClasses}:${testClasses}:${outClasses}:${androidJar}`,
        'VerifyR3Harness',
        String(ssePort),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`VerifyR3Harness timed out: ${stderr || stdout}`));
      }, 15000);
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`VerifyR3Harness exited ${code}: ${stderr}\n${stdout}`));
        else resolve(stdout);
      });
    });
    assert.ok(runOut.includes('R3_JVM_VERIFY_OK'), `Unexpected harness output: ${runOut}`);

    assert.equal(observedSseHeaders.length, 1);
    assert.equal(observedSseHeaders[0].authorization, 'Bearer tok-123');
    assert.equal(observedSseHeaders[0].accept, 'text/event-stream');
    assert.equal(observedSseHeaders[0]['x-rokbot-foreground'], '1');
    assert.equal(observedSseHeaders[0]['last-event-id'], 'cursor-0');
    assert.equal(observedSseHeaders[0]['x-rokbot-client'], 'android-native/1.26.0');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => sseServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function resolveTrackAXapkPath() {
  if (process.env.ROKBOT_ANDROID_TEST_XAPK !== undefined) {
    const envPath = process.env.ROKBOT_ANDROID_TEST_XAPK.trim();
    return envPath && fs.existsSync(envPath) ? envPath : null;
  }
  const candidates = [
    path.join(PROJECT_ROOT, 'inputs/android/grok-bot-1.26.0.xapk'),
    '/Volumes/ORICO/grokbot/inputs/android/grok-bot-1.26.0.xapk',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

const TRACK_A_XAPK_PATH = resolveTrackAXapkPath();

test(
  'Track A-HBC: verifies patched LoadTrue/LoadFalse stubs, stampSender, and tail-patched BackendClient.call/callPublic 22 RPCs',
  {
    skip: !TRACK_A_XAPK_PATH &&
      'Official grok-bot-1.26.0.xapk not found; set ROKBOT_ANDROID_TEST_XAPK or place in inputs/android/',
  },
  () => {
  // Track A is a pinned 1.26.0 (3212) HBC regression: every byte offset, function id and string
  // id below is specific to the 1.26.0 bundle it patches, so load that bundle's recipe explicitly
  // rather than the version-default, which now resolves to 1.27.0 (3283) via manifest.build.
  const realMeta = loadGatewayTemplateMetadata(path.join(NATIVE_ROOT, 'recipes/gateway-template.json'));
  assert.equal(realMeta.bodyOffset, 38303476);
  assert.equal(realMeta.bodyCapacity, 24600);
  assert.equal(realMeta.bodyLengthOffset, 38328844);

  const tplJsonRaw = fs.readFileSync(path.join(NATIVE_ROOT, 'recipes/gateway-template.json'));
  const tplJsonGbp = loadBytepatchRecipe(path.join(NATIVE_ROOT, 'recipes/gateway-template.json.gbp.gz'));
  const xapkPath = TRACK_A_XAPK_PATH;
  const xapkZip = readZip(fs.readFileSync(xapkPath));
  const baseApkEntry = xapkZip.entries.find(e => e.name === 'ai.x.grok.bot.apk');
  assert.ok(baseApkEntry, 'Base APK entry must exist inside official xapk');
  const baseZip = readZip(entryBytes(baseApkEntry));
  const origBundle = entryBytes(baseZip.entries.find(e => e.name === 'assets/index.android.bundle'));
  assert.equal(crypto.createHash('sha256').update(origBundle).digest('hex'), realMeta.originalSha256);

  // Decompress gateway-template.json.gbp.gz recipe cleanly matches gateway-template.json
  const tplMetaFromGbp = loadGatewayTemplateMetadata(path.join(NATIVE_ROOT, 'recipes/gateway-template.json'));
  assert.equal(tplJsonGbp.targetSha256, crypto.createHash('sha256').update(tplJsonRaw).digest('hex'));
  assert.equal(tplMetaFromGbp.templateSha256, realMeta.templateSha256);
  const rawGbpJsonGz = JSON.parse(gunzipSync(fs.readFileSync(path.join(NATIVE_ROOT, 'recipes/gateway-template.json.gbp.gz'))).toString('utf8'));
  assert.equal(rawGbpJsonGz.schema, 'rokbot-bytepatch/v1');

  const unpairedRes = patchHermesBundleSafely(origBundle);
  assert.equal(unpairedRes.patched, true);
  assert.equal(unpairedRes.mode, 'bytepatch-unpaired');

  const pairedRes = patchHermesBundleSafely(origBundle, { host: 'http://127.0.0.1:18080', token: 'tok-abc' });
  assert.equal(pairedRes.patched, true);
  assert.equal(pairedRes.mode, 'bytepatch-hbc-synthesized');
  assert.equal(pairedRes.buffer.readUInt32LE(32), pairedRes.buffer.length);
  const expectedFooter = crypto.createHash('sha1').update(pairedRes.buffer.subarray(0, pairedRes.buffer.length - 20)).digest();
  assert.ok(pairedRes.buffer.subarray(pairedRes.buffer.length - 20).equals(expectedFooter), 'Synthesized HBC SHA-1 footer must be valid');

  const readFnHeader = (buf, fid) => {
    const fhOff = 128 + fid * 12;
    const w0 = buf.readUInt32LE(fhOff);
    const w1 = buf.readUInt32LE(fhOff + 4);
    const w2 = buf.readUInt32LE(fhOff + 8);
    if ((w2 >>> 29) & 1) {
      const lo = (((w1 << 10) & 0xff000000) >>> 0) + (w0 & 0x1ffffff);
      return {
        overflow: true,
        lo,
        bcOff: buf.readUInt32LE(lo),
        paramCount: buf.readUInt32LE(lo + 4),
        bcSz: buf.readUInt32LE(lo + 12),
        frameSize: buf.readUInt32LE(lo + 28),
        readCache: buf.readUInt32LE(lo + 32) & 0xff,
      };
    }
    return { overflow: false, lo: 0, bcOff: w0 & 0x1ffffff, bcSz: w1 & 0x3fff };
  };

  for (const buf of [unpairedRes.buffer, pairedRes.buffer]) {
    // SettingsSheet +453: the recipe writes LoadTrue r14 x2 (95 0e 95 0e, showsDebugTools); since
    // rokbot.3 applyConnectionEntry turns it into LoadConstFalse r14 x2 (no header bug button).
    assert.deepEqual([...buf.subarray(0x1d8a0da, 0x1d8a0de)], [0x96, 0x0e, 0x96, 0x0e]);
    // BrowserSignInScreen +331 -> LoadFalse r7; LoadFalse r7 (96 07 96 07)
    assert.deepEqual([...buf.subarray(0x1b00b06, 0x1b00b0a)], [0x96, 0x07, 0x96, 0x07]);
    // isStatsigDisabled -> LoadTrue r0; Ret r0
    const fnStatsig = readFnHeader(buf, 18544);
    assert.deepEqual([...buf.subarray(fnStatsig.bcOff, fnStatsig.bcOff + 4)], [0x95, 0x00, 0x76, 0x00]);
    // canRecord, shouldFetch, sandStatsigNetworkUrlAllowed -> LoadFalse r0; Ret r0
    for (const fid of [16597, 18563, 18637]) {
      const fh = readFnHeader(buf, fid);
      assert.deepEqual([...buf.subarray(fh.bcOff, fh.bcOff + 4)], [0x96, 0x00, 0x76, 0x00], `fn[${fid}] must return LoadFalse`);
    }
    // BackendAnalyticsSink.send & OnePasswordAppPresence.lookUp -> Promise.resolve(false) (LoadFalse r0 at +13..+14)
    for (const fid of [16781, 30362]) {
      const fh = readFnHeader(buf, fid);
      assert.deepEqual([...buf.subarray(fh.bcOff + 13, fh.bcOff + 15)], [0x96, 0x00], `fn[${fid}] Promise.resolve argument must be LoadFalse (0x96)`);
    }
  }

  // stampSender (fn[29554], bc=0x19314d7) patched to LoadConstUndefined; Ret ONLY in gateway-template
  assert.deepEqual([...pairedRes.buffer.subarray(0x19314d7, 0x19314db)], [0x93, 0x00, 0x76, 0x00]);
  assert.notDeepEqual([...unpairedRes.buffer.subarray(0x19314d7, 0x19314db)], [0x93, 0x00, 0x76, 0x00]);

  // Tail-patched BackendClient.call (fn[26618]) & callPublic (fn[26620]) strictly after bodyEnd = 0x248d70c
  const bodyEnd = realMeta.bodyOffset + realMeta.bodyCapacity;
  assert.equal(bodyEnd, 0x248d70c);
  const expectedSids = [
    8322, 6128, 8309, 8313, 8314, 87633, 96042, 95969, 89137, 67947, 95958,
    95997, 95976, 80996, 90079, 77443, 95986, 95956, 6442, 75196, 96013, 96069,
  ];
  for (const fid of [26618, 26620]) {
    const fn = readFnHeader(pairedRes.buffer, fid);
    assert.equal(fn.overflow, true, `fn[${fid}] must use LargeFuncHeader`);
    assert.ok(fn.bcOff >= bodyEnd, `fn[${fid}] bytecode must sit >= 0x248d70c`);
    if (fid === 26618) assert.ok(fn.lo >= bodyEnd, 'LFH[26618] must sit >= 0x248d70c');
    else assert.equal(fn.lo, 0x2253f38);
    assert.equal(fn.bcSz, 360);
    assert.equal(fn.readCache, 2);
    const code = pairedRes.buffer.subarray(fn.bcOff, fn.bcOff + fn.bcSz);
    let pos = 3; // after LoadParam r0, 1
    const seenSids = [];
    for (let i = 0; i < 22; i++) {
      const op = code[pos];
      if (op === 144) {
        seenSids.push(code.readUInt16LE(pos + 2));
        pos += 4;
      } else {
        assert.equal(op, 145);
        seenSids.push(code.readUInt32LE(pos + 2));
        pos += 6;
      }
      assert.equal(code[pos], 212, `fn[${fid}] RPC check #${i} must use JStrictEqualLong (212)`);
      assert.equal(pos + code.readInt32LE(pos + 1), 309, `fn[${fid}] JStrictEqualLong must jump to bypass@309`);
      pos += 7;
    }
    assert.deepEqual(seenSids, expectedSids);
    assert.equal(code[code.length - 1], 0x00);
    assert.equal(code[code.length - 2], 0x76); // Ret r0 at end of 51B bypass
  }

  // Regression: 40-byte LargeFuncHeaders (fn[23394] DevGatewayOverride.read & fn[26618] BackendClient.call)
  // must sit strictly before the 20-byte SHA-1 footer and never overlap fn[26620] bytecode or clear flags to ProhibitCall (0).
  const sha1Offset = pairedRes.buffer.length - 20;
  const fn26620 = readFnHeader(pairedRes.buffer, 26620);
  for (const fid of [23394, 26618]) {
    const fn = readFnHeader(pairedRes.buffer, fid);
    assert.equal(fn.overflow, true, `fn[${fid}] must use LargeFuncHeader`);
    assert.ok(fn.lo + 40 <= sha1Offset, `LFH[${fid}] 40B header must not overlap SHA-1 footer`);
    assert.ok(
      fn.lo + 40 <= fn26620.bcOff || fn.lo >= fn26620.bcOff + fn26620.bcSz,
      `LFH[${fid}] 40B header must not overlap fn[26620] bytecode`
    );
    assert.notEqual(
      pairedRes.buffer.readUInt32LE(fn.lo + 36) & 3,
      0,
      `LFH[${fid}] prohibitInvoke must not be ProhibitCall (0)`
    );
  }
});

test('Track C-Host-Connectors: real Connectors/Plugins/ConnectorStore permissions, BLOCKED isolation, includeDisabled list-tools, and UpdateUserPluginInstall', async () => {
  const { Connectors, Plugins, Skills } = await loadHostConnectorModules();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-host-conn-'));
  const connectors = new Connectors(dataDir);
  const skills = new Skills(dataDir);
  const plugins = new Plugins(dataDir, { connectors, skills, hostCall: async () => { throw new Error('unused'); } });
  try {
    await connectors.load();
    await skills.load();
    await plugins.load();

    // Stub pluginClient for ListSandMcpTools without launching subprocess
    plugins.client = async () => ({
      listTools: async () => ({
        tools: [
          { name: 'echo', description: 'Echo text', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'write_note', description: 'Write note', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
        ],
      }),
      close: async () => {},
    });

    await plugins.publish({
      schemaVersion: 1,
      kind: 'rokbot-app',
      id: 'conn-plugin',
      version: '1.0.0',
      name: 'Conn Plugin',
      description: 'Test stdio plugin',
      publisher: 'Test',
      license: 'MIT',
      runtime: { kind: 'node-stdio', entry: 'index.mjs' },
      auth: { type: 'bearer' },
      configuration: [{ key: 'WORKSPACE_DIR', name: 'Workspace Dir', required: true, secret: false }],
      files: [{ path: 'index.mjs', encoding: 'utf8', content: 'export default {};\n' }],
    });
    await plugins.update('conn-plugin', { enabled: true });

    await connectors.mobile('InstallUserPlugin', {
      pluginId: 'conn-plugin',
      variables: { secret: 'secret-token-1', WORKSPACE_DIR: '/tmp/ws-one' },
    }, 'http://127.0.0.1', 'test-actor');

    // Editing non-secret pluginFields via UpdateUserPluginInstall (even with synthetic secret: '') must update WORKSPACE_DIR & keep existing credential!
    await connectors.mobile('UpdateUserPluginInstall', {
      pluginId: 'conn-plugin',
      variables: { WORKSPACE_DIR: '/tmp/ws-two', secret: '' },
    }, 'http://127.0.0.1', 'test-actor');
    const pluginRow = connectors.resolve('conn-plugin');
    assert.deepEqual(connectors.store.unseal(pluginRow.credential), { secret: 'secret-token-1' });
    assert.equal(connectors.store.unseal(pluginRow.pluginConfiguration).WORKSPACE_DIR, '/tmp/ws-two');

    const avail = await connectors.mobile('GetAvailableMcpServers', {}, 'http://127.0.0.1', 'test-actor');
    assert.equal(avail.servers.length, 1);
    assert.equal(avail.servers[0].servedBy, 'MCP_SERVED_BY_USER');
    assert.equal(avail.servers[0].hasStaticCredentialHeaders, true);

    // Permissions: allow -> block -> verifies BLOCKED only lives in disabledTools and NEVER in policy.tools
    const set1 = await connectors.mobile('SetGrokBotMcpToolPermissions', {
      serverId: String(avail.servers[0].id),
      tools: {
        echo: 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW',
        write_note: 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL',
      },
      reads: 'ALWAYS_ALLOW',
      writes: 'NEEDS_APPROVAL',
    }, 'http://127.0.0.1', 'test-actor');
    assert.deepEqual(set1.server.disabledTools, []);
    assert.equal(set1.server.policy.tools.echo, 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW');
    assert.equal(set1.server.policy.tools.write_note, 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL');
    assert.equal(set1.server.policy.reads, 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW');
    assert.equal(set1.server.policy.writes, 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL');

    const set2 = await connectors.mobile('SetGrokBotMcpToolPermissions', {
      serverId: String(avail.servers[0].id),
      tools: { echo: 'GROK_BOT_TOOL_PERMISSION_BLOCKED' },
    }, 'http://127.0.0.1', 'test-actor');
    assert.deepEqual(set2.server.disabledTools, ['echo']);
    assert.equal('echo' in set2.server.policy.tools, false);
    assert.equal(set2.server.policy.tools.write_note, 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL');

    const perms = await connectors.mobile('GetGrokBotMcpToolPermissions', {}, 'http://127.0.0.1', 'test-actor');
    assert.equal(perms.servers.length, 1);
    assert.deepEqual(perms.servers[0].disabledTools, ['echo']);
    assert.equal('echo' in perms.servers[0].policy.tools, false);

    // ListSandMcpTools must still include blocked 'echo' (includeDisabled: true) + annotationsJson,
    // while default internal('list-tools') omits blocked tools for LLM execution.
    const mobileTools = await connectors.mobile('ListSandMcpTools', {}, 'http://127.0.0.1', 'test-actor');
    assert.deepEqual(mobileTools.servers[0].tools.map(t => t.toolName), ['echo', 'write_note']);
    assert.equal(mobileTools.servers[0].tools[0].annotationsJson, JSON.stringify({ readOnlyHint: true }));

    const llmTools = await connectors.internal('list-tools', { identifiers: ['host-conn-plugin'] });
    assert.deepEqual(llmTools[0].tools.map(t => t.toolName), ['write_note']);

    // validateConnector via applyConnector preserves toolPolicy & store.public(row) strips toolPolicy
    await plugins.applyConnector(plugins.item('conn-plugin'), true);
    const updatedRow = connectors.resolve('conn-plugin');
    assert.equal(updatedRow.toolPolicy.tools.write_note, 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL');
    const pub = connectors.store.public(updatedRow);
    assert.equal('toolPolicy' in pub, false);

    // toggleMcpToolDisabled removes stale allow/approval entry from toolPolicy.tools
    await connectors.mobile('ListSandMcpTools', {}, 'http://127.0.0.1', 'test-actor');
    await connectors.original('toggleMcpToolDisabled', { serverId: 'conn-plugin', toolName: 'write_note' }, 'http://127.0.0.1', 'test-actor');
    const afterToggle = connectors.resolve('conn-plugin');
    assert.ok(afterToggle.disabledTools.includes('write_note'));
    assert.equal('write_note' in afterToggle.toolPolicy.tools, false);

    // Marketplace & popularity RPC stubs
    const pubListings = await connectors.mobile('ListPublicGrokBotMarketplaceListings', {}, 'http://127.0.0.1', 'test-actor');
    assert.deepEqual(pubListings, { featuredListings: [], listings: [], allCategoriesOrder: [], nextPageToken: '' });
    const popularity = await connectors.mobile('GetTeamPluginPopularity', {}, 'http://127.0.0.1', 'test-actor');
    assert.deepEqual(popularity, { counts: [] });
  } finally {
    await connectors.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Track C-MockHost-Connectors: MockHostServer exposes servedBy, annotationsJson, tool permissions, UpdateUserPluginInstall, marketplace & popularity', async () => {
  const host = new MockHostServer({ port: 0, pairingKey: 'K7M9P2', realHostProtocol: true });
  await host.start();
  try {
    const pair = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'ConnPhone', platform: 'desktop', clientKind: 'android', pairingKey: 'K7M9P2' }),
    }).then(r => r.json());
    assert.ok(pair.token, `Pairing must return token: ${JSON.stringify(pair)}`);
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${pair.token}` };
    const rpc = (method, body = {}) =>
      fetch(`${host.origin}/local/mobile-rpc/${method}`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then(r => r.json());

    const catalog = await rpc('ListMarketplacePlugins');
    const pluginId = catalog.plugins[0].id;
    await rpc('InstallUserPlugin', { pluginId, variables: { secret: 'mock-secret-1' } });
    await rpc('UpdateUserPluginInstall', { pluginId, variables: { workspace: '/tmp/ws' } });
    assert.equal(host.connectors[0].credential, 'mock-secret-1');

    const avail = await rpc('GetAvailableMcpServers');
    assert.equal(avail.servers[0].servedBy, 'MCP_SERVED_BY_USER');
    assert.equal(avail.servers[0].hasStaticCredentialHeaders, true);

    await rpc('SetGrokBotMcpToolPermissions', {
      serverId: String(avail.servers[0].id),
      tools: { echo: 'GROK_BOT_TOOL_PERMISSION_BLOCKED', write_note: 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW' },
      reads: 'ALWAYS_ALLOW',
    });
    const perms = await rpc('GetGrokBotMcpToolPermissions');
    assert.deepEqual(perms.servers[0].disabledTools, ['echo']);
    assert.equal('echo' in perms.servers[0].policy.tools, false);
    assert.equal(perms.servers[0].policy.tools.write_note, 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW');
    assert.equal(perms.servers[0].policy.reads, 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW');

    const listedBefore = await rpc('ListSandMcpTools');
    assert.deepEqual(listedBefore.servers[0].tools.map(t => t.toolName), ['echo', 'write_note']);
    assert.equal(listedBefore.servers[0].tools[0].annotationsJson, JSON.stringify({ readOnlyHint: true }));

    // Uninstalled index-0 + installed auth=none index-1 without numericId must preserve serverId='1002'
    host.connectors[0].installed = false;
    host.connectors.push({
      id: 'conn-open',
      name: 'Open MCP',
      displayName: 'Open MCP',
      installed: true,
      enabled: true,
      auth: { type: 'none' },
      credential: null,
      url: 'http://127.0.0.1:9998/mcp',
      disabledTools: [],
      toolPolicy: { tools: {} },
      tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
    });
    const availSparse = await rpc('GetAvailableMcpServers');
    assert.equal(availSparse.servers.length, 1);
    assert.equal(availSparse.servers[0].id, 1002);
    assert.equal(availSparse.servers[0].hasStaticCredentialHeaders, true);
    assert.equal(availSparse.servers[0].userHasAccessToken, true);
    const permsSparse = await rpc('GetGrokBotMcpToolPermissions');
    assert.equal(permsSparse.servers[0].serverId, '1002');
    const setSparse = await rpc('SetGrokBotMcpToolPermissions', { serverId: '1002', tools: { ping: 'ALWAYS_ALLOW' } });
    assert.equal(setSparse.server.serverId, '1002');
    const badRes = await fetch(`${host.origin}/local/mobile-rpc/SetGrokBotMcpToolPermissions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ serverId: '1002', tools: { ping: 'BOGUS_PERM' } }),
    });
    assert.equal(badRes.status, 400);

    const listed = await rpc('ListSandMcpTools');
    assert.deepEqual(listed.servers[0].tools.map(t => t.toolName), ['ping']);

    assert.deepEqual(await rpc('ListPublicGrokBotMarketplaceListings'), {
      featuredListings: [], listings: [], allCategoriesOrder: [], nextPageToken: '',
    });
    assert.deepEqual(await rpc('GetTeamPluginPopularity'), { counts: [] });
  } finally {
    await host.stop();
  }
});

test('M1.4.2-Logo: replaces res/mipmap-*-v4/*.webp in-place and inserts missing mipmap-*.png icons with valid APK signature', async () => {
  const logoDir = path.join(PROJECT_ROOT, 'assets/logo/android');
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  const kinds = ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground'];
  for (const d of densities) {
    for (const k of kinds) {
      assert.ok(fs.existsSync(path.join(logoDir, `mipmap-${d}`, `${k}.png`)), `Missing RokBot icon asset mipmap-${d}/${k}.png`);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-logo-wiring-'));
  try {
    const baseApk = path.join(NATIVE_ROOT, 'bin/rokbot-native-base.apk');
    const baseZip = readZip(fs.readFileSync(baseApk));

    // Seed 6 existing -v4/*.webp entries (like official 1.16.0 APK), leave the other 9 absent,
    // and seed adaptive icon XMLs (with old @color/iconBackground + <monochrome>)
    const makeAdaptiveXml = () => serializeAxml({
      namespaces: [{ prefix: 'android', uri: ANDROID_NS, lineNumber: 2 }],
      rootNodes: [{
        type: 'element',
        name: 'adaptive-icon',
        namespace: null,
        lineNumber: 2,
        attributes: [],
        children: [
          {
            type: 'element',
            name: 'background',
            namespace: null,
            lineNumber: 3,
            attributes: [{
              name: 'drawable',
              namespace: ANDROID_NS,
              resourceId: KNOWN_RES_IDS.drawable,
              type: 0x01,
              rawValue: null,
              value: 0x7f06009f,
              data: 0x7f06009f,
            }],
            children: [],
          },
          {
            type: 'element',
            name: 'foreground',
            namespace: null,
            lineNumber: 4,
            attributes: [{
              name: 'drawable',
              namespace: ANDROID_NS,
              resourceId: KNOWN_RES_IDS.drawable,
              type: 0x01,
              rawValue: null,
              value: 0x7f100001,
              data: 0x7f100001,
            }],
            children: [],
          },
          {
            type: 'element',
            name: 'monochrome',
            namespace: null,
            lineNumber: 5,
            attributes: [{
              name: 'drawable',
              namespace: ANDROID_NS,
              resourceId: KNOWN_RES_IDS.drawable,
              type: 0x01,
              rawValue: null,
              value: 0x7f080001,
              data: 0x7f080001,
            }],
            children: [],
          },
        ],
      }],
    });

    const preseededEntries = [
      ...baseZip.entries,
      createEntry('res/mipmap-mdpi-v4/ic_launcher.webp', Buffer.from('OLD_MDPI_LAUNCHER')),
      createEntry('res/mipmap-hdpi-v4/ic_launcher_round.webp', Buffer.from('OLD_HDPI_ROUND')),
      createEntry('res/mipmap-xhdpi-v4/ic_launcher_foreground.webp', Buffer.from('OLD_XHDPI_FG')),
      createEntry('res/mipmap-xxhdpi-v4/ic_launcher.webp', Buffer.from('OLD_XXHDPI_LAUNCHER')),
      createEntry('res/mipmap-xxxhdpi-v4/ic_launcher.webp', Buffer.from('OLD_XXXHDPI_LAUNCHER')),
      createEntry('res/mipmap-xxxhdpi-v4/ic_launcher_round.webp', Buffer.from('OLD_XXXHDPI_ROUND')),
      createEntry('res/mipmap-anydpi-v26/ic_launcher.xml', makeAdaptiveXml()),
      createEntry('res/mipmap-anydpi-v26/ic_launcher_round.xml', makeAdaptiveXml()),
    ];
    const inApk = path.join(tmpDir, 'with-partial-mipmaps.apk');
    const outApk = path.join(tmpDir, 'patched-with-logo.apk');
    const keystore = path.join(tmpDir, 'signing.json');
    fs.writeFileSync(inApk, writeZip(preseededEntries));

    const report = await runPatchPipeline({
      inputApk: inApk,
      outputApk: outApk,
      keystore,
      devSigning: true,
      force: true,
    });
    assert.equal(report.schema, 'rokbot-android-patch-report/v1');
    assert.equal(report.launcherIconsReplaced, 6);
    assert.equal(report.launcherIconsInserted, 9);
    assert.equal(report.adaptiveIconsPatched, 2);

    const outBytes = fs.readFileSync(outApk);
    const sigCheck = verifyApk(outBytes);
    assert.equal(sigCheck.verified, true, 'Patched APK with replaced/inserted RokBot icons must pass v2/v3 signature verification');
    assert.equal(sigCheck.hasV2, true);
    assert.equal(sigCheck.hasV3, true);

    const outZip = readZip(outBytes);
    const byName = new Map(outZip.entries.map(e => [e.name, e]));
    const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

    // Verify application android:label="RokBot"
    const manifestAst = parseAxml(entryBytes(byName.get('AndroidManifest.xml')));
    const appEl = manifestAst.rootNodes.find(n => n.name === 'manifest')?.children?.find(c => c.name === 'application');
    assert.equal(getAndroidAttr(appEl, 'label')?.value, 'RokBot', 'Patched manifest must set application android:label=RokBot');

    // Verify adaptive icon XMLs keep their original @color background reference (an inline color literal
    // makes Pixel Launcher fall back to the generic icon) and have zero <monochrome>
    for (const xmlPath of ['res/mipmap-anydpi-v26/ic_launcher.xml', 'res/mipmap-anydpi-v26/ic_launcher_round.xml']) {
      assert.ok(byName.has(xmlPath), `Adaptive icon XML must remain present: ${xmlPath}`);
      const xmlAst = parseAxml(entryBytes(byName.get(xmlPath)));
      const adaptiveRoot = xmlAst.rootNodes.find(n => n.name === 'adaptive-icon');
      assert.ok(adaptiveRoot, `${xmlPath} must have <adaptive-icon> root`);
      assert.equal(adaptiveRoot.children.some(c => c.name === 'monochrome'), false, `${xmlPath} must strip <monochrome>`);
      const bgNode = adaptiveRoot.children.find(c => c.name === 'background');
      const bgAttr = getAndroidAttr(bgNode, 'drawable');
      assert.equal(bgAttr?.type, 0x01, `${xmlPath} background drawable must stay a resource reference`);
      assert.equal(bgAttr?.data >>> 0, 0x7f06009f, `${xmlPath} background must keep @color/iconBackground`);
    }

    // Verify all 6 preseeded -v4/*.webp entries kept their exact entry paths & matched RokBot PNG SHA-256
    const replacedMap = [
      ['res/mipmap-mdpi-v4/ic_launcher.webp', 'mdpi', 'ic_launcher'],
      ['res/mipmap-hdpi-v4/ic_launcher_round.webp', 'hdpi', 'ic_launcher_round'],
      ['res/mipmap-xhdpi-v4/ic_launcher_foreground.webp', 'xhdpi', 'ic_launcher_foreground'],
      ['res/mipmap-xxhdpi-v4/ic_launcher.webp', 'xxhdpi', 'ic_launcher'],
      ['res/mipmap-xxxhdpi-v4/ic_launcher.webp', 'xxxhdpi', 'ic_launcher'],
      ['res/mipmap-xxxhdpi-v4/ic_launcher_round.webp', 'xxxhdpi', 'ic_launcher_round'],
    ];
    for (const [entryPath, d, k] of replacedMap) {
      assert.ok(byName.has(entryPath), `Replaced entry path must be preserved: ${entryPath}`);
      const expected = fs.readFileSync(path.join(logoDir, `mipmap-${d}`, `${k}.png`));
      assert.equal(sha(entryBytes(byName.get(entryPath))), sha(expected), `SHA-256 mismatch for replaced ${entryPath}`);
    }

    // Verify remaining 9 absent icons were inserted at res/mipmap-<density>/<kind>.png
    const replacedSet = new Set(replacedMap.map(([, d, k]) => `${d}:${k}`));
    for (const d of densities) {
      for (const k of kinds) {
        if (replacedSet.has(`${d}:${k}`)) continue;
        const insertedPath = `res/mipmap-${d}/${k}.png`;
        assert.ok(byName.has(insertedPath), `Missing icon should be inserted at ${insertedPath}`);
        const expected = fs.readFileSync(path.join(logoDir, `mipmap-${d}`, `${k}.png`));
        assert.equal(sha(entryBytes(byName.get(insertedPath))), sha(expected), `SHA-256 mismatch for inserted ${insertedPath}`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test(
  'M4-Real-XAPK: patches grok-bot-1.26.0.xapk with adaptive icons, RokBot label, ModelsActivity, apksigner & zipalign',
  {
    skip: !TRACK_A_XAPK_PATH &&
      'Official grok-bot-1.26.0.xapk not found; set ROKBOT_ANDROID_TEST_XAPK or place in inputs/android/',
  },
  async () => {
    const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
      .find(d => d && fs.existsSync(path.join(d, 'build-tools/36.0.0/apksigner')) && fs.existsSync(path.join(d, 'build-tools/36.0.0/zipalign')));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-m4-real-xapk-'));
    try {
      const outApk = path.join(tmpDir, 'rokbot-real-patched.apk');
      const keystore = path.join(tmpDir, 'signing.json');
      const report = await runPatchPipeline({
        inputApk: TRACK_A_XAPK_PATH,
        outputApk: outApk,
        packageName: 'dev.rokbot.nativeapp',
        host: 'http://127.0.0.1:18080',
        pairingCode: 'K7M9P2',
        keystore,
        devSigning: true,
        force: true,
      });

      assert.equal(report.pinMatched, true);
      assert.equal(report.bundlePatched, true);
      assert.equal(report.launcherIconsReplaced, 15);
      assert.equal(report.launcherIconsInserted, 0);
      assert.equal(report.adaptiveIconsPatched, 2);
      assert.equal(report.iconBackgroundPatched, 1, '@color/iconBackground recolored for the white-tile logo');

      const outBytes = fs.readFileSync(outApk);
      const v = verifyApk(outBytes);
      assert.equal(v.verified, true);
      assert.equal(v.hasV2, true);
      assert.equal(v.hasV3, true);

      const outZip = readZip(outBytes);
      const byName = new Map(outZip.entries.map(e => [e.name, e]));
      const arscBytes = entryBytes(byName.get('resources.arsc'));
      const fgId = findMipmapResourceId(arscBytes, 'ic_launcher_foreground');
      assert.equal(fgId, 0x7f100001, 'resources.arsc mipmap/ic_launcher_foreground must resolve to 0x7f100001');
      // Re-applying the background color is a byte-for-byte no-op: the shipped value already is it.
      const again = setColorResourceValue(arscBytes, 'iconBackground', ANDROID_ICON_BACKGROUND_ARGB);
      assert.equal(again.patched, 1);
      assert.equal(Buffer.compare(again.buffer, arscBytes), 0, 'patched resources.arsc must carry the light iconBackground');
      assert.equal(byName.get('resources.arsc').method, 0, 'resources.arsc stays stored');

      // Verify manifest contains ModelsActivity, ApkUpdateProvider, BootReceiver, and label="RokBot"
      const manifestAst = parseAxml(entryBytes(byName.get('AndroidManifest.xml')));
      const manifestNode = manifestAst.rootNodes.find(n => n.name === 'manifest');
      const appNode = manifestNode.children.find(c => c.name === 'application');
      assert.equal(getAndroidAttr(appNode, 'label')?.value, 'RokBot');
      assert.ok(appNode.children.some(c => c.name === 'activity' && getAndroidAttr(c, 'name')?.value === 'dev.rokbot.nativeapp.ModelsActivity'));
      assert.ok(appNode.children.some(c => c.name === 'provider' && getAndroidAttr(c, 'name')?.value === 'dev.rokbot.nativeapp.ApkUpdateProvider'));
      assert.ok(appNode.children.some(c => c.name === 'receiver' && getAndroidAttr(c, 'name')?.value === 'dev.rokbot.nativeapp.BootReceiver'));

      // Verify all 15 mipmap entries have PNG magic and match assets/logo/android/
      const logoDir = path.join(PROJECT_ROOT, 'assets/logo/android');
      const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
      for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
        for (const k of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
          const entry = byName.get(`res/mipmap-${d}-v4/${k}.webp`);
          assert.ok(entry, `Missing mipmap entry res/mipmap-${d}-v4/${k}.webp`);
          const bytes = entryBytes(entry);
          assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'Replaced icon must have PNG magic');
          const expected = fs.readFileSync(path.join(logoDir, `mipmap-${d}`, `${k}.png`));
          assert.equal(sha(bytes), sha(expected));
        }
      }

      // Verify adaptive icon XMLs
      for (const xmlPath of ['res/mipmap-anydpi-v26/ic_launcher.xml', 'res/mipmap-anydpi-v26/ic_launcher_round.xml']) {
        const xmlAst = parseAxml(entryBytes(byName.get(xmlPath)));
        const adaptiveRoot = xmlAst.rootNodes.find(n => n.name === 'adaptive-icon');
        assert.ok(adaptiveRoot);
        assert.equal(adaptiveRoot.children.some(c => c.name === 'monochrome'), false);
        const bgAttr = getAndroidAttr(adaptiveRoot.children.find(c => c.name === 'background'), 'drawable');
        const fgAttr = getAndroidAttr(adaptiveRoot.children.find(c => c.name === 'foreground'), 'drawable');
        assert.equal(bgAttr?.type, 0x01);
        assert.equal(bgAttr?.data >>> 0, 0x7f0600a2);
        assert.equal(fgAttr?.type, 0x01);
        assert.equal(fgAttr?.data >>> 0, 0x7f100001);
      }

      if (sdkRoot) {
        cp.execFileSync(path.join(sdkRoot, 'build-tools/36.0.0/apksigner'), [
          'verify', '-v', '--min-sdk-version', '28', '--max-sdk-version', '35', outApk,
        ], { stdio: 'pipe' });
        cp.execFileSync(path.join(sdkRoot, 'build-tools/36.0.0/zipalign'), [
          '-c', '-v', '-P', '16', '4', outApk,
        ], { stdio: 'pipe' });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

test('M1.6-Rebrand: replaces splash/notification drawables, rebrands app.config name while preserving grokbot scheme, and uses RokBot notification small icons', async () => {
  const { patchLauncherIcons } = await import('../release/patch-android.mjs');
  const { suppressExpoUpdates } = await import('../patchers/hermes.mjs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const logoDir = path.resolve(repoRoot, 'assets/logo/android');

  // 1. Splash, bootsplash, and notification drawables are replaced with RokBot assets
  const entries = [
    createEntry('res/drawable-xxhdpi-v4/splashscreen_logo.png', Buffer.from('OLD_SPLASH')),
    createEntry('res/drawable/bootsplash_logo.png', Buffer.from('OLD_BOOTSPLASH')),
    createEntry('res/drawable-xhdpi/notification_icon.png', Buffer.from('OLD_NOTIF_ICON')),
    createEntry('res/drawable/rn_edit_text_material.xml', Buffer.from('<inset/>')),
  ];
  const res = patchLauncherIcons(entries, logoDir);
  assert.equal(res.brandDrawablesReplaced, 3);
  const byName = new Map(res.entries.map(e => [e.name, e]));
  // The system splash icon is the launch-mark-sized tile (animated WebP, see android-splash.test.mjs);
  // with no resources.arsc in this list there is nothing to rename, so the entry keeps its name.
  assert.deepEqual(
    entryBytes(byName.get('res/drawable-xxhdpi-v4/splashscreen_logo.png')),
    fs.readFileSync(path.join(logoDir, 'splash/splashscreen_logo-xxxhdpi.webp'))
  );
  assert.deepEqual(
    entryBytes(byName.get('res/drawable/bootsplash_logo.png')),
    fs.readFileSync(path.join(logoDir, 'mipmap-xxhdpi/ic_launcher_foreground.png'))
  );
  assert.deepEqual(
    entryBytes(byName.get('res/drawable-xhdpi/notification_icon.png')),
    fs.readFileSync(path.join(logoDir, 'mipmap-xhdpi/ic_launcher_foreground.png'))
  );
  assert.equal(entryBytes(byName.get('res/drawable/rn_edit_text_material.xml')).toString('utf8'), '<inset/>');

  // 2. Expo app.config rebrands display name without breaking Category-B grokbot:// scheme
  const rebrandedCfg = suppressExpoUpdates({
    name: 'Grok Bot',
    scheme: 'grokbot',
    extra: { expoClient: { name: 'Grok Bot' } },
    updates: { enabled: true, url: 'https://u.expo.dev/test' },
  });
  assert.equal(rebrandedCfg.name, 'RokBot');
  assert.equal(rebrandedCfg.extra.expoClient.name, 'RokBot');
  assert.equal(rebrandedCfg.scheme, 'grokbot');
  assert.equal(rebrandedCfg.updates.enabled, false);

  // 3. Companion notification services must not use generic android.R.drawable.* small icons,
  // and compiled classes2.dex must contain the rebuilt RokBot notification icon helper.
  const notifJava = fs.readFileSync(
    path.resolve(repoRoot, 'android/companion/src/main/java/dev/rokbot/nativeapp/NotificationService.java'),
    'utf8'
  );
  const voiceJava = fs.readFileSync(
    path.resolve(repoRoot, 'android/companion/src/main/java/dev/rokbot/nativeapp/VoiceCallService.java'),
    'utf8'
  );
  assert.equal(/android\.R\.drawable\.(?:ic_dialog_info|ic_dialog_alert)/.test(notifJava), false);
  assert.equal(/android\.R\.drawable\.ic_btn_speak_now/.test(voiceJava), false);
  assert.ok(notifJava.includes('applySmallIcon('));
  assert.ok(voiceJava.includes('NotificationService.applySmallIcon('));

  const dexBuf = fs.readFileSync(path.resolve(repoRoot, 'android/bin/classes2.dex'));
  assert.ok(dexBuf.includes(Buffer.from('rokbot_notification_icon')));
});




