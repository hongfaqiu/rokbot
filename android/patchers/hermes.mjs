// Hermes Bytecode (HBC v98) synthesizer, bytepatch applier, and bundle patcher for React Native Android.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { rebrandPinnedHermesResources } from './hermes-settings.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RECIPES_DIR = path.resolve(__dirname, '../recipes');

export const HBC_VERSION = 98;
export const HBC_MAGIC = 0x1f060603; // or byte sequence [0x1f, 0x06, 0x06, 0x03] / 0x1f48031f008858
const BYTEPATCH_SCHEMA = 'rokbot-bytepatch/v1';
const SUPPORTED_BYTEPATCH_SCHEMAS = new Set([BYTEPATCH_SCHEMA, 'grokbot-bytepatch/v1']);
const BYTEPATCH_MAX_BYTES = 512 * 1024 * 1024;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function loadBytepatchRecipe(gzPath) {
  const compressed = fs.readFileSync(gzPath);
  const raw = gunzipSync(compressed, { maxOutputLength: BYTEPATCH_MAX_BYTES });
  return JSON.parse(raw.toString('utf8'));
}

export function applyBytepatch(sourceBuffer, recipe) {
  if (!recipe || !SUPPORTED_BYTEPATCH_SCHEMAS.has(recipe.schema)) {
    throw new Error('Unsupported bytepatch schema');
  }
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length !== recipe.sourceBytes || sha256Hex(sourceBuffer) !== recipe.sourceSha256) {
    throw new Error('Unsupported original bundle: SHA-256 mismatch');
  }
  const targetBytes = recipe.targetBytes;
  if (!Number.isInteger(targetBytes) || targetBytes < 0 || targetBytes > BYTEPATCH_MAX_BYTES) {
    throw new Error('Invalid bytepatch output size');
  }
  const parts = [];
  let total = 0;
  for (const op of recipe.ops || []) {
    if (!Array.isArray(op)) throw new Error('Invalid bytepatch operation');
    let chunk;
    if (op[0] === 'copy' && op.length === 3) {
      const start = op[1];
      const length = op[2];
      if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 1 || start + length > sourceBuffer.length) {
        throw new Error('Invalid bytepatch COPY range');
      }
      chunk = sourceBuffer.subarray(start, start + length);
    } else if (op[0] === 'add' && op.length === 2 && typeof op[1] === 'string') {
      chunk = Buffer.from(op[1], 'base64');
    } else {
      throw new Error('Invalid bytepatch operation');
    }
    if (total + chunk.length > targetBytes) {
      throw new Error('Bytepatch output overflow');
    }
    parts.push(chunk);
    total += chunk.length;
  }
  const result = Buffer.concat(parts, total);
  if (result.length !== targetBytes || sha256Hex(result) !== recipe.targetSha256) {
    throw new Error('Bytepatch output verification failed');
  }
  return result;
}

function resolveRecipeSet(recipesDir = RECIPES_DIR, { actualSha256 = null, versionCode = null } = {}) {
  const candidates = [];
  const seenSuffix = new Set();
  const addCandidate = (suffix) => {
    if (seenSuffix.has(suffix)) return;
    seenSuffix.add(suffix);
    const metaPath = path.join(recipesDir, `gateway-template${suffix}.json`);
    const unpairedPath = path.join(recipesDir, `unpaired${suffix}.hbc.gbp.gz`);
    const templateHbcPath = path.join(recipesDir, `gateway-template${suffix}.hbc.gbp.gz`);
    const templateJsonPath = path.join(recipesDir, `gateway-template${suffix}.json.gbp.gz`);
    if (fs.existsSync(metaPath)) {
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      candidates.push({ suffix, metaPath, meta, unpairedPath, templateHbcPath, templateJsonPath });
    }
  };

  if (versionCode != null) addCandidate(`-${versionCode}`);
  try {
    const manifestPath = path.join(recipesDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m?.build) addCandidate(`-${m.build}`);
    }
  } catch {}
  try {
    for (const name of fs.readdirSync(recipesDir).sort()) {
      const m = /^gateway-template(-\d+)\.json$/.exec(name);
      if (m) addCandidate(m[1]);
    }
  } catch {}
  addCandidate('');

  if (actualSha256) {
    const exact = candidates.find(c => c.meta?.originalSha256 === actualSha256);
    if (exact) return exact;
  }
  return candidates[0] || {
    suffix: '',
    metaPath: path.join(recipesDir, 'gateway-template.json'),
    meta: null,
    unpairedPath: path.join(recipesDir, 'unpaired.hbc.gbp.gz'),
    templateHbcPath: path.join(recipesDir, 'gateway-template.hbc.gbp.gz'),
    templateJsonPath: path.join(recipesDir, 'gateway-template.json.gbp.gz'),
  };
}

