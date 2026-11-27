#!/usr/bin/env node
// Reusable Hermes Bytecode (HBC v98) analyzer & recipe builder for official Android bundles.
//
// Parses any official React Native Android HBC v98 bundle, discovers all RokBot patch anchors
// semantically (by module/function/string structure rather than hardcoded function IDs),
// appends the RokBot unpaired + gateway-template tail right after debug info (replacing the
// original 20-byte SHA-1 footer, updating header.fileLength, and rewriting the footer SHA-1),
// emits deterministic rokbot-bytepatch/v1 .gbp.gz recipes + gateway-template metadata JSON,
// and self-verifies bytepatch round-trip + dynamic URL/token synthesis.
//
// Usage:
//   node android/patchers/build-hbc-recipe.mjs \
//     --bundle /tmp/apk127/ai.x.grok.bot/assets/index.android.bundle \
//     --version-code 3283 \
//     --out-dir android/recipes
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { applyBytepatch, synthesizeHermesBytecode } from './hermes.mjs';

const HBC_MAGIC = 0x1f1903c103bc1fc6n;
const HBC_VERSION = 98;
const HEADER_SIZE = 128;
const FOOTER_SIZE = 20;
const SMALL_HDR_SIZE = 12;
const FULL_HDR_SIZE = 40; // 37 bytes padded to 4-byte alignment
const OVERFLOWED_FLAG = 0x20;
export const GATEWAY_BODY_CAPACITY = 24600;

// HBC v98 opcode numbers used by the Android recipes & decoder.
export const HBC98_OPCODES = {
  NewObjectWithBufferLong: 2,
  NewObject: 4,
  NewArray: 8,
  Mov: 16,
  Add: 30,
  GetParentEnvironment: 52,
  GetGlobalObject: 61,
  GetByIdShort: 68,
  GetById: 69,
  GetByIdLong: 70,
  TryGetById: 72,
  TryGetByIdLong: 73,
  DefineOwnById: 86,
  DefineOwnByIdLong: 87,
  DefineOwnInDenseArray: 90,
  Call1: 108,
  Call2: 110,
  Call3: 111,
  Call4: 112,
  GetBuiltinClosure: 117,
  Ret: 118,
  CreateClosure: 132,
  CreateClosureLongIndex: 133,
  LoadParam: 137,
  LoadConstUInt8: 139,
  LoadConstInt: 140,
  LoadConstString: 144,
  LoadConstStringLongIndex: 145,
  LoadConstUndefined: 147,
  LoadConstNull: 148,
  LoadConstTrue: 149,
  LoadConstFalse: 150,
  ReifyArgumentsStrict: 162,
  JmpFalseLong: 179,
  JStrictEqual: 211,
  JStrictEqualLong: 212,
};

