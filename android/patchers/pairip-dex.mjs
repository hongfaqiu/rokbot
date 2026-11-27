import crypto from 'node:crypto';
import { createEntry, entryBytes } from './signing.mjs';

const MOD_ADLER = 65521;

export function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

function readUleb128(buf, state) {
  let result = 0;
  let shift = 0;
  while (true) {
    const byte = buf[state.pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return result >>> 0;
}

function decodeMutf8(buf, offset) {
  const state = { pos: offset };
  readUleb128(buf, state); // utf16_size
  const start = state.pos;
  let end = start;
  while (end < buf.length && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(start, end).toString('utf8');
}

export function updateDexHashes(dexBuf) {
  const sha1 = crypto.createHash('sha1').update(dexBuf.subarray(32)).digest();
  sha1.copy(dexBuf, 12);
  const checksum = adler32(dexBuf.subarray(12));
  dexBuf.writeUInt32LE(checksum >>> 0, 8);
  return dexBuf;
}

export function parseDexIndex(dexBuf) {
  if (!Buffer.isBuffer(dexBuf) || dexBuf.length < 112) {
    throw new Error('Invalid DEX buffer');
  }
  const magic = dexBuf.subarray(0, 4).toString('ascii');
  if (magic !== 'dex\n') {
    throw new Error(`Invalid DEX magic: ${magic}`);
  }

  const stringIdsSize = dexBuf.readUInt32LE(56);
  const stringIdsOff = dexBuf.readUInt32LE(60);
  const typeIdsSize = dexBuf.readUInt32LE(64);
  const typeIdsOff = dexBuf.readUInt32LE(68);
  const protoIdsSize = dexBuf.readUInt32LE(72);
  const protoIdsOff = dexBuf.readUInt32LE(76);
  const fieldIdsSize = dexBuf.readUInt32LE(80);
  const fieldIdsOff = dexBuf.readUInt32LE(84);
  const methodIdsSize = dexBuf.readUInt32LE(88);
  const methodIdsOff = dexBuf.readUInt32LE(92);
  const classDefsSize = dexBuf.readUInt32LE(96);
  const classDefsOff = dexBuf.readUInt32LE(100);

  const stringCache = new Map();
  function getString(idx) {
    let val = stringCache.get(idx);
    if (val !== undefined) return val;
    const strOff = dexBuf.readUInt32LE(stringIdsOff + idx * 4);
    val = decodeMutf8(dexBuf, strOff);
    stringCache.set(idx, val);
    return val;
  }

  function getType(idx) {
    const descIdx = dexBuf.readUInt32LE(typeIdsOff + idx * 4);
    return getString(descIdx);
  }

  const protoCache = new Map();
  function getProtoSignature(idx) {
    let sig = protoCache.get(idx);
    if (sig !== undefined) return sig;
    const base = protoIdsOff + idx * 12;
    const retType = getType(dexBuf.readUInt32LE(base + 4));
    const paramsOff = dexBuf.readUInt32LE(base + 8);
    let params = '';
    if (paramsOff !== 0) {
      const size = dexBuf.readUInt32LE(paramsOff);
      for (let i = 0; i < size; i++) {
        params += getType(dexBuf.readUInt16LE(paramsOff + 4 + i * 2));
      }
    }
    sig = `(${params})${retType}`;
    protoCache.set(idx, sig);
    return sig;
  }

  function findTypeId(descriptor) {
    for (let i = 0; i < typeIdsSize; i++) {
      if (getType(i) === descriptor) return i;
    }
    return -1;
  }

  function findFieldId(ownerDescriptor, name, typeDescriptor) {
    for (let i = 0; i < fieldIdsSize; i++) {
      const off = fieldIdsOff + i * 8;
      if (
        getType(dexBuf.readUInt16LE(off)) === ownerDescriptor &&
        getType(dexBuf.readUInt16LE(off + 2)) === typeDescriptor &&
        getString(dexBuf.readUInt32LE(off + 4)) === name
      ) {
        return i;
      }
    }
    return -1;
  }

  function findMethodId(ownerDescriptor, name, protoSig) {
    for (let i = 0; i < methodIdsSize; i++) {
      const off = methodIdsOff + i * 8;
      if (
        getType(dexBuf.readUInt16LE(off)) === ownerDescriptor &&
        getString(dexBuf.readUInt32LE(off + 4)) === name &&
        getProtoSignature(dexBuf.readUInt16LE(off + 2)) === protoSig
      ) {
        return i;
      }
    }
    return -1;
  }

  function getClassMethods(ownerDescriptor) {
    for (let i = 0; i < classDefsSize; i++) {
      const defOff = classDefsOff + i * 32;
      const classIdx = dexBuf.readUInt32LE(defOff);
      if (getType(classIdx) !== ownerDescriptor) continue;
      const classDataOff = dexBuf.readUInt32LE(defOff + 24);
      if (classDataOff === 0) return [];

      const state = { pos: classDataOff };
      const staticFieldsSize = readUleb128(dexBuf, state);
      const instanceFieldsSize = readUleb128(dexBuf, state);
      const directMethodsSize = readUleb128(dexBuf, state);
      const virtualMethodsSize = readUleb128(dexBuf, state);

      for (let f = 0; f < staticFieldsSize + instanceFieldsSize; f++) {
        readUleb128(dexBuf, state); // field_idx_diff
        readUleb128(dexBuf, state); // access_flags
      }

      const methods = [];
      for (const kind of [
        { name: 'direct', count: directMethodsSize },
        { name: 'virtual', count: virtualMethodsSize },
      ]) {
        let methodIdx = 0;
        for (let m = 0; m < kind.count; m++) {
          methodIdx += readUleb128(dexBuf, state);
          const accessFlags = readUleb128(dexBuf, state);
          const codeOff = readUleb128(dexBuf, state);
          const mOff = methodIdsOff + methodIdx * 8;
          const name = getString(dexBuf.readUInt32LE(mOff + 4));
          const proto = getProtoSignature(dexBuf.readUInt16LE(mOff + 2));
          methods.push({ kind: kind.name, methodIdx, accessFlags, codeOff, name, proto });
        }
      }
      return methods;
    }
    return null;
  }

  return {
    dexBuf,
    findTypeId,
    findFieldId,
    findMethodId,
    getClassMethods,
  };
}

function readSleb128(buf, state) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[state.pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while ((byte & 0x80) !== 0);
  if (shift < 32 && (byte & 0x40) !== 0) {
    result |= -(1 << shift);
  }
  return result | 0;
}

function measureCodeItemAlignedSize(dexBuf, codeOff) {
  const triesSize = dexBuf.readUInt16LE(codeOff + 6);
  const insnsSize = dexBuf.readUInt32LE(codeOff + 12);
  let pos = codeOff + 16 + insnsSize * 2;
  if (triesSize > 0) {
    if ((insnsSize & 1) === 1) pos += 2;
    pos += triesSize * 8;
    const state = { pos };
    const handlersSize = readUleb128(dexBuf, state);
    for (let i = 0; i < handlersSize; i++) {
      const size = readSleb128(dexBuf, state);
      const count = Math.abs(size);
      for (let j = 0; j < count; j++) {
        readUleb128(dexBuf, state); // type_idx
        readUleb128(dexBuf, state); // addr
      }
      if (size <= 0) {
        readUleb128(dexBuf, state); // catch_all_addr
      }
    }
    pos = state.pos;
  }
  return (pos + 3) & ~3;
}

function patchCodeItemInPlace(dexBuf, codeOff, { registersSize, insSize, outsSize, insns }) {
  if (!codeOff) {
    throw new Error('Cannot patch abstract/native method with code_off=0');
  }
  const origInsnsSize = dexBuf.readUInt32LE(codeOff + 12);
  const origTriesSize = dexBuf.readUInt16LE(codeOff + 6);
  const alignedEnd = measureCodeItemAlignedSize(dexBuf, codeOff);
  // Keep insns_size unchanged when tries_size === 0 (preserving exact alignment/padding),
  // or fill the exact aligned span with trailing nops when eliminating try/catch tables.
  const targetInsnsSize = origTriesSize === 0 ? origInsnsSize : (alignedEnd - codeOff - 16) >> 1;
  if (insns.length > targetInsnsSize) {
    throw new Error(
      `Replacement bytecode (${insns.length} units) exceeds existing code_item capacity (${targetInsnsSize} units) at 0x${codeOff.toString(16)}`
    );
  }
  dexBuf.writeUInt16LE(registersSize, codeOff + 0);
  dexBuf.writeUInt16LE(insSize, codeOff + 2);
  dexBuf.writeUInt16LE(outsSize, codeOff + 4);
  dexBuf.writeUInt16LE(0, codeOff + 6); // tries_size = 0
  dexBuf.writeUInt32LE(0, codeOff + 8); // debug_info_off = 0
  dexBuf.writeUInt32LE(targetInsnsSize, codeOff + 12);
  for (let i = 0; i < insns.length; i++) {
    dexBuf.writeUInt16LE(insns[i] & 0xffff, codeOff + 16 + i * 2);
  }
  for (let i = insns.length; i < targetInsnsSize; i++) {
    dexBuf.writeUInt16LE(0x0000, codeOff + 16 + i * 2); // nop padding
  }
}

function patchMethodReturnVoid(dexBuf, method) {
  const existingRegs = dexBuf.readUInt16LE(method.codeOff + 0);
  const existingIns = dexBuf.readUInt16LE(method.codeOff + 2);
  patchCodeItemInPlace(dexBuf, method.codeOff, {
    registersSize: Math.max(existingRegs, existingIns),
    insSize: existingIns,
    outsSize: 0,
    insns: [0x000e], // return-void (bytes: 0e 00)
  });
}

function patchMethodReturnConstBoolean(dexBuf, method, boolVal) {
  const existingIns = dexBuf.readUInt16LE(method.codeOff + 2);
  const opcodeConst = boolVal ? 0x1012 : 0x0012; // const/4 v0, #1 or #0 (bytes: 12 10 / 12 00)
  patchCodeItemInPlace(dexBuf, method.codeOff, {
    registersSize: Math.max(1, existingIns + 1),
    insSize: existingIns,
    outsSize: 0,
    insns: [opcodeConst, 0x000f], // return v0 (bytes: 0f 00)
  });
}

function patchPairipInDex(dexBuf) {
  const parsed = parseDexIndex(dexBuf);
  const vmRunnerMethods = parsed.getClassMethods('Lcom/pairip/VMRunner;');
  if (!vmRunnerMethods) {
    return { pairipPatched: 0, vmRunnerHooked: false };
  }

  let pairipPatched = 0;
  let vmRunnerHooked = false;

  const jobFieldId = parsed.findFieldId('Lcom/pairip/VMRunner;', 'job', 'Ljava/util/concurrent/Future;');
  const futureGetMethodId = parsed.findMethodId('Ljava/util/concurrent/Future;', 'get', '()Ljava/lang/Object;');
  const fn2TypeId = parsed.findTypeId('Lkotlin/jvm/functions/Function2;');
  const fn2InvokeMethodId = parsed.findMethodId(
    'Lkotlin/jvm/functions/Function2;',
    'invoke',
    '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;'
  );

  for (const m of vmRunnerMethods) {
    if (m.name === '<clinit>' && m.proto === '()V' && m.codeOff) {
      patchMethodReturnVoid(dexBuf, m);
      pairipPatched++;
    } else if (
      m.name === 'invoke' &&
      m.proto === '(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/Object;' &&
      m.codeOff
    ) {
      if (jobFieldId < 0 || futureGetMethodId < 0 || fn2TypeId < 0 || fn2InvokeMethodId < 0) {
        throw new Error(
          `Missing Pairip VMRunner bridge symbols in DEX: job=${jobFieldId}, futureGet=${futureGetMethodId}, fn2=${fn2TypeId}, fn2Invoke=${fn2InvokeMethodId}`
        );
      }
      // registers=5 (v0..v2 locals, v3=String id, v4=Object[] args), ins=2, outs=3:
      // 0000: sget-object v0, VMRunner.job
      // 0002: if-eqz v0, +0x0f (-> 0011)
      // 0004: invoke-interface {v0}, Future.get()
      // 0007: move-result-object v0
      // 0008: if-eqz v0, +0x09 (-> 0011)
      // 000a: check-cast v0, Function2
      // 000c: invoke-interface {v0, v3, v4}, Function2.invoke(Object, Object)
      // 000f: move-result-object v0
      // 0010: return-object v0
      // 0011: const/4 v0, #0
      // 0012: return-object v0
      const insns = [
        0x0062, jobFieldId,
        0x0038, 0x000f,
        0x1072, futureGetMethodId, 0x0000,
        0x000c,
        0x0038, 0x0009,
        0x001f, fn2TypeId,
        0x3072, fn2InvokeMethodId, 0x0430,
        0x000c,
        0x0011,
        0x0012,
        0x0011,
      ];
      patchCodeItemInPlace(dexBuf, m.codeOff, {
        registersSize: 5,
        insSize: 2,
        outsSize: 3,
        insns,
      });
      pairipPatched++;
      vmRunnerHooked = true;
    }
  }

  const voidTargets = [
    ['Lcom/pairip/StartupLauncher;', 'launch', '()V'],
    ['Lcom/pairip/SignatureCheck;', 'verifyIntegrity', '(Landroid/content/Context;)V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'checkLicense', '(Landroid/content/Context;)V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'initializeLicenseCheck', '()V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'stopTrial', '(Landroid/content/Context;)V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'bindToLicensingService', '(Z)V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'handleTrialEnd', '()V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'startErrorDialogActivity', '()V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'startPaywallActivity', '(Landroid/app/PendingIntent;)V'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'scheduleAppShutdown', '()V'],
    ['Lcom/pairip/licensecheck/TrialClient;', 'stopTrial', '(Landroid/content/Context;)V'],
  ];

  const trueTargets = [
    ['Lcom/pairip/SignatureCheck;', 'verifySignatureMatches', '(Ljava/lang/String;)Z'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'isLocalCheckPassed', '()Z'],
    ['Lcom/pairip/licensecheck/LicenseClient;', 'performLocalInstallerCheck', '()Z'],
  ];

  const methodLookupCache = new Map();
  function getMethodsCached(cls) {
    if (!methodLookupCache.has(cls)) {
      methodLookupCache.set(cls, parsed.getClassMethods(cls) || []);
    }
    return methodLookupCache.get(cls);
  }

  for (const [cls, name, proto] of voidTargets) {
    const m = getMethodsCached(cls).find((item) => item.name === name && item.proto === proto && item.codeOff);
    if (m) {
      patchMethodReturnVoid(dexBuf, m);
      pairipPatched++;
    }
  }

  for (const [cls, name, proto] of trueTargets) {
    const m = getMethodsCached(cls).find((item) => item.name === name && item.proto === proto && item.codeOff);
    if (m) {
      patchMethodReturnConstBoolean(dexBuf, m, true);
      pairipPatched++;
    }
  }

  return { pairipPatched, vmRunnerHooked };
}

export const R8_OKHTTP_FACTORIES = [
  {
    factory: 'LL9/f;',
    client: 'LXl/B;',
    builder: 'LXl/B$a;',
    newBuilder: 'E',
    builderProto: '()LXl/B$a;',
  },
  {
    factory: 'LL9/f;',
    client: 'LTl/B;',
    builder: 'LTl/B$a;',
    newBuilder: 'E',
    builderProto: '()LTl/B$a;',
  },
  {
    factory: 'Lt8/f;',
    client: 'Loj/A;',
    builder: 'Loj/A$a;',
    newBuilder: 'C',
    builderProto: '()Loj/A$a;',
  },
];

function patchR8OkHttpFactoryInDex(dexBuf, parsed = parseDexIndex(dexBuf), allDexes = null) {
  let spec = null;
  let target = null;
  for (const candidate of R8_OKHTTP_FACTORIES) {
    const methods = parsed.getClassMethods(candidate.factory);
    if (!methods) continue;
    const match = methods.find((m) => m.name === 'c' && m.proto === candidate.builderProto && m.codeOff);
    if (match) {
      spec = candidate;
      target = match;
      break;
    }
  }
  if (!spec || !target) {
    return { okhttpPatched: false };
  }

  // Verify cross-DEX client class & newBuilder method when multiple DEX files are present.
  let clientDexName = null;
  if (Array.isArray(allDexes) && allDexes.length > 0) {
    for (const d of allDexes) {
      const clientMethods = d.parsed.getClassMethods(spec.client);
      if (clientMethods) {
        const hasNewBuilder = clientMethods.some(
          (m) => m.name === spec.newBuilder && m.proto === spec.builderProto
        );
        if (!hasNewBuilder) {
          throw new Error(
            `R8 OkHttp client ${spec.client} in ${d.name} is missing ${spec.newBuilder}${spec.builderProto}`
          );
        }
        clientDexName = d.name;
        break;
      }
    }
  }

  const clientFieldId = parsed.findFieldId(spec.factory, 'b', spec.client);
  const newBuilderMethodId = parsed.findMethodId(spec.client, spec.newBuilder, spec.builderProto);
  const builderTypeId = parsed.findTypeId(spec.builder);
  const builderInitMethodId = parsed.findMethodId(spec.builder, '<init>', '()V');

  if (clientFieldId < 0 || newBuilderMethodId < 0 || builderTypeId < 0 || builderInitMethodId < 0) {
    throw new Error(
      `Missing R8 OkHttp symbols in ${spec.factory} DEX: field=${clientFieldId}, newBuilder=${newBuilderMethodId}, builderType=${builderTypeId}, builderInit=${builderInitMethodId}`
    );
  }

  // if (<factory>.b != null) return <factory>.b.<newBuilder>();
  // return new <builder>();
  // 0000: sget-object v0, <factory>.b:<client>
  // 0002: if-eqz v0, +7 (-> 0009)
  // 0004: invoke-virtual {v0}, <client>.<newBuilder>()<builder>
  // 0007: move-result-object v0
  // 0008: return-object v0
  // 0009: new-instance v0, <builder>
  // 000b: invoke-direct {v0}, <builder>.<init>()V
  // 000e: return-object v0
  const insns = [
    0x0062, clientFieldId,
    0x0038, 0x0007,
    0x106e, newBuilderMethodId, 0x0000,
    0x000c,
    0x0011,
    0x0022, builderTypeId,
    0x1070, builderInitMethodId, 0x0000,
    0x0011,
  ];
  patchCodeItemInPlace(dexBuf, target.codeOff, {
    registersSize: 1,
    insSize: 0,
    outsSize: 1,
    insns,
  });

  return { okhttpPatched: true, spec, clientDexName };
}

export function neutralizePairipAndHookOkHttp(entries) {
  let pairipPatched = 0;
  let vmRunnerHooked = false;
  let okhttpPatched = false;
  let modifiedDexFiles = 0;

  const dexItems = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!/^classes\d*\.dex$/.test(entry.name)) continue;
    const dexBuf = Buffer.from(entryBytes(entry));
    const parsed = parseDexIndex(dexBuf);
    dexItems.push({ index: i, entry, name: entry.name, dexBuf, parsed, dirty: false });
  }

  for (const item of dexItems) {
    const pRes = patchPairipInDex(item.dexBuf);
    if (pRes.pairipPatched > 0) {
      pairipPatched += pRes.pairipPatched;
      if (pRes.vmRunnerHooked) vmRunnerHooked = true;
      item.dirty = true;
    }

    const oRes = patchR8OkHttpFactoryInDex(item.dexBuf, item.parsed, dexItems);
    if (oRes.okhttpPatched) {
      okhttpPatched = true;
      item.dirty = true;
    }

    if (item.dirty) {
      updateDexHashes(item.dexBuf);
      entries[item.index] = createEntry(item.name, item.dexBuf, { store: item.entry.method === 0 });
      modifiedDexFiles++;
    }
  }

  return {
    patched: modifiedDexFiles > 0,
    modifiedDexFiles,
    pairipPatched,
    vmRunnerHooked,
    okhttpPatched,
  };
}