export function synthesizePinnedResources(origBundleBuffer, recipesDir = RECIPES_DIR, { versionCode = null } = {}) {
  const actualSha256 = sha256Hex(origBundleBuffer);
  const set = resolveRecipeSet(recipesDir, { actualSha256, versionCode });
  const { unpairedPath, templateHbcPath, templateJsonPath } = set;
  if (!fs.existsSync(unpairedPath) || !fs.existsSync(templateHbcPath) || !fs.existsSync(templateJsonPath)) {
    throw new Error(`Missing .gbp.gz recipe files in ${recipesDir} (suffix=${set.suffix || 'default'})`);
  }
  const unpairedHbc = applyBytepatch(origBundleBuffer, loadBytepatchRecipe(unpairedPath));
  const gatewayTemplateHbc = applyBytepatch(origBundleBuffer, loadBytepatchRecipe(templateHbcPath));
  const gatewayTemplateJson = applyBytepatch(origBundleBuffer, loadBytepatchRecipe(templateJsonPath));
  return {
    unpairedHbc,
    gatewayTemplateHbc,
    gatewayTemplateJson,
    gatewayMeta: JSON.parse(gatewayTemplateJson.toString('utf8')),
  };
}

export function loadGatewayTemplateMetadata(pathOrOptions = null) {
  if (typeof pathOrOptions === 'string' && fs.existsSync(pathOrOptions)) {
    return JSON.parse(fs.readFileSync(pathOrOptions, 'utf8'));
  }
  const recipesDir = (pathOrOptions && typeof pathOrOptions === 'object' && pathOrOptions.recipesDir) || RECIPES_DIR;
  const versionCode = (pathOrOptions && typeof pathOrOptions === 'object' && pathOrOptions.versionCode) || null;
  const set = resolveRecipeSet(recipesDir, { versionCode });
  if (!set.meta) {
    throw new Error(`gateway-template.json not found at ${set.metaPath}`);
  }
  return set.meta;
}

/**
 * Dynamically synthesizes Hermes HBC v98 bytecode body and updates the bundle footer SHA-1.
 */