// Operand widths in bytes for all 219 HBC v98 opcodes (derived from ios/tools/hbc98/opcodes-v98.json).
const OPERAND_WIDTH = {
  Reg8: 1, Reg32: 4, UInt8: 1, UInt16: 2, UInt32: 4,
  Addr8: 1, Addr32: 4, Imm32: 4, Double: 8,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPCODES_JSON_PATH = path.resolve(__dirname, '../../ios/tools/hbc98/opcodes-v98.json');

let cachedOpcodeTable = null;
function loadOpcodeTable() {
  if (cachedOpcodeTable) return cachedOpcodeTable;
  const raw = JSON.parse(fs.readFileSync(OPCODES_JSON_PATH, 'utf8'));
  const names = Object.keys(raw);
  const byId = names.map((name, id) => ({
    id,
    name,
    operands: raw[name],
    widths: raw[name].map(t => OPERAND_WIDTH[t]),
    size: 1 + raw[name].reduce((s, t) => s + OPERAND_WIDTH[t], 0),
  }));
  const byName = new Map(byId.map(o => [o.name, o]));
  cachedOpcodeTable = { byId, byName };
  return cachedOpcodeTable;
}

export const BACKEND_LOCAL_BYPASS_RPCS = [
  'aiserver.v1.GrokBotService/SendGrokBotUserMessage',
  'aiserver.v1.AiService/TranscribeAudio',
  'aiserver.v1.GrokBotService/GetGrokBotSendStatus',
  'aiserver.v1.GrokBotService/ListGrokBotAgents',
  'aiserver.v1.GrokBotService/MintSandVoiceCallSecret',
  'aiserver.v1.DashboardService/ListMarketplacePlugins',
  'aiserver.v1.GrokBotService/ListPublicGrokBotMarketplaceListings',
  'aiserver.v1.DashboardService/GetTeamPluginPopularity',
  'aiserver.v1.DashboardService/ListMarketplaces',
  'aiserver.v1.DashboardService/GetEffectiveUserPlugins',
  'aiserver.v1.DashboardService/GetAvailableMcpServers',
  'aiserver.v1.DashboardService/ValidateMcpOAuthTokens',
  'aiserver.v1.DashboardService/ListSandMcpTools',
  'aiserver.v1.DashboardService/InstallUserPlugin',
  'aiserver.v1.DashboardService/UpdateUserPluginInstall',
  'aiserver.v1.DashboardService/UninstallUserPlugin',
  'aiserver.v1.DashboardService/RenameMcpOAuthAccount',
  'aiserver.v1.DashboardService/DeleteMcpOAuthAccount',
  'aiserver.v1.DashboardService/CheckHttpMcpStatus',
  'aiserver.v1.DashboardService/CompleteMcpOAuth',
  'aiserver.v1.GrokBotService/GetGrokBotMcpToolPermissions',
  'aiserver.v1.GrokBotService/SetGrokBotMcpToolPermissions',
];

const align4 = n => (n + 3) & ~3;
const sha256Hex = buf => crypto.createHash('sha256').update(buf).digest('hex');

export function parseHbcV98(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE + FOOTER_SIZE) {
    throw new Error('Buffer too small for HBC v98');
  }
  const magic = buf.readBigUInt64LE(0);
  const version = buf.readUInt32LE(8);
  if (magic !== HBC_MAGIC || version !== HBC_VERSION) {
    throw new Error(`Unsupported HBC header: magic=0x${magic.toString(16)} version=${version}`);
  }
  const u32 = off => buf.readUInt32LE(off);
  const header = {
    fileLength: u32(32),
    globalCodeIndex: u32(36),
    functionCount: u32(40),
    stringKindCount: u32(44),
    identifierCount: u32(48),
    stringCount: u32(52),
    overflowStringCount: u32(56),
    stringStorageSize: u32(60),
    bigIntCount: u32(64),
    bigIntStorageSize: u32(68),
    regExpCount: u32(72),
    regExpStorageSize: u32(76),
    literalValueBufferSize: u32(80),
    objKeyBufferSize: u32(84),
    objShapeTableCount: u32(88),
    numStringSwitchImms: u32(92),
    segmentID: u32(96),
    cjsModuleCount: u32(100),
    functionSourceCount: u32(104),
    debugInfoOffset: u32(108),
  };
  if (header.fileLength !== buf.length) {
    throw new Error(`HBC fileLength mismatch: header=${header.fileLength} actual=${buf.length}`);
  }

  let p = HEADER_SIZE;
  const fhOff = p; p = align4(p + SMALL_HDR_SIZE * header.functionCount);
  const skOff = p; p = align4(p + 4 * header.stringKindCount);
  const idHashOff = p; p = align4(p + 4 * header.identifierCount);
  const stOff = p; p = align4(p + 4 * header.stringCount);
  const ovOff = p; p = align4(p + 8 * header.overflowStringCount);
  const ssOff = p; p = align4(p + header.stringStorageSize);

  const strings = new Array(header.stringCount);
  const stringFirstId = new Map();
  for (let id = 0; id < header.stringCount; id++) {
    const w = buf.readUInt32LE(stOff + 4 * id);
    const utf16 = w & 1;
    let offset = (w >>> 1) & 0x7fffff;
    let length = w >>> 24;
    if (length === 255) {
      const o = ovOff + 8 * offset;
      offset = buf.readUInt32LE(o);
      length = buf.readUInt32LE(o + 4);
    }
    const start = ssOff + offset;
    const text = utf16
      ? buf.toString('utf16le', start, start + 2 * length)
      : buf.toString('latin1', start, start + length);
    strings[id] = text;
    if (!stringFirstId.has(text)) stringFirstId.set(text, id);
  }

  const functions = new Array(header.functionCount);
  const functionsByName = new Map();
  for (let i = 0; i < header.functionCount; i++) {
    const smallOff = fhOff + SMALL_HDR_SIZE * i;
    const w0 = buf.readUInt32LE(smallOff);
    const w1 = buf.readUInt32LE(smallOff + 4);
    const flags = buf[smallOff + 11];
    let fn;
    if (flags & OVERFLOWED_FLAG) {
      const largeOff = (((w1 >>> 14) & 0xff) << 24 | (w0 & 0x01ffffff)) >>> 0;
      fn = {
        index: i,
        overflow: true,
        smallOff,
        largeOff,
        offset: buf.readUInt32LE(largeOff),
        paramCount: buf.readUInt32LE(largeOff + 4),
        loopDepth: buf.readUInt32LE(largeOff + 8),
        bytecodeSize: buf.readUInt32LE(largeOff + 12),
        nameId: buf.readUInt32LE(largeOff + 16),
        numberRegCount: buf.readUInt32LE(largeOff + 20),
        nonPointerRegCount: buf.readUInt32LE(largeOff + 24),
        frameSize: buf.readUInt32LE(largeOff + 28),
        readCacheSize: buf[largeOff + 32],
        writeCacheSize: buf[largeOff + 33],
        numCacheNewObject: buf[largeOff + 34],
        privateNameCacheSize: buf[largeOff + 35],
        flags: buf[largeOff + 36],
      };
    } else {
      fn = {
        index: i,
        overflow: false,
        smallOff,
        largeOff: 0,
        offset: w0 & 0x01ffffff,
        paramCount: (w0 >>> 25) & 0x1f,
        loopDepth: (w0 >>> 30) & 0x03,
        bytecodeSize: w1 & 0x3fff,
        nameId: (w1 >>> 14) & 0xff,
        numberRegCount: (w1 >>> 22) & 0x1f,
        nonPointerRegCount: (w1 >>> 27) & 0x1f,
        frameSize: buf[smallOff + 8],
        readCacheSize: buf[smallOff + 9],
        writeCacheSize: buf[smallOff + 10] & 0x3f,
        numCacheNewObject: (buf[smallOff + 10] >>> 6) & 1,
        privateNameCacheSize: (buf[smallOff + 10] >>> 7) & 1,
        flags,
      };
    }
    fn.name = fn.nameId < strings.length ? strings[fn.nameId] : '';
    functions[i] = fn;
    let list = functionsByName.get(fn.name);
    if (!list) {
      list = [];
      functionsByName.set(fn.name, list);
    }
    list.push(fn);
  }

  return {
    buf,
    header,
    fhOff,
    skOff,
    idHashOff,
    stOff,
    ovOff,
    ssOff,
    strings,
    stringFirstId,
    functions,
    functionsByName,
  };
}

function decodeFunction(buf, fn) {
  const { byId } = loadOpcodeTable();
  const insns = [];
  const start = fn.offset;
  const end = start + fn.bytecodeSize;
  let pos = start;
  while (pos < end) {
    const op = byId[buf[pos]];
    if (!op) throw new Error(`Unknown HBC opcode ${buf[pos]} at 0x${pos.toString(16)}`);
    const operands = [];
    let c = pos + 1;
    for (let k = 0; k < op.operands.length; k++) {
      const t = op.operands[k];
      const w = op.widths[k];
      let v;
      if (w === 1) v = t === 'Addr8' ? buf.readInt8(c) : buf.readUInt8(c);
      else if (w === 2) v = buf.readUInt16LE(c);
      else if (w === 4) v = (t === 'Addr32' || t === 'Imm32') ? buf.readInt32LE(c) : buf.readUInt32LE(c);
      else v = buf.readDoubleLE(c);
      operands.push(v);
      c += w;
    }
    insns.push({ rel: pos - start, abs: pos, size: op.size, name: op.name, id: op.id, operands });
    pos += op.size;
  }
  return insns;
}

const STRING_OPERAND_OPS = new Set([
  'LoadConstString', 'LoadConstStringLongIndex',
  'GetById', 'GetByIdLong', 'TryGetById', 'TryGetByIdLong',
  'PutById', 'PutByIdLong', 'DefineOwnById', 'DefineOwnByIdLong',
]);

const CLOSURE_OPS = new Set([
  'CreateClosure', 'CreateClosureLongIndex',
  'CreateAsyncClosure', 'CreateAsyncClosureLongIndex',
  'CreateGeneratorClosure', 'CreateGeneratorClosureLongIndex',
]);

function functionStrings(hbc, fn) {
  const out = new Set();
  for (const ins of decodeFunction(hbc.buf, fn)) {
    if (STRING_OPERAND_OPS.has(ins.name)) {
      const sid = ins.operands[ins.operands.length - 1];
      if (sid >= 0 && sid < hbc.strings.length) out.add(hbc.strings[sid]);
    }
  }
  return out;
}

function functionClosures(hbc, fn) {
  const out = [];
  for (const ins of decodeFunction(hbc.buf, fn)) {
    if (CLOSURE_OPS.has(ins.name)) out.push(ins.operands[ins.operands.length - 1]);
  }
  return out;
}

