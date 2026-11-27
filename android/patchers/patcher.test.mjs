// Unit Verification Suite for Android Native Patch Engine.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAxml, serializeAxml, patchManifest, KNOWN_RES_IDS, ANDROID_NS } from './manifest.mjs';
import { injectCompanionDex, getNextDexName, loadDefaultCompanionDex, neutralizePairipAndHookOkHttp } from './dex.mjs';
import { parseDexIndex, updateDexHashes, R8_OKHTTP_FACTORIES } from './pairip-dex.mjs';
import { synthesizeHermesBytecode, loadGatewayTemplateMetadata, suppressExpoUpdates } from './hermes.mjs';
import {
  createEntry,
  writeZip,
  readZip,
  entryBytes,
  createSigningIdentity,
  signApk,
  verifyApk,
  findEnd
} from './signing.mjs';
import { runPatchPipeline } from '../release/patch-android.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_APK = path.join(REPO_ROOT, 'android/bin/rokbot-native-base.apk');

test('AXML: parse and round-trip serialize AndroidManifest.xml', () => {
  const apkBytes = fs.readFileSync(FIXTURE_APK);
  const { entries } = readZip(apkBytes);
  const manifestEntry = entries.find(e => e.name === 'AndroidManifest.xml');
  const originalBytes = entryBytes(manifestEntry);

  const ast = parseAxml(originalBytes);
  assert.ok(ast.rootNodes.length > 0);
  assert.equal(ast.rootNodes[0].name, 'manifest');

  const reSerialized = serializeAxml(ast);
  assert.ok(reSerialized.length > 0);
  const reParsed = parseAxml(reSerialized);
  assert.equal(reParsed.rootNodes[0].name, 'manifest');
});

test('AXML: patchManifest injects usesCleartextTraffic, PairingActivity, NotificationService, and permissions', () => {
  const apkBytes = fs.readFileSync(FIXTURE_APK);
  const { entries } = readZip(apkBytes);
  const originalBytes = entryBytes(entries.find(e => e.name === 'AndroidManifest.xml'));

  const patched = patchManifest(originalBytes, {
    pairingActivity: 'dev.rokbot.nativeapp.PairingActivity',
    notificationService: 'dev.rokbot.nativeapp.NotificationService',
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.RECORD_AUDIO',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.WAKE_LOCK'
    ]
  });

  const parsed = parseAxml(patched);
  const manifest = parsed.rootNodes.find(n => n.name === 'manifest');
  const app = manifest.children.find(n => n.name === 'application');

  // Verify usesCleartextTraffic
  const cleartext = app.attributes.find(a => a.name === 'usesCleartextTraffic');
  assert.ok(cleartext, 'usesCleartextTraffic attribute must exist');
  assert.equal(cleartext.value, true);

  // Android ignores attributes that are out of resource-ID order (live emulator: "Cleartext HTTP traffic
  // not permitted" because usesCleartextTraffic was appended after enableOnBackInvokedCallback).
  const walk = (node) => {
    const ids = (node.attributes || []).map(a => a.resourceId >>> 0).filter(Boolean);
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i - 1] < ids[i], `<${node.name}> attributes must be sorted by resource ID (0x${ids[i - 1].toString(16)} before 0x${ids[i].toString(16)})`);
    }
    const firstPlain = (node.attributes || []).findIndex(a => !a.resourceId);
    if (firstPlain >= 0) {
      assert.ok((node.attributes || []).slice(firstPlain).every(a => !a.resourceId), `<${node.name}> resource-ID attributes must precede plain ones`);
    }
    for (const child of node.children || []) walk(child);
  };
  walk(manifest);
  const cleartextIdx = app.attributes.indexOf(cleartext);
  assert.ok(app.attributes[cleartextIdx - 1].resourceId < KNOWN_RES_IDS.usesCleartextTraffic);
  // Verify PairingActivity
  const hasPairing = app.children.some(
    c => c.name === 'activity' && c.attributes.some(a => a.name === 'name' && a.value === 'dev.rokbot.nativeapp.PairingActivity')
  );
  assert.ok(hasPairing, 'PairingActivity must be registered');

  // Verify NotificationService
  const hasNotif = app.children.some(
    c => c.name === 'service' && c.attributes.some(a => a.name === 'name' && a.value === 'dev.rokbot.nativeapp.NotificationService')
  );
  assert.ok(hasNotif, 'NotificationService must be registered');

  // Verify DATA_SYNC permission
  const hasDataSync = manifest.children.some(
    c => c.name === 'uses-permission' && c.attributes.some(a => a.name === 'name' && a.value === 'android.permission.FOREGROUND_SERVICE_DATA_SYNC')
  );
  assert.ok(hasDataSync, 'FOREGROUND_SERVICE_DATA_SYNC permission must be registered');
});