export function synthesizeHermesBytecode(templateBundle, meta, url, token = '') {
  const {
    opcodes,
    strings,
    emptyString,
    urlKey,
    tokenKey,
    bodyOffset,
    bodyCapacity,
    bodyLengthOffset
  } = meta;

  const buf = Buffer.alloc(bodyCapacity);
  let pos = 0;

  const putU8 = (val) => { buf.writeUInt8(val & 0xff, pos++); };
  const putU16LE = (val) => { buf.writeUInt16LE(val, pos); pos += 2; };
  const putU32LE = (val) => { buf.writeUInt32LE(val >>> 0, pos); pos += 4; };

  const loadStr = (reg, idx) => {
    if (idx < 65536) {
      putU8(opcodes.LoadConstString);
      putU8(reg);
      putU16LE(idx);
    } else {
      putU8(opcodes.LoadConstStringLongIndex);
      putU8(reg);
      putU32LE(idx);
    }
  };

  // 1. NewObject reg 0
  putU8(opcodes.NewObject);
  putU8(0);

  const values = [url || '', token || ''];
  const keys = [urlKey, tokenKey];

  for (let cache = 0; cache < 2; cache++) {
    loadStr(1, emptyString);
    const val = values[cache];
    for (let i = 0; i < val.length; i++) {
      const c = val[i];
      const code = String(c.charCodeAt(0));
      if (strings[code] !== undefined) {
        loadStr(2, strings[code]);
      } else if (c >= '0' && c <= '9') {
        putU8(opcodes.LoadConstUInt8);
        putU8(2);
        putU8(c.charCodeAt(0) - '0'.charCodeAt(0));
      } else {
        throw new Error(`Unsupported character in connection config: '${c}' (code ${code})`);
      }
      // Add reg 1, reg 1, reg 2
      putU8(opcodes.Add);
      putU8(1);
      putU8(1);
      putU8(2);
    }

    const keyIdx = keys[cache];
    if (keyIdx < 65536) {
      putU8(opcodes.DefineOwnById);
      putU8(0);
      putU8(1);
      putU8(cache);
      putU16LE(keyIdx);
    } else {
      putU8(opcodes.DefineOwnByIdLong);
      putU8(0);
      putU8(1);
      putU8(cache);
      putU32LE(keyIdx);
    }
  }

  // Ret reg 0
  putU8(opcodes.Ret);
  putU8(0);

  const bodyLen = pos;
  if (bodyLen > bodyCapacity) {
    throw new Error(`Synthesized bytecode length (${bodyLen}) exceeds capacity (${bodyCapacity})`);
  }

  const minLength = Math.max(bodyOffset + bodyCapacity + 20, bodyLengthOffset + 24);
  if (!Buffer.isBuffer(templateBundle) || templateBundle.length < minLength) {
    throw new RangeError(
      `Bundle buffer size (${templateBundle ? templateBundle.length : 0}) out of bounds for template body (requires at least ${minLength} bytes)`
    );
  }

  const bundle = Buffer.from(templateBundle);
  buf.copy(bundle, bodyOffset, 0, bodyLen);

  // Zero-fill remaining body capacity
  bundle.fill(0, bodyOffset + bodyLen, bodyOffset + bodyCapacity);

  // Update body length at bodyLengthOffset (uint32 LE)
  bundle.writeUInt32LE(bodyLen, bodyLengthOffset);

  // Recalculate trailing 20-byte SHA-1
  const sha1 = crypto.createHash('sha1').update(bundle.subarray(0, bundle.length - 20)).digest();
  sha1.copy(bundle, bundle.length - 20);

  return bundle;
}

/**
 * Patches Hermes bundle safely: checks recipe SHA-256 pin and buffer bounds before splicing.
 * When patching an unpinned/dummy or mismatched APK build without force=true, leaves the HBC untouched
 * so the native companion (`assets/rokbot-preconfig.json` + `NetworkInterceptor`) handles Host routing safely.
 */