function requireStringId(hbc, text) {
  const id = hbc.stringFirstId.get(text);
  if (id === undefined) throw new Error(`Required string not found in HBC bundle: ${JSON.stringify(text)}`);
  return id;
}

function findUniqueFunction(hbc, name, predicate, label = name) {
  const list = (hbc.functionsByName.get(name) || []).filter(predicate);
  if (list.length !== 1) {
    throw new Error(`Expected exactly 1 match for ${label} (name=${JSON.stringify(name)}), got ${list.length}`);
  }
  return list[0];
}

function findModuleOwnedFunctions(hbc, markerStrings, wantedChildNames) {
  const matches = [];
  for (const fn of hbc.functions) {
    if (fn.name !== '' || fn.bytecodeSize < 24 || fn.bytecodeSize > 40000) continue;
    // Fast pre-check via raw string IDs only after decoding cheap candidates
    let insns;
    try {
      insns = decodeFunction(hbc.buf, fn);
    } catch {
      continue;
    }
    const seenStrs = new Set();
    const closures = [];
    for (const ins of insns) {
      if (STRING_OPERAND_OPS.has(ins.name)) {
        const sid = ins.operands[ins.operands.length - 1];
        if (sid < hbc.strings.length) seenStrs.add(hbc.strings[sid]);
      } else if (CLOSURE_OPS.has(ins.name)) {
        closures.push(ins.operands[ins.operands.length - 1]);
      }
    }
    if (!markerStrings.every(m => seenStrs.has(m))) continue;
    const byName = {};
    for (const cid of closures) {
      const child = hbc.functions[cid];
      if (child && wantedChildNames.includes(child.name)) {
        if (!byName[child.name]) byName[child.name] = [];
        byName[child.name].push(child);
      }
    }
    if (wantedChildNames.every(n => byName[n] && byName[n].length >= 1)) {
      matches.push({ moduleFn: fn, children: byName });
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected 1 module matching ${JSON.stringify(markerStrings)} with children ${JSON.stringify(wantedChildNames)}, found ${matches.length}`);
  }
  return matches[0];
}

function emitLoadConstString(bytes, reg, sid) {
  if (sid < 65536) {
    bytes.push(HBC98_OPCODES.LoadConstString, reg, sid & 0xff, (sid >>> 8) & 0xff);
  } else {
    bytes.push(
      HBC98_OPCODES.LoadConstStringLongIndex,
      reg,
      sid & 0xff, (sid >>> 8) & 0xff, (sid >>> 16) & 0xff, (sid >>> 24) & 0xff
    );
  }
}

function emitGetById(bytes, dst, obj, cacheIdx, sid) {
  if (sid < 65536) {
    bytes.push(HBC98_OPCODES.GetById, dst, obj, cacheIdx, sid & 0xff, (sid >>> 8) & 0xff);
  } else {
    bytes.push(
      HBC98_OPCODES.GetByIdLong, dst, obj, cacheIdx,
      sid & 0xff, (sid >>> 8) & 0xff, (sid >>> 16) & 0xff, (sid >>> 24) & 0xff
    );
  }
}

function emitTryGetById(bytes, dst, obj, cacheIdx, sid) {
  if (sid < 65536) {
    bytes.push(HBC98_OPCODES.TryGetById, dst, obj, cacheIdx, sid & 0xff, (sid >>> 8) & 0xff);
  } else {
    bytes.push(
      HBC98_OPCODES.TryGetByIdLong, dst, obj, cacheIdx,
      sid & 0xff, (sid >>> 8) & 0xff, (sid >>> 16) & 0xff, (sid >>> 24) & 0xff
    );
  }
}

function emitCreateClosure(bytes, dst, env, fnIdx) {
  if (fnIdx < 65536) {
    bytes.push(HBC98_OPCODES.CreateClosure, dst, env, fnIdx & 0xff, (fnIdx >>> 8) & 0xff);
  } else {
    bytes.push(
      HBC98_OPCODES.CreateClosureLongIndex, dst, env,
      fnIdx & 0xff, (fnIdx >>> 8) & 0xff, (fnIdx >>> 16) & 0xff, (fnIdx >>> 24) & 0xff
    );
  }
}

function encodeCharBuilder(bytes, strObjReg, fromCharCodeReg, accReg, tmpCharReg, tmpOutReg, text, emptySid) {
  emitLoadConstString(bytes, accReg, emptySid);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 255) {
      bytes.push(HBC98_OPCODES.LoadConstUInt8, tmpCharReg, code);
    } else {
      bytes.push(
        HBC98_OPCODES.LoadConstInt, tmpCharReg,
        code & 0xff, (code >>> 8) & 0xff, (code >>> 16) & 0xff, (code >>> 24) & 0xff
      );
    }
    bytes.push(HBC98_OPCODES.Call2, tmpOutReg, fromCharCodeReg, strObjReg, tmpCharReg);
    bytes.push(HBC98_OPCODES.Add, accReg, accReg, tmpOutReg);
  }
  bytes.push(HBC98_OPCODES.Ret, accReg);
}

/**
 * Builds the locale-aware label helper ("连接服务端" for zh*, "Connect to Host" otherwise).
 */
function buildConnectHostLabelHelper(hbc) {
  const sidIntl = requireStringId(hbc, 'Intl');
  const sidDTF = requireStringId(hbc, 'DateTimeFormat');
  const sidResolved = requireStringId(hbc, 'resolvedOptions');
  const sidLocale = requireStringId(hbc, 'locale');
  const sidStartsWith = requireStringId(hbc, 'startsWith');
  const sidZh = requireStringId(hbc, 'zh');
  const sidString = requireStringId(hbc, 'String');
  const sidFromCharCode = requireStringId(hbc, 'fromCharCode');
  const sidEmpty = requireStringId(hbc, '');

  const zhBranch = [];
  zhBranch.push(HBC98_OPCODES.GetGlobalObject, 0);
  emitTryGetById(zhBranch, 5, 0, 5, sidString);
  emitGetById(zhBranch, 6, 5, 6, sidFromCharCode);
  encodeCharBuilder(zhBranch, 5, 6, 2, 3, 4, '连接服务端', sidEmpty);

  const enBranch = [];
  enBranch.push(HBC98_OPCODES.GetGlobalObject, 0);
  emitTryGetById(enBranch, 5, 0, 5, sidString);
  emitGetById(enBranch, 6, 5, 6, sidFromCharCode);
  encodeCharBuilder(enBranch, 5, 6, 2, 3, 4, 'Connect to Host', sidEmpty);

  const check = [];
  const jumpPatches = [];
  const emitJmpFalseToEn = () => {
    const pos = check.length;
    check.push(HBC98_OPCODES.JmpFalseLong, 0, 0, 0, 0, 0); // filled below (operand 1 = addr32, operand 2 = reg)
    return pos;
  };
  const patchJmpFalse = (pos, reg, targetPos) => {
    const delta = targetPos - pos;
    check[pos + 1] = delta & 0xff;
    check[pos + 2] = (delta >>> 8) & 0xff;
    check[pos + 3] = (delta >>> 16) & 0xff;
    check[pos + 4] = (delta >>> 24) & 0xff;
    check[pos + 5] = reg;
  };

  check.push(HBC98_OPCODES.GetGlobalObject, 0);
  emitTryGetById(check, 1, 0, 0, sidIntl);
  jumpPatches.push([emitJmpFalseToEn(), 1]);
  emitGetById(check, 2, 1, 1, sidDTF);
  jumpPatches.push([emitJmpFalseToEn(), 2]);
  check.push(HBC98_OPCODES.Call1, 1, 2, 1);
  jumpPatches.push([emitJmpFalseToEn(), 1]);
  emitGetById(check, 2, 1, 2, sidResolved);
  jumpPatches.push([emitJmpFalseToEn(), 2]);
  check.push(HBC98_OPCODES.Call1, 1, 2, 1);
  jumpPatches.push([emitJmpFalseToEn(), 1]);
  emitGetById(check, 1, 1, 3, sidLocale);
  jumpPatches.push([emitJmpFalseToEn(), 1]);
  emitGetById(check, 2, 1, 4, sidStartsWith);
  jumpPatches.push([emitJmpFalseToEn(), 2]);
  emitLoadConstString(check, 3, sidZh);
  check.push(HBC98_OPCODES.Call2, 1, 2, 1, 3);
  jumpPatches.push([emitJmpFalseToEn(), 1]);

  const enStart = check.length + zhBranch.length;
  for (const [pos, reg] of jumpPatches) patchJmpFalse(pos, reg, enStart);

  return Buffer.from([...check, ...zhBranch, ...enBranch]);
}

/**
 * Builds the 22-byte in-place Promise.resolve(false) body.
 */
function buildPromiseResolveFalse(hbc) {
  const sidPromise = requireStringId(hbc, 'Promise');
  const sidResolve = requireStringId(hbc, 'resolve');
  const bytes = [];
  bytes.push(HBC98_OPCODES.GetGlobalObject, 1);
  emitTryGetById(bytes, 2, 1, 0, sidPromise);
  if (sidResolve < 256) {
    bytes.push(HBC98_OPCODES.GetByIdShort, 1, 2, 1, sidResolve);
  } else {
    emitGetById(bytes, 1, 2, 1, sidResolve);
  }
  bytes.push(HBC98_OPCODES.LoadConstFalse, 0);
  bytes.push(HBC98_OPCODES.Call2, 1, 1, 2, 0);
  bytes.push(HBC98_OPCODES.Ret, 1);
  return Buffer.from(bytes);
}

/**
 * Builds the tail-appended BackendClient.call / callPublic body with 22 local-bypass RPC checks.
 */
function buildBackendCallBody(hbc, innerClosureFnIdx) {
  const sidPost = requireStringId(hbc, 'post');
  const sidApply = requireStringId(hbc, 'apply');
  const rpcSids = BACKEND_LOCAL_BYPASS_RPCS.map(r => requireStringId(hbc, r));

  // Fallback original async dispatch:
  //   LoadConstUndefined r0; LoadConstUndefined r1; ReifyArgumentsStrict r1; Mov r4, r1;
  //   GetBuiltinClosure r3, 57; GetParentEnvironment r1, 0; CreateClosure[Long] r2, r1, innerClosureFnIdx;
  //   LoadParam r1, 0; Call4 r1, r3, r0, r2, r1, r4; Ret r1
  const fallback = [
    HBC98_OPCODES.LoadConstUndefined, 0,
    HBC98_OPCODES.LoadConstUndefined, 1,
    HBC98_OPCODES.ReifyArgumentsStrict, 1,
    HBC98_OPCODES.Mov, 4, 1,
    HBC98_OPCODES.GetBuiltinClosure, 3, 57,
    HBC98_OPCODES.GetParentEnvironment, 1, 0,
  ];
  emitCreateClosure(fallback, 2, 1, innerClosureFnIdx);
  fallback.push(
    HBC98_OPCODES.LoadParam, 1, 0,
    HBC98_OPCODES.Call4, 1, 3, 0, 2, 1, 4,
    HBC98_OPCODES.Ret, 1,
  );

  // Local bypass: return this.post.apply(this, [arg1, arg2, undefined, arg3])
  const bypass = [HBC98_OPCODES.LoadParam, 1, 0];
  emitGetById(bypass, 2, 1, 0, sidPost);
  emitGetById(bypass, 3, 2, 1, sidApply);
  bypass.push(
    HBC98_OPCODES.NewArray, 4, 4, 0,
    HBC98_OPCODES.DefineOwnInDenseArray, 4, 0, 0,
    HBC98_OPCODES.LoadParam, 5, 2,
    HBC98_OPCODES.DefineOwnInDenseArray, 4, 5, 1,
    HBC98_OPCODES.LoadConstUndefined, 5,
    HBC98_OPCODES.DefineOwnInDenseArray, 4, 5, 2,
    HBC98_OPCODES.LoadParam, 5, 3,
    HBC98_OPCODES.DefineOwnInDenseArray, 4, 5, 3,
    HBC98_OPCODES.Call3, 0, 3, 2, 1, 4,
    HBC98_OPCODES.Ret, 0,
  );

  // Prefix: LoadParam r0, 1; for each rpcSid: LoadConstString[Long] r1, sid; JStrictEqualLong bypass, r0, r1
  const prefix = [HBC98_OPCODES.LoadParam, 0, 1];
  const jmpPositions = [];
  for (const sid of rpcSids) {
    emitLoadConstString(prefix, 1, sid);
    jmpPositions.push(prefix.length);
    prefix.push(HBC98_OPCODES.JStrictEqualLong, 0, 0, 0, 0, 0, 1);
  }
  const bypassOffset = prefix.length + fallback.length;
  for (const pos of jmpPositions) {
    const delta = bypassOffset - pos;
    prefix[pos + 1] = delta & 0xff;
    prefix[pos + 2] = (delta >>> 8) & 0xff;
    prefix[pos + 3] = (delta >>> 16) & 0xff;
    prefix[pos + 4] = (delta >>> 24) & 0xff;
  }

  return Buffer.from([...prefix, ...fallback, ...bypass]);
}

function encodeLargeFuncHeader({
  offset, paramCount, loopDepth = 0, bytecodeSize, nameId,
  numberRegCount = 0, nonPointerRegCount = 1, frameSize,
  readCacheSize, writeCacheSize, numCacheNewObject = 0, privateNameCacheSize = 0, flags = 5,
}) {
  const b = Buffer.alloc(FULL_HDR_SIZE);
  b.writeUInt32LE(offset >>> 0, 0);
  b.writeUInt32LE(paramCount >>> 0, 4);
  b.writeUInt32LE(loopDepth >>> 0, 8);
  b.writeUInt32LE(bytecodeSize >>> 0, 12);
  b.writeUInt32LE(nameId >>> 0, 16);
  b.writeUInt32LE(numberRegCount >>> 0, 20);
  b.writeUInt32LE(nonPointerRegCount >>> 0, 24);
  b.writeUInt32LE(frameSize >>> 0, 28);
  b[32] = readCacheSize & 0xff;
  b[33] = writeCacheSize & 0xff;
  b[34] = numCacheNewObject & 0xff;
  b[35] = privateNameCacheSize & 0xff;
  b[36] = flags & 0xff;
  return b;
}

function writeOverflowSmallHeader(buf, smallOff, largeOff) {
  const w0 = largeOff & 0x00ffffff;
  const w1 = (((largeOff >>> 24) & 0xff) << 14) >>> 0;
  buf.writeUInt32LE(w0 >>> 0, smallOff);
  buf.writeUInt32LE(w1 >>> 0, smallOff + 4);
  buf.writeUInt32LE((OVERFLOWED_FLAG << 24) >>> 0, smallOff + 8);
}

function findUiLabelPatches(hbc, fn, kind, donorFnIdx) {
  const insns = decodeFunction(hbc.buf, fn);
  const patches = [];

  // 1. Locate: GetById 'BuildChannel' -> GetById 'showsDebugTools' -> Call1
  let debugIdx = -1;
  for (let i = 0; i + 2 < insns.length; i++) {
    const a = insns[i], b = insns[i + 1], c = insns[i + 2];
    if (
      (a.name === 'GetById' || a.name === 'GetByIdLong') && hbc.strings[a.operands[3]] === 'BuildChannel' &&
      (b.name === 'GetById' || b.name === 'GetByIdLong') && hbc.strings[b.operands[3]] === 'showsDebugTools' &&
      c.name === 'Call1' && c.size === 4
    ) {
      debugIdx = i + 2;
      break;
    }
  }
  if (debugIdx < 0) {
    throw new Error(`Could not find BuildChannel.showsDebugTools() Call1 anchor in ${kind}`);
  }
  const debugCall = insns[debugIdx];
  const debugReg = debugCall.operands[0];
  const boolOp = kind === 'BrowserSignInScreen' ? HBC98_OPCODES.LoadConstFalse : HBC98_OPCODES.LoadConstTrue;
  patches.push({ abs: debugCall.abs, bytes: Buffer.from([boolOp, debugReg, boolOp, debugReg]) });

  // 2. Locate the 15-byte NewObjectWithBufferLong (10B) + Call2 (5B) label call(s)
  const makeLabelPatch = (newObjIns, callIns) => {
    if (newObjIns.size !== 10 || callIns.size !== 5) {
      throw new Error(`Unexpected instruction sizes in ${kind} label anchor: ${newObjIns.size}+${callIns.size}`);
    }
    const dstReg = callIns.operands[0];
    // 7B CreateClosureLongIndex + 5B Call2 + 3B Mov = 15B exact!
    const repl = Buffer.alloc(15);
    repl[0] = HBC98_OPCODES.CreateClosureLongIndex;
    repl[1] = dstReg;
    repl[2] = dstReg;
    repl.writeUInt32LE(donorFnIdx >>> 0, 3);
    repl[7] = HBC98_OPCODES.Call2;
    repl[8] = dstReg;
    repl[9] = dstReg;
    repl[10] = dstReg;
    repl[11] = dstReg;
    repl[12] = HBC98_OPCODES.Mov;
    repl[13] = dstReg;
    repl[14] = dstReg;
    return { abs: newObjIns.abs, bytes: repl };
  };

  if (kind === 'BrowserSignInScreen') {
    // First pair of NewObjectWithBufferLong + Call2 separated by Jmp (2B) after debugIdx
    let found = false;
    for (let i = debugIdx + 1; i + 4 < insns.length; i++) {
      if (
        insns[i].name === 'NewObjectWithBufferLong' &&
        insns[i + 1].name === 'Call2' &&
        insns[i + 2].name === 'Jmp' &&
        insns[i + 3].name === 'NewObjectWithBufferLong' &&
        insns[i + 4].name === 'Call2'
      ) {
        patches.push(makeLabelPatch(insns[i], insns[i + 1]));
        patches.push(makeLabelPatch(insns[i + 3], insns[i + 4]));
        found = true;
        break;
      }
    }
    if (!found) throw new Error('Could not find paired label anchors in BrowserSignInScreen');
  } else {
    // SettingsSheet: first NewObjectWithBufferLong + Call2 after BundleOverrideNative.bootedFromOverride
    let afterOverride = -1;
    for (let i = debugIdx + 1; i < insns.length; i++) {
      if (
        (insns[i].name === 'GetById' || insns[i].name === 'GetByIdLong') &&
        hbc.strings[insns[i].operands[3]] === 'bootedFromOverride'
      ) {
        afterOverride = i;
        break;
      }
    }
    if (afterOverride < 0) throw new Error('Could not find bootedFromOverride anchor in SettingsSheet');
    let found = false;
    for (let i = afterOverride + 1; i + 1 < insns.length && i < afterOverride + 15; i++) {
      if (insns[i].name === 'NewObjectWithBufferLong' && insns[i + 1].name === 'Call2') {
        patches.push(makeLabelPatch(insns[i], insns[i + 1]));
        found = true;
        break;
      }
    }
    if (!found) throw new Error('Could not find label anchor in SettingsSheet');
  }

  return patches;
}

export function discoverHbcAnchors(origBuf) {
  const hbc = parseHbcV98(origBuf);

  const backendAnalyticsMod = findModuleOwnedFunctions(hbc, ['BackendAnalyticsSink'], ['send']);
  const sendFn = backendAnalyticsMod.children.send[0];
  const sendClosures = functionClosures(hbc, sendFn);
  if (sendClosures.length !== 1) {
    throw new Error(`Expected 1 inner closure in BackendAnalyticsSink.send, got ${sendClosures.length}`);
  }
  const donorFn = hbc.functions[sendClosures[0]];

  const onePasswordMod = findModuleOwnedFunctions(hbc, ['OnePasswordAppPresence'], ['lookUp']);
  const lookUpFn = onePasswordMod.children.lookUp[0];

  const devGatewayMod = findModuleOwnedFunctions(hbc, ['DevGatewayOverride', 'dev-gateway@localhost'], ['read']);
  const readFn = devGatewayMod.children.read[0];
  if (readFn.bytecodeSize !== 4) {
    throw new Error(`Expected DevGatewayOverride.read bytecodeSize=4, got ${readFn.bytecodeSize}`);
  }

  const backendClientMod = findModuleOwnedFunctions(
    hbc,
    ['BackendClient', 'listMarketplacePlugins'],
    ['call', 'callPublic']
  );
  const callFn = backendClientMod.children.call[0];
  const callPublicFn = backendClientMod.children.callPublic[0];
  const callInner = functionClosures(hbc, callFn)[0];
  const callPublicInner = functionClosures(hbc, callPublicFn)[0];
  if (callInner === undefined || callPublicInner === undefined) {
    throw new Error('Could not resolve inner async closures for BackendClient.call / callPublic');
  }

  const anchors = {
    canRecord: findUniqueFunction(hbc, 'canRecord', fn => functionStrings(hbc, fn).has('identity'), 'canRecord'),
    record: findUniqueFunction(hbc, 'record', fn => {
      const s = functionStrings(hbc, fn);
      return s.has('Math') && s.has('sink');
    }, 'record'),
    appsFlyerStart: findUniqueFunction(hbc, 'start', fn => {
      const s = functionStrings(hbc, fn);
      return s.has('appsFlyerDisabled') && s.has('StorageKeys');
    }, 'AppsFlyerService.start'),
    brazeStart: findUniqueFunction(hbc, 'start', fn => functionStrings(hbc, fn).has('BrazeCredentials'), 'BrazeService.start'),
    log: findUniqueFunction(hbc, 'log', fn => {
      const s = functionStrings(hbc, fn);
      return s.has('baseMetadata') && s.has('flushScheduled');
    }, 'log'),
    isStatsigDisabled: findUniqueFunction(hbc, 'isStatsigDisabled', () => true, 'isStatsigDisabled'),
    shouldFetch: findUniqueFunction(hbc, 'shouldFetch', fn => functionStrings(hbc, fn).has('realIdentityOf'), 'shouldFetch'),
    sandStatsigNetworkUrlAllowed: findUniqueFunction(hbc, 'sandStatsigNetworkUrlAllowed', () => true, 'sandStatsigNetworkUrlAllowed'),
    sandSentryInit: findUniqueFunction(hbc, 'init', fn => {
      const s = functionStrings(hbc, fn);
      return s.has('SandSentryEnablement') || s.has('SandSentry.init: disabled');
    }, 'SandSentry.init'),
    stampSender: findUniqueFunction(hbc, 'stampSender', () => true, 'stampSender'),
    send: sendFn,
    donor: donorFn,
    lookUp: lookUpFn,
    read: readFn,
    call: callFn,
    callInner,
    callPublic: callPublicFn,
    callPublicInner,
    browserSignInScreen: findUniqueFunction(hbc, 'BrowserSignInScreen', () => true, 'BrowserSignInScreen'),
    settingsSheet: findUniqueFunction(hbc, 'SettingsSheet', () => true, 'SettingsSheet'),
  };

  return { hbc, anchors };
}

function writeFooterSha1AndLength(buf) {
  buf.writeUInt32LE(buf.length >>> 0, 32);
  const sha1 = crypto.createHash('sha1').update(buf.subarray(0, buf.length - FOOTER_SIZE)).digest();
  sha1.copy(buf, buf.length - FOOTER_SIZE);
  return buf;
}

export function createBytepatch(sourceBuf, targetBuf) {
  const ops = [];
  const minLen = Math.min(sourceBuf.length, targetBuf.length);
  let i = 0;
  let copyStart = -1;
  const flushCopy = (end) => {
    if (copyStart >= 0 && end > copyStart) {
      ops.push(['copy', copyStart, end - copyStart]);
    }
    copyStart = -1;
  };
  let addStart = -1;
  const flushAdd = (end) => {
    if (addStart >= 0 && end > addStart) {
      ops.push(['add', targetBuf.subarray(addStart, end).toString('base64')]);
    }
    addStart = -1;
  };

  while (i < minLen) {
    if (sourceBuf[i] === targetBuf[i]) {
      flushAdd(i);
      if (copyStart < 0) copyStart = i;
      i++;
    } else {
      // Avoid tiny 1-3B copies splitting adjacent diffs
      flushCopy(i);
      if (addStart < 0) addStart = i;
      i++;
    }
  }
  flushCopy(minLen);
  if (targetBuf.length > minLen) {
    if (addStart < 0) addStart = minLen;
    flushAdd(targetBuf.length);
  } else {
    flushAdd(minLen);
  }

  return {
    schema: 'rokbot-bytepatch/v1',
    sourceSha256: sha256Hex(sourceBuf),
    sourceBytes: sourceBuf.length,
    targetSha256: sha256Hex(targetBuf),
    targetBytes: targetBuf.length,
    ops,
  };
}

export function buildAndroidHbcRecipes(origBuf) {
  const { hbc, anchors } = discoverHbcAnchors(origBuf);
  const tailBase = origBuf.length - FOOTER_SIZE;

  const labelHelperBody = buildConnectHostLabelHelper(hbc);
  const promiseFalseBody = buildPromiseResolveFalse(hbc);
  const uiSignInPatches = findUiLabelPatches(hbc, anchors.browserSignInScreen, 'BrowserSignInScreen', anchors.donor.index);
  const uiSettingsPatches = findUiLabelPatches(hbc, anchors.settingsSheet, 'SettingsSheet', anchors.donor.index);

  const applyCommonUnpairedEdits = (buf) => {
    // 9 tiny in-place stubs
    Buffer.from([HBC98_OPCODES.LoadConstFalse, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.canRecord.offset);
    Buffer.from([HBC98_OPCODES.LoadConstUndefined, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.record.offset);
    Buffer.from([HBC98_OPCODES.LoadParam, 0, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.appsFlyerStart.offset);
    Buffer.from([HBC98_OPCODES.LoadConstUndefined, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.log.offset);
    Buffer.from([HBC98_OPCODES.LoadConstTrue, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.isStatsigDisabled.offset);
    Buffer.from([HBC98_OPCODES.LoadConstFalse, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.shouldFetch.offset);
    Buffer.from([HBC98_OPCODES.LoadConstFalse, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.sandStatsigNetworkUrlAllowed.offset);
    Buffer.from([HBC98_OPCODES.LoadParam, 0, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.brazeStart.offset);
    Buffer.from([HBC98_OPCODES.LoadConstUndefined, 0, HBC98_OPCODES.Ret, 0]).copy(buf, anchors.sandSentryInit.offset);

    // 2 Promise.resolve(false) in-place stubs (ensure readCacheSize >= 2)
    for (const fn of [anchors.send, anchors.lookUp]) {
      if (promiseFalseBody.length > fn.bytecodeSize) {
        throw new Error(`Promise.resolve(false) body (${promiseFalseBody.length}B) exceeds ${fn.name} (${fn.bytecodeSize}B)`);
      }
      promiseFalseBody.copy(buf, fn.offset);
      if (fn.overflow) {
        buf[fn.largeOff + 32] = Math.max(buf[fn.largeOff + 32], 2);
      } else {
        buf[fn.smallOff + 9] = Math.max(buf[fn.smallOff + 9], 2);
      }
    }

    // BrowserSignInScreen & SettingsSheet UI label patches
    for (const p of [...uiSignInPatches, ...uiSettingsPatches]) {
      p.bytes.copy(buf, p.abs);
    }

    // Redirect donor function (?anon_0_send) to tailBase
    if (!anchors.donor.overflow) {
      throw new Error(`Expected donor function fn[${anchors.donor.index}] to already use a LargeFuncHeader`);
    }
    const donorLfh = encodeLargeFuncHeader({
      offset: tailBase,
      paramCount: 1,
      loopDepth: 0,
      bytecodeSize: labelHelperBody.length,
      nameId: 0,
      numberRegCount: 0,
      nonPointerRegCount: 1,
      frameSize: 20,
      readCacheSize: 8,
      writeCacheSize: 0,
      flags: anchors.donor.flags,
    });
    donorLfh.subarray(0, 37).copy(buf, anchors.donor.largeOff);
  };

  // 1. Build unpaired.hbc
  const unpairedBuf = Buffer.concat([
    origBuf.subarray(0, tailBase),
    labelHelperBody,
    Buffer.alloc(FOOTER_SIZE),
  ]);
  applyCommonUnpairedEdits(unpairedBuf);
  writeFooterSha1AndLength(unpairedBuf);

  // 2. Build gateway-template.hbc
  const bodyOffset = tailBase + labelHelperBody.length;
  const bodySlot = Buffer.alloc(GATEWAY_BODY_CAPACITY);
  // Default placeholder body: NewObject r0; Ret r0
  bodySlot[0] = HBC98_OPCODES.NewObject;
  bodySlot[1] = 0;
  bodySlot[2] = HBC98_OPCODES.Ret;
  bodySlot[3] = 0;

  const callBody = buildBackendCallBody(hbc, anchors.callInner);
  const callPublicBody = buildBackendCallBody(hbc, anchors.callPublicInner);

  const callBodyOff = bodyOffset + GATEWAY_BODY_CAPACITY;
  const callPublicBodyOff = callBodyOff + callBody.length;
  const lfhRegionStart = align4(callPublicBodyOff + callPublicBody.length);
  const lfhPad = Buffer.alloc(lfhRegionStart - (callPublicBodyOff + callPublicBody.length));

  const newLfhs = [];
  let lfhCursor = lfhRegionStart;

  // DevGatewayOverride.read always gets a tail LargeFuncHeader (so bodyLengthOffset is stable)
  const readLfhOff = lfhCursor;
  lfhCursor += FULL_HDR_SIZE;
  const readLfh = encodeLargeFuncHeader({
    offset: bodyOffset,
    paramCount: 1,
    loopDepth: 0,
    bytecodeSize: 4,
    nameId: anchors.read.nameId,
    numberRegCount: 0,
    nonPointerRegCount: 1,
    frameSize: 8,
    readCacheSize: 2,
    writeCacheSize: 2,
    flags: 5, // ProhibitConstruct | StrictMode
  });
  newLfhs.push(readLfh);

  let callLfhOff = anchors.call.overflow ? anchors.call.largeOff : 0;
  if (!anchors.call.overflow) {
    callLfhOff = lfhCursor;
    lfhCursor += FULL_HDR_SIZE;
    newLfhs.push(encodeLargeFuncHeader({
      offset: callBodyOff,
      paramCount: anchors.call.paramCount,
      loopDepth: 0,
      bytecodeSize: callBody.length,
      nameId: anchors.call.nameId,
      numberRegCount: 0,
      nonPointerRegCount: 1,
      frameSize: Math.max(anchors.call.frameSize, 16),
      readCacheSize: Math.max(anchors.call.readCacheSize, 2),
      writeCacheSize: anchors.call.writeCacheSize,
      flags: 5,
    }));
  }

  let callPublicLfhOff = anchors.callPublic.overflow ? anchors.callPublic.largeOff : 0;
  if (!anchors.callPublic.overflow) {
    callPublicLfhOff = lfhCursor;
    lfhCursor += FULL_HDR_SIZE;
    newLfhs.push(encodeLargeFuncHeader({
      offset: callPublicBodyOff,
      paramCount: anchors.callPublic.paramCount,
      loopDepth: 0,
      bytecodeSize: callPublicBody.length,
      nameId: anchors.callPublic.nameId,
      numberRegCount: 0,
      nonPointerRegCount: 1,
      frameSize: Math.max(anchors.callPublic.frameSize, 16),
      readCacheSize: Math.max(anchors.callPublic.readCacheSize, 2),
      writeCacheSize: anchors.callPublic.writeCacheSize,
      flags: 5,
    }));
  }

  const gatewayBuf = Buffer.concat([
    origBuf.subarray(0, tailBase),
    labelHelperBody,
    bodySlot,
    callBody,
    callPublicBody,
    lfhPad,
    ...newLfhs,
    Buffer.alloc(FOOTER_SIZE),
  ]);
  applyCommonUnpairedEdits(gatewayBuf);

  // stampSender -> LoadConstUndefined r0; Ret r0 (gateway-template only)
  Buffer.from([HBC98_OPCODES.LoadConstUndefined, 0, HBC98_OPCODES.Ret, 0]).copy(gatewayBuf, anchors.stampSender.offset);

  // Point DevGatewayOverride.read SmallFuncHeader to readLfhOff
  writeOverflowSmallHeader(gatewayBuf, anchors.read.smallOff, readLfhOff);

  // Update BackendClient.call & callPublic headers
  if (anchors.call.overflow) {
    encodeLargeFuncHeader({
      offset: callBodyOff,
      paramCount: anchors.call.paramCount,
      loopDepth: anchors.call.loopDepth,
      bytecodeSize: callBody.length,
      nameId: anchors.call.nameId,
      numberRegCount: anchors.call.numberRegCount,
      nonPointerRegCount: anchors.call.nonPointerRegCount,
      frameSize: Math.max(anchors.call.frameSize, 16),
      readCacheSize: Math.max(anchors.call.readCacheSize, 2),
      writeCacheSize: anchors.call.writeCacheSize,
      flags: anchors.call.flags,
    }).subarray(0, 37).copy(gatewayBuf, callLfhOff);
  } else {
    writeOverflowSmallHeader(gatewayBuf, anchors.call.smallOff, callLfhOff);
  }

  if (anchors.callPublic.overflow) {
    encodeLargeFuncHeader({
      offset: callPublicBodyOff,
      paramCount: anchors.callPublic.paramCount,
      loopDepth: anchors.callPublic.loopDepth,
      bytecodeSize: callPublicBody.length,
      nameId: anchors.callPublic.nameId,
      numberRegCount: anchors.callPublic.numberRegCount,
      nonPointerRegCount: anchors.callPublic.nonPointerRegCount,
      frameSize: Math.max(anchors.callPublic.frameSize, 16),
      readCacheSize: Math.max(anchors.callPublic.readCacheSize, 2),
      writeCacheSize: anchors.callPublic.writeCacheSize,
      flags: anchors.callPublic.flags,
    }).subarray(0, 37).copy(gatewayBuf, callPublicLfhOff);
  } else {
    writeOverflowSmallHeader(gatewayBuf, anchors.callPublic.smallOff, callPublicLfhOff);
  }

  writeFooterSha1AndLength(gatewayBuf);

  // 3. Build gateway-template.json metadata
  const asciiStrings = {};
  for (let code = 32; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    const sid = hbc.stringFirstId.get(ch);
    if (sid !== undefined) {
      asciiStrings[String(code)] = sid;
    } else if (!(code >= 48 && code <= 57)) {
      throw new Error(`Missing single-character string in HBC for ASCII ${code} (${JSON.stringify(ch)})`);
    }
  }

  const bodyLengthOffset = readLfhOff + 12;
  const gatewayMeta = {
    schema: 'grokbot-native-hermes/v1',
    originalSha256: sha256Hex(origBuf),
    templateSha256: sha256Hex(gatewayBuf),
    bodyOffset,
    bodyCapacity: GATEWAY_BODY_CAPACITY,
    bodyLengthOffset,
    strings: asciiStrings,
    emptyString: requireStringId(hbc, ''),
    urlKey: requireStringId(hbc, 'url'),
    tokenKey: requireStringId(hbc, 'token'),
    opcodes: {
      NewObject: HBC98_OPCODES.NewObject,
      LoadConstString: HBC98_OPCODES.LoadConstString,
      LoadConstStringLongIndex: HBC98_OPCODES.LoadConstStringLongIndex,
      LoadConstUInt8: HBC98_OPCODES.LoadConstUInt8,
      Add: HBC98_OPCODES.Add,
      DefineOwnById: HBC98_OPCODES.DefineOwnById,
      DefineOwnByIdLong: HBC98_OPCODES.DefineOwnByIdLong,
      Ret: HBC98_OPCODES.Ret,
    },
  };
  const gatewayMetaBuf = Buffer.from(JSON.stringify(gatewayMeta, null, 2) + '\n', 'utf8');

  // 4. Create bytepatches & self-verify round-trip + synthesis
  const unpairedPatch = createBytepatch(origBuf, unpairedBuf);
  const gatewayPatch = createBytepatch(origBuf, gatewayBuf);
  const gatewayMetaPatch = {
    schema: 'rokbot-bytepatch/v1',
    sourceSha256: sha256Hex(origBuf),
    sourceBytes: origBuf.length,
    targetSha256: sha256Hex(gatewayMetaBuf),
    targetBytes: gatewayMetaBuf.length,
    ops: [['add', gatewayMetaBuf.toString('base64')]],
  };

  const verifyUnp = applyBytepatch(origBuf, unpairedPatch);
  const verifyGw = applyBytepatch(origBuf, gatewayPatch);
  const verifyMeta = applyBytepatch(origBuf, gatewayMetaPatch);
  if (!verifyUnp.equals(unpairedBuf) || !verifyGw.equals(gatewayBuf) || !verifyMeta.equals(gatewayMetaBuf)) {
    throw new Error('Bytepatch round-trip verification failed');
  }
  const testSynth = synthesizeHermesBytecode(verifyGw, gatewayMeta, 'http://127.0.0.1:18080', 'K7M9P2');
  const synthLen = testSynth.readUInt32LE(bodyLengthOffset);
  if (synthLen <= 0 || synthLen > GATEWAY_BODY_CAPACITY) {
    throw new Error(`Invalid synthesized body length: ${synthLen}`);
  }

  return {
    anchors: Object.fromEntries(
      Object.entries(anchors).map(([k, v]) => [k, typeof v === 'object' && v ? { index: v.index, name: v.name, offset: v.offset, size: v.bytecodeSize } : v])
    ),
    unpairedBuf,
    gatewayBuf,
    gatewayMeta,
    gatewayMetaBuf,
    unpairedPatch,
    gatewayPatch,
    gatewayMetaPatch,
  };
}

function main() {
  const args = process.argv.slice(2);
  let bundlePath = null;
  let versionCode = null;
  let outDir = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bundle') bundlePath = args[++i];
    else if (args[i] === '--version-code') versionCode = args[++i];
    else if (args[i] === '--out-dir') outDir = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log('Usage: build-hbc-recipe.mjs --bundle <index.android.bundle> [--version-code <N>] [--out-dir <dir>] [--dry-run]');
      process.exit(0);
    }
  }
  if (!bundlePath) {
    console.error('Missing --bundle <path>');
    process.exit(1);
  }
  const origBuf = fs.readFileSync(bundlePath);
  const result = buildAndroidHbcRecipes(origBuf);
  const suffix = versionCode ? `-${versionCode}` : '';

  const summary = {
    originalBytes: origBuf.length,
    originalSha256: result.gatewayMeta.originalSha256,
    unpairedBytes: result.unpairedBuf.length,
    unpairedSha256: result.unpairedPatch.targetSha256,
    gatewayTemplateBytes: result.gatewayBuf.length,
    gatewayTemplateSha256: result.gatewayMeta.templateSha256,
    gatewayMetaBytes: result.gatewayMetaBuf.length,
    gatewayMetaSha256: result.gatewayMetaPatch.targetSha256,
    bodyOffset: result.gatewayMeta.bodyOffset,
    bodyCapacity: result.gatewayMeta.bodyCapacity,
    bodyLengthOffset: result.gatewayMeta.bodyLengthOffset,
    emptyString: result.gatewayMeta.emptyString,
    urlKey: result.gatewayMeta.urlKey,
    tokenKey: result.gatewayMeta.tokenKey,
    anchors: result.anchors,
  };

  if (outDir && !dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    const writeGz = (name, obj) => {
      const p = path.join(outDir, name);
      fs.writeFileSync(p, zlib.gzipSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'), { level: 9 }));
      return p;
    };
    const metaPath = path.join(outDir, `gateway-template${suffix}.json`);
    fs.writeFileSync(metaPath, result.gatewayMetaBuf);
    writeGz(`unpaired${suffix}.hbc.gbp.gz`, result.unpairedPatch);
    writeGz(`gateway-template${suffix}.hbc.gbp.gz`, result.gatewayPatch);
    writeGz(`gateway-template${suffix}.json.gbp.gz`, result.gatewayMetaPatch);
    summary.written = [
      `gateway-template${suffix}.json`,
      `unpaired${suffix}.hbc.gbp.gz`,
      `gateway-template${suffix}.hbc.gbp.gz`,
      `gateway-template${suffix}.json.gbp.gz`,
    ];
  }

  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