test('DEX: getNextDexName identifies next index in classes sequence', () => {
  assert.equal(getNextDexName([]), 'classes.dex');
  assert.equal(getNextDexName(['classes.dex']), 'classes2.dex');
  assert.equal(getNextDexName(['classes.dex', 'classes2.dex']), 'classes3.dex');
  assert.equal(getNextDexName(['classes.dex', 'classes2.dex', 'classes3.dex']), 'classes4.dex');
});

test('DEX: injectCompanionDex merges valid companion dex', () => {
  const companionDex = loadDefaultCompanionDex();
  assert.ok(companionDex.length > 0);

  const initialEntries = [
    createEntry('classes.dex', Buffer.from('dex\n035\0header'), { store: false }),
  ];

  const res = injectCompanionDex(initialEntries, companionDex);
  assert.equal(res.injectedName, 'classes2.dex');
  assert.equal(res.entries.length, 2);
  assert.ok(res.entries.some(e => e.name === 'classes2.dex'));
});

function encodeUleb128(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function buildMinimalDex({ classes = [], fields = [], methods = [] }) {
  const stringSet = new Set();
  const typeSet = new Set();
  const protoKeyToSpec = new Map();
  const addType = (t) => { typeSet.add(t); stringSet.add(t); };
  const addProto = (ret, params = []) => {
    addType(ret);
    for (const p of params) addType(p);
    const shorty = ret[0] + params.map(p => (p[0] === 'L' || p[0] === '[' ? 'L' : p[0])).join('');
    stringSet.add(shorty);
    const key = `(${params.join('')})${ret}`;
    if (!protoKeyToSpec.has(key)) protoKeyToSpec.set(key, { shorty, ret, params });
    return key;
  };

  for (const c of classes) {
    addType(c.descriptor);
    addType(c.superclass || 'Ljava/lang/Object;');
    for (const m of c.methods || []) {
      stringSet.add(m.name);
      addProto(m.ret, m.params);
      methods.push({ owner: c.descriptor, name: m.name, ret: m.ret, params: m.params });
    }
  }
  for (const f of fields) {
    addType(f.owner);
    addType(f.type);
    stringSet.add(f.name);
  }
  const uniqueMethods = [];
  const seenMethod = new Set();
  for (const m of methods) {
    addType(m.owner);
    stringSet.add(m.name);
    const pkey = addProto(m.ret, m.params);
    const k = `${m.owner}->${m.name}${pkey}`;
    if (!seenMethod.has(k)) {
      seenMethod.add(k);
      uniqueMethods.push({ ...m, pkey });
    }
  }

  const strings = [...stringSet].sort();
  const strIdx = new Map(strings.map((s, i) => [s, i]));
  const types = [...typeSet].sort((a, b) => strIdx.get(a) - strIdx.get(b));
  const typeIdx = new Map(types.map((t, i) => [t, i]));
  const protos = [...protoKeyToSpec.entries()].map(([key, spec]) => ({ key, ...spec }));
  const protoIdx = new Map(protos.map((p, i) => [p.key, i]));

  const fieldEntries = fields.map(f => ({
    classIdx: typeIdx.get(f.owner),
    typeIdx: typeIdx.get(f.type),
    nameIdx: strIdx.get(f.name),
  }));
  const methodEntries = uniqueMethods.map(m => ({
    key: `${m.owner}->${m.name}${m.pkey}`,
    classIdx: typeIdx.get(m.owner),
    protoIdx: protoIdx.get(m.pkey),
    nameIdx: strIdx.get(m.name),
  }));
  const methodIdx = new Map(methodEntries.map((m, i) => [m.key, i]));

  const headerSize = 112;
  let pos = headerSize;
  const stringIdsOff = pos; pos += strings.length * 4;
  const typeIdsOff = pos; pos += types.length * 4;
  const protoIdsOff = pos; pos += protos.length * 12;
  const fieldIdsOff = pos; pos += fieldEntries.length * 8;
  const methodIdsOff = pos; pos += methodEntries.length * 8;
  const classDefsOff = pos; pos += classes.length * 32;

  const dataChunks = [];
  let dataPos = pos;
  const align4 = () => {
    const pad = (4 - (dataPos % 4)) % 4;
    if (pad) { dataChunks.push(Buffer.alloc(pad)); dataPos += pad; }
  };
  const pushData = (buf) => {
    const off = dataPos;
    dataChunks.push(buf);
    dataPos += buf.length;
    return off;
  };

  const stringDataOffs = strings.map(s => {
    const utf = Buffer.from(s, 'utf8');
    return pushData(Buffer.concat([encodeUleb128(s.length), utf, Buffer.from([0])]));
  });

  const protoParamOffs = protos.map(p => {
    if (!p.params.length) return 0;
    align4();
    const b = Buffer.alloc(4 + p.params.length * 2);
    b.writeUInt32LE(p.params.length, 0);
    p.params.forEach((pt, idx) => b.writeUInt16LE(typeIdx.get(pt), 4 + idx * 2));
    return pushData(b);
  });

  const classDataOffs = classes.map(c => {
    const direct = (c.methods || []).map(m => {
      const pkey = `(${(m.params || []).join('')})${m.ret}`;
      let codeOff = 0;
      if (m.insnsUnits) {
        align4();
        const codeBuf = Buffer.alloc(16 + m.insnsUnits * 2);
        codeBuf.writeUInt16LE(m.regs ?? 2, 0);
        codeBuf.writeUInt16LE(m.ins ?? 0, 2);
        codeBuf.writeUInt16LE(m.outs ?? 1, 4);
        codeBuf.writeUInt16LE(0, 6);
        codeBuf.writeUInt32LE(0, 8);
        codeBuf.writeUInt32LE(m.insnsUnits, 12);
        codeOff = pushData(codeBuf);
      }
      return { idx: methodIdx.get(`${c.descriptor}->${m.name}${pkey}`), access: m.access ?? 0x0009, codeOff };
    }).sort((a, b) => a.idx - b.idx);

    const parts = [encodeUleb128(0), encodeUleb128(0), encodeUleb128(direct.length), encodeUleb128(0)];
    let prev = 0;
    for (const dm of direct) {
      parts.push(encodeUleb128(dm.idx - prev), encodeUleb128(dm.access), encodeUleb128(dm.codeOff));
      prev = dm.idx;
    }
    return pushData(Buffer.concat(parts));
  });

  align4();
  const totalSize = dataPos;
  const dex = Buffer.alloc(totalSize);
  Buffer.from('dex\n035\0', 'ascii').copy(dex, 0);
  dex.writeUInt32LE(totalSize, 32);
  dex.writeUInt32LE(headerSize, 36);
  dex.writeUInt32LE(0x12345678, 40);
  dex.writeUInt32LE(strings.length, 56); dex.writeUInt32LE(stringIdsOff, 60);
  dex.writeUInt32LE(types.length, 64); dex.writeUInt32LE(typeIdsOff, 68);
  dex.writeUInt32LE(protos.length, 72); dex.writeUInt32LE(protoIdsOff, 76);
  dex.writeUInt32LE(fieldEntries.length, 80); dex.writeUInt32LE(fieldIdsOff, 84);
  dex.writeUInt32LE(methodEntries.length, 88); dex.writeUInt32LE(methodIdsOff, 92);
  dex.writeUInt32LE(classes.length, 96); dex.writeUInt32LE(classDefsOff, 100);
  dex.writeUInt32LE(totalSize - pos, 104); dex.writeUInt32LE(pos, 108);

  stringDataOffs.forEach((off, i) => dex.writeUInt32LE(off, stringIdsOff + i * 4));
  types.forEach((t, i) => dex.writeUInt32LE(strIdx.get(t), typeIdsOff + i * 4));
  protos.forEach((p, i) => {
    const o = protoIdsOff + i * 12;
    dex.writeUInt32LE(strIdx.get(p.shorty), o);
    dex.writeUInt32LE(typeIdx.get(p.ret), o + 4);
    dex.writeUInt32LE(protoParamOffs[i], o + 8);
  });
  fieldEntries.forEach((f, i) => {
    const o = fieldIdsOff + i * 8;
    dex.writeUInt16LE(f.classIdx, o);
    dex.writeUInt16LE(f.typeIdx, o + 2);
    dex.writeUInt32LE(f.nameIdx, o + 4);
  });
  methodEntries.forEach((m, i) => {
    const o = methodIdsOff + i * 8;
    dex.writeUInt16LE(m.classIdx, o);
    dex.writeUInt16LE(m.protoIdx, o + 2);
    dex.writeUInt32LE(m.nameIdx, o + 4);
  });
  classes.forEach((c, i) => {
    const o = classDefsOff + i * 32;
    dex.writeUInt32LE(typeIdx.get(c.descriptor), o);
    dex.writeUInt32LE(0x0001, o + 4);
    dex.writeUInt32LE(typeIdx.get(c.superclass || 'Ljava/lang/Object;'), o + 8);
    dex.writeUInt32LE(0xffffffff, o + 16);
    dex.writeUInt32LE(classDataOffs[i], o + 24);
  });
  let cursor = pos;
  for (const chunk of dataChunks) {
    chunk.copy(dex, cursor);
    cursor += chunk.length;
  }
  return updateDexHashes(dex);
}

test('DEX: neutralizePairipAndHookOkHttp hooks 1.27.0 R8 OkHttp factory across split DEX files (LL9/f; -> LXl/B;)', () => {
  assert.ok(R8_OKHTTP_FACTORIES.some(f => f.factory === 'LL9/f;' && f.client === 'LXl/B;' && f.newBuilder === 'E'));

  // Factory LL9/f; lives in classes4.dex while client LXl/B; lives in classes5.dex (official 1.27.0 layout).
  const factoryDex = buildMinimalDex({
    classes: [{
      descriptor: 'LL9/f;',
      methods: [{ name: 'c', ret: 'LXl/B$a;', params: [], insnsUnits: 20 }],
    }],
    fields: [{ owner: 'LL9/f;', name: 'b', type: 'LXl/B;' }],
    methods: [
      { owner: 'LXl/B;', name: 'E', ret: 'LXl/B$a;', params: [] },
      { owner: 'LXl/B$a;', name: '<init>', ret: 'V', params: [] },
    ],
  });
  const clientDex = buildMinimalDex({
    classes: [{
      descriptor: 'LXl/B;',
      methods: [{ name: 'E', ret: 'LXl/B$a;', params: [], insnsUnits: 6 }],
    }],
  });

  const entries = [
    createEntry('classes4.dex', factoryDex, { store: false }),
    createEntry('classes5.dex', clientDex, { store: false }),
  ];

  const res = neutralizePairipAndHookOkHttp(entries);
  assert.equal(res.okhttpPatched, true);
  assert.equal(res.modifiedDexFiles, 1);

  const patchedFactory = entryBytes(entries[0]);
  const parsed = parseDexIndex(patchedFactory);
  const cMethod = parsed.getClassMethods('LL9/f;').find(m => m.name === 'c' && m.proto === '()LXl/B$a;');
  assert.ok(cMethod && cMethod.codeOff > 0);
  // First instruction must be sget-object v0, LL9/f;.b:LXl/B; (opcode 0x0062)
  assert.equal(patchedFactory.readUInt16LE(cMethod.codeOff + 16), 0x0062);
  assert.equal(patchedFactory.readUInt16LE(cMethod.codeOff + 18), parsed.findFieldId('LL9/f;', 'b', 'LXl/B;'));
  // Fourth instruction unit must invoke LXl/B;.E()LXl/B$a; (opcode 0x106e)
  assert.equal(patchedFactory.readUInt16LE(cMethod.codeOff + 24), 0x106e);
  assert.equal(patchedFactory.readUInt16LE(cMethod.codeOff + 26), parsed.findMethodId('LXl/B;', 'E', '()LXl/B$a;'));

  // Cross-DEX verification rejects a client DEX that defines LXl/B; without E()LXl/B$a;.
  const brokenClientDex = buildMinimalDex({
    classes: [{ descriptor: 'LXl/B;', methods: [{ name: 'other', ret: 'V', params: [], insnsUnits: 2 }] }],
  });
  assert.throws(
    () => neutralizePairipAndHookOkHttp([
      createEntry('classes4.dex', Buffer.from(factoryDex), { store: false }),
      createEntry('classes5.dex', brokenClientDex, { store: false }),
    ]),
    /missing E\(\)LXl\/B\$a;/
  );
});

test('Hermes: synthesizeHermesBytecode encodes opcodes, body and valid SHA-1 footer', () => {
  const meta = loadGatewayTemplateMetadata();
  // Create dummy bundle with capacity
  const bundle = Buffer.alloc(Math.max(meta.bodyOffset + meta.bodyCapacity, meta.bodyLengthOffset + 4) + 100);
  const url = 'http://192.168.1.100:18080';
  const token = 'K7M9P2';

  const patched = synthesizeHermesBytecode(bundle, meta, url, token);
  assert.equal(patched.length, bundle.length);

  // Check body length written
  const bodyLen = patched.readUInt32LE(meta.bodyLengthOffset);
  assert.ok(bodyLen > 0 && bodyLen <= meta.bodyCapacity);

  // Check SHA-1
  const expectedSha1 = crypto.createHash('sha1').update(patched.subarray(0, patched.length - 20)).digest();
  assert.ok(expectedSha1.equals(patched.subarray(patched.length - 20)));
});

test('Hermes: suppressExpoUpdates strips OTA configs', () => {
  const orig = {
    updates: {
      enabled: true,
      url: 'https://u.expo.dev/test',
      checkOnLaunch: 'ALWAYS'
    }
  };
  const suppressed = suppressExpoUpdates(orig);
  assert.equal(suppressed.updates.enabled, false);
  assert.equal(suppressed.updates.checkOnLaunch, 'NEVER');
  assert.equal(suppressed.updates.url, undefined);
});

test('Signing: writeZip aligns .so to 16KB and data to 4B', () => {
  const entries = [
    createEntry('classes.dex', Buffer.from('test dex data'), { store: false }),
    createEntry('lib/arm64-v8a/libnative.so', Buffer.from('test native library'), { store: true }),
    createEntry('assets/data.bin', Buffer.from('test asset data'), { store: false }),
  ];

  const zipBuf = writeZip(entries);
  const zip = readZip(zipBuf);

  const soEntry = zip.entries.find(e => e.name.endsWith('.so'));
  assert.ok(soEntry);
  assert.equal(soEntry.dataStart % 16384, 0, '.so dataStart must be 16KB aligned');
});

test('Signing: createSigningIdentity supports RSA 2048 and signApk produces valid v2/v3 signatures', () => {
  const entries = [
    createEntry('AndroidManifest.xml', Buffer.from('dummy manifest'), { store: true }),
    createEntry('classes.dex', Buffer.from('dummy dex'), { store: false }),
  ];

  const unsigned = writeZip(entries);
  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  const signed = signApk(unsigned, identity, { schemes: ['v2', 'v3'], minSdk: 28 });

  const result = verifyApk(signed);
  assert.equal(result.verified, true);
  assert.equal(result.hasV2, true);
  assert.equal(result.hasV3, true);
  assert.ok(result.certificate);
});

test('Pipeline: runPatchPipeline end-to-end creates patched APK and patch-report.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-patcher-e2e-'));
  const tmpOut = path.join(tmpDir, 'rokbot-test-out.apk');
  try {
    const report = await runPatchPipeline({
      inputApk: FIXTURE_APK,
      outputApk: tmpOut,
      host: 'http://127.0.0.1:18080',
      pairingCode: 'K7M9P2',
      devSigning: true,
      force: true,
      verbose: false
    });

    assert.ok(fs.existsSync(tmpOut));
    assert.equal(report.manifestPatched, true);
    assert.equal(report.dexInjected, 'classes2.dex');
    assert.equal(report.bundlePatched, false);
    assert.equal(report.expoUpdatesDisabled, true);
    assert.equal(report.cleartextTrafficAllowed, true);
    assert.equal(report.devSigning, true);
    assert.match(report.signingCertificateSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.signingVerification?.verified, true);

    const reportFile = path.join(path.dirname(tmpOut), 'patch-report.json');
    assert.ok(fs.existsSync(reportFile));

    // Verify output APK validity
    const signedBytes = fs.readFileSync(tmpOut);
    const verifyResult = verifyApk(signedBytes);
    assert.equal(verifyResult.verified, true);
    assert.equal(verifyResult.hasV3, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Pipeline: runPatchPipeline accurately sets bundlePatched: true when assets/index.android.bundle is present', async () => {
  const meta = loadGatewayTemplateMetadata();
  const dummyBundle = Buffer.alloc(Math.max(meta.bodyOffset + meta.bodyCapacity, meta.bodyLengthOffset + 4) + 100);
  const apkBytes = fs.readFileSync(FIXTURE_APK);
  const { entries } = readZip(apkBytes);
  entries.push(createEntry('assets/index.android.bundle', dummyBundle, { store: false }));
  const inputWithBundle = writeZip(entries);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-patcher-bundle-'));
  const tmpIn = path.join(tmpDir, 'rokbot-bundle-in.apk');
  const tmpOut = path.join(tmpDir, 'rokbot-bundle-out.apk');
  try {
    fs.writeFileSync(tmpIn, inputWithBundle);
    const report = await runPatchPipeline({
      inputApk: tmpIn,
      outputApk: tmpOut,
      host: 'http://127.0.0.1:18080',
      pairingCode: 'K7M9P2',
      devSigning: true,
      force: true,
      verbose: false
    });
    assert.equal(report.bundlePatched, true, 'bundlePatched must be true when bundle is present');
    assert.equal(report.devSigning, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