export function patchHermesBundleSafely(bundleBuffer, { host, pairingCode, token, meta, recipesDir = RECIPES_DIR, versionCode = null, force = false, rebrandSettings = true } = {}) {
  const actualSha256 = sha256Hex(bundleBuffer);
  const resolved = meta ? { meta } : resolveRecipeSet(recipesDir, { actualSha256, versionCode });
  const metadata = resolved.meta || loadGatewayTemplateMetadata({ recipesDir, versionCode });
  const pinMatched = metadata.originalSha256 ? actualSha256 === metadata.originalSha256 : null;

  if (metadata.originalSha256 && actualSha256 === metadata.originalSha256) {
    const recipeOutputs = synthesizePinnedResources(bundleBuffer, recipesDir, { versionCode });
    // RokBot settings-sheet rebrand (in-place, size-preserving; see hermes-settings.mjs).
    const pinned = rebrandSettings
      ? rebrandPinnedHermesResources(recipeOutputs)
      : { ...recipeOutputs, settingsRebrand: { applied: false, reason: 'disabled', edits: [] } };
    if (!host) {
      return {
        buffer: pinned.unpairedHbc,
        patched: true,
        bytepatchApplied: true,
        mode: 'bytepatch-unpaired',
        pinMatched: true,
        actualSha256,
        unpairedHbc: pinned.unpairedHbc,
        gatewayTemplateHbc: pinned.gatewayTemplateHbc,
        gatewayTemplateJson: pinned.gatewayTemplateJson,
        settingsRebrand: pinned.settingsRebrand,
        reason: 'Applied pinned unpaired.hbc bytepatch and prepared gateway-template assets',
      };
    }
    const synthesized = synthesizeHermesBytecode(
      pinned.gatewayTemplateHbc,
      pinned.gatewayMeta,
      host,
      token || pairingCode || ''
    );
    return {
      buffer: synthesized,
      patched: true,
      bytepatchApplied: true,
      mode: 'bytepatch-hbc-synthesized',
      pinMatched: true,
      actualSha256,
      unpairedHbc: pinned.unpairedHbc,
      gatewayTemplateHbc: pinned.gatewayTemplateHbc,
      gatewayTemplateJson: pinned.gatewayTemplateJson,
      settingsRebrand: pinned.settingsRebrand,
      reason: 'Applied pinned gateway-template bytepatch, synthesized HBC v98 config, and updated footer SHA-1',
    };
  }

  if (!host) {
    return {
      buffer: bundleBuffer,
      patched: false,
      bytepatchApplied: false,
      mode: 'unpaired',
      pinMatched,
      actualSha256,
      reason: 'Unpaired mode: native companion handles runtime pairing via Storage & NetworkInterceptor',
    };
  }

  const minLength = Math.max(metadata.bodyOffset + metadata.bodyCapacity + 20, metadata.bodyLengthOffset + 24);
  const isSyntheticTestBundle = bundleBuffer.length >= 8 && bundleBuffer.subarray(0, 8).equals(Buffer.alloc(8));
  if (!force && bundleBuffer.length < minLength) {
    return {
      buffer: bundleBuffer,
      patched: false,
      bytepatchApplied: false,
      mode: 'companion-runtime-fallback',
      pinMatched,
      actualSha256,
      reason: `Bundle size (${bundleBuffer.length}) < required HBC offset (${minLength}); using native companion preconfig & OkHttp interceptor`,
    };
  }
  if (!force && !isSyntheticTestBundle && metadata.originalSha256 && !pinMatched) {
    return {
      buffer: bundleBuffer,
      patched: false,
      bytepatchApplied: false,
      mode: 'companion-runtime-fallback',
      pinMatched: false,
      actualSha256,
      reason: `Bundle SHA-256 (${actualSha256}) does not match recipe pin (${metadata.originalSha256}); using native companion preconfig & OkHttp interceptor`,
    };
  }

  const synthesized = synthesizeHermesBytecode(bundleBuffer, metadata, host, token || pairingCode || '');
  return {
    buffer: synthesized,
    patched: true,
    bytepatchApplied: false,
    mode: pinMatched ? 'hbc-synthesized' : 'hbc-synthesized-unpinned',
    pinMatched,
    actualSha256,
    reason: 'HBC v98 gateway config synthesized and footer SHA-1 updated',
  };
}

/**
 * Patches Hermes bundle in APK assets and suppresses Expo Updates in configuration files.
 */
export function patchHermesBundle(bundleBuffer, { host, pairingCode, token, meta } = {}) {
  const metadata = meta || loadGatewayTemplateMetadata();

  if (!host) {
    // Unpaired mode: return unmodified bundle or apply unpaired recipe if provided
    return bundleBuffer;
  }

  return synthesizeHermesBytecode(bundleBuffer, metadata, host, token || pairingCode || '');
}

/**
 * Suppresses Expo Updates in asset config JSONs.
 */
export function suppressExpoUpdates(configObj) {
  if (typeof configObj !== 'object' || configObj === null) return configObj;
  const clone = JSON.parse(JSON.stringify(configObj));
  if (typeof clone.name === 'string' && /^grok\s*bot$/i.test(clone.name.trim())) {
    clone.name = 'RokBot';
  }
  if (typeof clone.extra?.expoClient?.name === 'string' && /^grok\s*bot$/i.test(clone.extra.expoClient.name.trim())) {
    clone.extra.expoClient.name = 'RokBot';
  }
  if (clone.updates) {
    clone.updates.enabled = false;
    clone.updates.checkOnLaunch = 'NEVER';
    clone.updates.useEmbeddedUpdate = true;
    delete clone.updates.url;
    delete clone.updates.codeSigningCertificate;
    delete clone.updates.codeSigningMetadata;
  }
  if (clone.extra?.updates) {
    clone.extra.updates.enabled = false;
    clone.extra.updates.checkOnLaunch = 'NEVER';
    delete clone.extra.updates.url;
  }
  return clone;
}
