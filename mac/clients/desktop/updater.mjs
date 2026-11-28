import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyDeltaFile,
  canonicalDesktopDeltasPayload,
  readAsarHeaderInfo,
  sha256File,
} from '../shared/delta.mjs';

export const DESKTOP_UPDATE_SCHEMA = 'rokbot-desktop-update/v1';
const SUPPORTED_DESKTOP_UPDATE_SCHEMAS = new Set([DESKTOP_UPDATE_SCHEMA, 'grokbot-desktop-update/v1']);

export function buildWindowsDelayedInstallCommand(installerPath, pid = process.pid) {
  const escaped = String(installerPath).replace(/'/g, "''");
  const script = `try { Wait-Process -Id ${Number(pid)} -Timeout 30 -ErrorAction SilentlyContinue } catch {}; Start-Process -FilePath '${escaped}' -ArgumentList '/S','/LAUNCH' -WindowStyle Hidden`;
  return ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script];
}

export function createTailcatUpdateFetch({
  isTunneled = () => false,
  getServerUrl = () => '',
  getToken = () => '',
  fetchImpl = fetch,
} = {}) {
  return async (targetUrl, init = {}) => {
    const serverUrl = String(getServerUrl() ?? '').trim().replace(/\/+$/, '');
    const token = String(getToken() ?? '').trim();
    let sameOrigin = false;
    if (serverUrl) {
      try {
        sameOrigin = new URL(targetUrl).origin === new URL(serverUrl).origin;
      } catch {}
    }
    if (sameOrigin) {
      if (!token) return fetchImpl(targetUrl, init);
      const headers = new Headers(init.headers ?? {});
      headers.set('authorization', `Bearer ${token}`);
      return fetchImpl(targetUrl, { ...init, headers });
    }
    if (!isTunneled() || !serverUrl || !token) {
      return fetchImpl(targetUrl, init);
    }
    const proxyUrl = `${serverUrl}/local/updates/fetch?url=${encodeURIComponent(targetUrl)}`;
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `Bearer ${token}`);
    try {
      const res = await fetchImpl(proxyUrl, { ...init, headers });
      if ([404, 405, 501].includes(res.status)) {
        await res.body?.cancel?.().catch(() => {});
        return fetchImpl(targetUrl, init);
      }
      return res;
    } catch (err) {
      if (init.signal?.aborted) throw err;
      return fetchImpl(targetUrl, init);
    }
  };
}

export { createTailcatUpdateFetch as createDesktopUpdateFetch };

const SHA_HEX_RE = /^[a-f0-9]{64}$/i;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;

export function normalizeEcPublicKey(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Empty update public key');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Update public key must be ECDSA P-256 (prime256v1)');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function validUpdateUrl(raw, { allowOrigin } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1' && (!allowOrigin || parsed.origin !== allowOrigin)) {
    return null;
  }
  return parsed.href.replace(/\/+$/, '');
}

const DESKTOP_FEED_SUFFIX_RE = /\/((?:macos|windows|linux|darwin-arm64|darwin-x64|win32-x64|linux-x64|linux-arm64)(?:-[a-z0-9_-]+)?\.json)$/i;

export function normalizeDesktopUpdateUrl(rawUrl, explicitFeedFile = null) {
  const clean = String(rawUrl ?? '').trim().replace(/\/+$/, '');
  const match = DESKTOP_FEED_SUFFIX_RE.exec(clean);
  if (match) {
    return {
      baseUpdateUrl: clean.slice(0, -match[0].length),
      feedFile: explicitFeedFile || match[1],
    };
  }
  return {
    baseUpdateUrl: clean,
    feedFile: explicitFeedFile || null,
  };
}

function resolveManifestUrl(rawUrl, feedUrl, allowOrigin) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  const trimmed = rawUrl.trim();
  const direct = validUpdateUrl(trimmed, { allowOrigin });
  if (direct) return direct;
  if (!feedUrl) return null;
  try {
    const resolved = new URL(trimmed, feedUrl).href;
    return validUpdateUrl(resolved, { allowOrigin });
  } catch {
    return null;
  }
}

function platformMatches(manifestPlatform, platformId) {
  if (typeof manifestPlatform !== 'string' || !manifestPlatform) return false;
  if (manifestPlatform === platformId) return true;
  if (platformId.startsWith('darwin-') && manifestPlatform === 'macos') return true;
  if (platformId.startsWith('win32-') && manifestPlatform === 'windows') return true;
  if (platformId.startsWith('linux-') && manifestPlatform === 'linux') return true;
  return false;
}

function flattenManifestForVerification(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const latest = manifest.latest && typeof manifest.latest === 'object' ? manifest.latest : null;
  if (!latest) return manifest;
  return {
    ...manifest,
    platform: manifest.platform ?? latest.platform,
    track: manifest.track ?? latest.track,
    version: manifest.version ?? latest.version,
    sha256: manifest.sha256 ?? latest.sha256,
    size: manifest.size ?? latest.size,
    url: manifest.url ?? latest.url,
    publishedAt: manifest.publishedAt ?? latest.publishedAt,
    asarSha256: manifest.asarSha256 ?? latest.asarSha256,
    asarHeaderSha256: manifest.asarHeaderSha256 ?? latest.asarHeaderSha256,
    deltas: manifest.deltas ?? latest.deltas,
    asarDeltas: manifest.asarDeltas ?? latest.asarDeltas,
    deltasSignature: manifest.deltasSignature ?? latest.deltasSignature,
  };
}

export function canonicalDesktopPayload(record) {
  return [
    record.schema,
    record.platform,
    record.track,
    record.version,
    String(record.sha256).toLowerCase(),
    String(record.size),
    record.url,
    record.publishedAt,
  ].join('\n');
}

export function verifyDesktopManifest(manifest, publicKeySpkiBase64) {
  if (!manifest || !SUPPORTED_DESKTOP_UPDATE_SCHEMAS.has(manifest.schema)) throw new Error('Malformed desktop update feed');
  if (manifest.signatureAlgorithm !== undefined && manifest.signatureAlgorithm !== 'ecdsa-p256-sha256') {
    throw new Error('Unsupported desktop update signature algorithm');
  }
  const flat = flattenManifestForVerification(manifest);
  const key = createPublicKey({ key: Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64'), format: 'der', type: 'spki' });
  const ok = verify(
    'sha256',
    Buffer.from(canonicalDesktopPayload(flat), 'utf8'),
    key,
    Buffer.from(String(manifest.signature || ''), 'base64'),
  );
  if (!ok) throw new Error('Invalid desktop manifest signature');
  return manifest;
}

export function verifyDesktopDeltasManifest(manifest, publicKeySpkiBase64, { feedUrl, allowOrigin } = {}) {
  verifyDesktopManifest(manifest, publicKeySpkiBase64);
  const flat = flattenManifestForVerification(manifest);
  if (typeof flat.deltasSignature !== 'string' || !flat.deltasSignature) {
    throw new Error('Missing desktop delta signature');
  }
  const key = createPublicKey({ key: Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64'), format: 'der', type: 'spki' });
  const ok = verify(
    'sha256',
    Buffer.from(canonicalDesktopDeltasPayload(flat), 'utf8'),
    key,
    Buffer.from(flat.deltasSignature, 'base64'),
  );
  if (!ok) throw new Error('Invalid desktop delta signature');

  for (const d of flat.deltas ?? []) {
    if (!d || !SHA_HEX_RE.test(String(d.baseSha256 || '')) || !Number.isSafeInteger(d.baseSize) || d.baseSize <= 0 ||
        !SHA_HEX_RE.test(String(d.sha256 || '')) || !Number.isSafeInteger(d.size) || d.size <= 0 ||
        !resolveManifestUrl(d.url, feedUrl, allowOrigin)) {
      throw new Error('Malformed installer delta record');
    }
  }
  for (const a of flat.asarDeltas ?? []) {
    if (!a || !SHA_HEX_RE.test(String(a.baseSha256 || '')) || !Number.isSafeInteger(a.baseSize) || a.baseSize <= 0 ||
        !SHA_HEX_RE.test(String(a.targetSha256 || '')) || !Number.isSafeInteger(a.targetSize) || a.targetSize <= 0 ||
        !SHA_HEX_RE.test(String(a.targetHeaderSha256 || '')) ||
        !SHA_HEX_RE.test(String(a.sha256 || '')) || !Number.isSafeInteger(a.size) || a.size <= 0 ||
        !resolveManifestUrl(a.url, feedUrl, allowOrigin)) {
      throw new Error('Malformed ASAR delta record');
    }
  }
  return true;
}

export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

export async function loadDesktopUpdateConfig({ resourcesDir, profileDir } = {}) {
  for (const candidate of [
    resourcesDir && path.join(resourcesDir, 'rokbot-local-update.json'),
    resourcesDir && path.join(resourcesDir, 'rokbot-local.patch.json'),
    profileDir && path.join(profileDir, 'rokbot-local-update.json'),
    resourcesDir && path.join(resourcesDir, 'grokbot-local-update.json'),
    resourcesDir && path.join(resourcesDir, 'grokbot-local.patch.json'),
    profileDir && path.join(profileDir, 'grokbot-local-update.json'),
  ].filter(Boolean)) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8'));
      const updateUrl = validUpdateUrl(parsed.updateUrl);
      if (updateUrl && parsed.updatePublicKey) {
        return {
          updateUrl,
          updatePublicKey: normalizeEcPublicKey(parsed.updatePublicKey),
          builtAt: typeof parsed.patchedAt === 'string' ? parsed.patchedAt : typeof parsed.builtAt === 'string' ? parsed.builtAt : undefined,
        };
      }
    } catch {}
  }
  return null;
}

export async function resolveDesktopUpdateSource({
  resourcesDir,
  profileDir,
  server,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const staticConfig = await loadDesktopUpdateConfig({ resourcesDir, profileDir });
  if (staticConfig) return staticConfig;
  if (typeof server !== 'string' || !server.trim()) return null;
  let parsed;
  try { parsed = new URL(server.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const serverOrigin = parsed.origin;
  const updateUrl = `${parsed.href.replace(/\/+$/, '')}/local/updates`;
  const feedFile = String(platform).startsWith('win32')
    ? 'windows.json'
    : String(platform).startsWith('linux')
      ? `linux-${arch === 'arm64' ? 'arm64' : 'x64'}.json`
      : 'macos.json';
  return {
    updateUrl,
    feedFile,
    allowOrigin: serverOrigin,
    hostOrigin: serverOrigin,
    allowHostManifestKey: true,
  };
}

function sha256FileSync(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function parseContentRangeStart(header) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header || '').trim());
  return m ? Number(m[1]) : null;
}

async function downloadVerifiedFile({
  fetchImpl,
  url,
  expectedSize,
  expectedSha256,
  tmpFile,
  isCurrentGen,
  onProgress,
  maxRetries = 3,
  retryDelayMs = 300,
}) {
  const expectedLower = String(expectedSha256 || '').toLowerCase();
  let lastErr = null;
  for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt++) {
    if (!isCurrentGen()) {
      await rm(tmpFile, { force: true }).catch(() => {});
      return false;
    }
    let resumeFrom = 0;
    try {
      const existing = await stat(tmpFile);
      if (existing.isFile()) {
        if (existing.size === expectedSize) {
          const existingSha = await sha256File(tmpFile);
          if (existingSha === expectedLower) {
            onProgress(1);
            return true;
          }
          await rm(tmpFile, { force: true }).catch(() => {});
        } else if (existing.size > 0 && existing.size < expectedSize) {
          resumeFrom = existing.size;
        } else {
          await rm(tmpFile, { force: true }).catch(() => {});
        }
      }
    } catch {}

    let handle = null;
    try {
      const dl = await fetchImpl(url, {
        cache: 'no-store',
        ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}),
        signal: AbortSignal.timeout(300000),
      });
      if (dl.status === 416) {
        await dl.body?.cancel?.().catch(() => {});
        const st = await stat(tmpFile).catch(() => null);
        if (st?.isFile() && st.size === expectedSize) {
          const actualSha = await sha256File(tmpFile);
          if (actualSha === expectedLower) {
            onProgress(1);
            return true;
          }
        }
        await rm(tmpFile, { force: true }).catch(() => {});
        throw Object.assign(new Error('HTTP 416 restarting partial download'), { kind: 'update_failed', retryable: true });
      }
      if (!dl.ok || !dl.body) {
        await dl.body?.cancel?.().catch(() => {});
        const terminal = [401, 403, 404].includes(dl.status);
        throw Object.assign(new Error(`Download HTTP ${dl.status}`), {
          kind: 'update_failed',
          retryable: !terminal,
        });
      }

      const rangeStart = dl.status === 206 ? parseContentRangeStart(dl.headers?.get?.('content-range')) : null;
      const appending = Boolean(resumeFrom > 0 && dl.status === 206 && (rangeStart === null || rangeStart === resumeFrom));
      let received = appending ? resumeFrom : 0;
      const contentLen = Number(dl.headers?.get?.('content-length')) || 0;
      const total = expectedSize || (contentLen > 0 ? received + contentLen : expectedSize);
      handle = await open(tmpFile, appending ? 'a' : 'w');
      let lastReport = 0;
      if (appending && total > 0) onProgress(Math.min(1, received / total));

      for await (const chunk of dl.body) {
        if (!isCurrentGen()) throw Object.assign(new Error('Track changed'), { retryable: false });
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buf.length;
        if (received > MAX_INSTALLER_BYTES) {
          throw Object.assign(new Error('Artifact too large'), { kind: 'update_failed', retryable: false });
        }
        let off = 0;
        while (off < buf.length) {
          const { bytesWritten } = await handle.write(buf, off, buf.length - off);
          if (bytesWritten <= 0) throw new Error('Short write downloading update');
          off += bytesWritten;
        }
        const now = Date.now();
        if (now - lastReport >= 250 && total > 0) {
          lastReport = now;
          onProgress(Math.min(1, received / total));
        }
      }
      await handle.close();
      handle = null;

      if (!isCurrentGen()) {
        await rm(tmpFile, { force: true }).catch(() => {});
        return false;
      }

      const stAfter = await stat(tmpFile);
      const actualSha = await sha256File(tmpFile);
      if (stAfter.size !== expectedSize || actualSha !== expectedLower) {
        await rm(tmpFile, { force: true }).catch(() => {});
        throw Object.assign(new Error('Downloaded update checksum mismatch'), {
          kind: 'installer_signature_invalid',
          retryable: false,
        });
      }
      return true;
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (!isCurrentGen()) {
        await rm(tmpFile, { force: true }).catch(() => {});
        return false;
      }
      const retryable = err.retryable !== false && err.kind !== 'installer_signature_invalid';
      if (!retryable) {
        await rm(tmpFile, { force: true }).catch(() => {});
        throw Object.assign(err, { kind: err.kind ?? 'update_failed' });
      }
      lastErr = Object.assign(err, { kind: err.kind ?? 'update_failed' });
      if (attempt < maxRetries && retryDelayMs > 0) {
        await new Promise(r => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }
  throw lastErr ?? Object.assign(new Error('Download failed'), { kind: 'update_failed' });
}

async function findMatchingBaseInstaller(updatesDir, deltas) {
  const entries = await readdir(updatesDir).catch(() => []);
  const sizeMatches = new Map();
  for (const name of entries) {
    if (!name.startsWith('ready-') && !name.startsWith('base-')) continue;
    if (name.endsWith('.json') || name.includes('.tmp-')) continue;
    const full = path.join(updatesDir, name);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    for (const d of deltas) {
      if (d.baseSize === info.size) {
        sizeMatches.set(full, d);
        break;
      }
    }
  }
  for (const [full] of sizeMatches) {
    const sha = await sha256File(full).catch(() => '');
    const matched = deltas.find(d => d.baseSha256.toLowerCase() === sha);
    if (matched) return { baseFile: full, delta: matched };
  }
  return null;
}

async function pruneOldInstallers(updatesDir, keepFile, track, ext) {
  const entries = await readdir(updatesDir).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (name.includes('.tmp-')) {
      await rm(path.join(updatesDir, name), { force: true }).catch(() => {});
      continue;
    }
    const full = path.join(updatesDir, name);
    if (full === keepFile) continue;
    if (name.startsWith(`ready-${track}-`) && name.endsWith(ext)) {
      const info = await stat(full).catch(() => null);
      if (info?.isFile()) candidates.push({ full, mtimeMs: info.mtimeMs });
    }
  }
  // Keep 1 newest prior installer as base-<track><ext> for future binary delta patches.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length > 0) {
    const baseKeep = path.join(updatesDir, `base-${track}${ext}`);
    await rename(candidates[0].full, baseKeep).catch(() => {});
    for (const stale of candidates.slice(1)) {
      await rm(stale.full, { force: true }).catch(() => {});
    }
  }
}

export function createDesktopUpdater({
  appVersion,
  platformId = `${process.platform}-${process.arch}`,
  profileDir,
  resourcesDir,
  execPath = process.execPath,
  config = null,
  onStatus = () => {},
  onInstallFile = async () => {},
  onInstallAsar = null,
  canUseAsarUpdate = null,
  fetchImpl = fetch,
  retryDelayMs = 300,
} = {}) {
  const enabled = Boolean(
    config?.updateUrl &&
    (config?.updatePublicKey || (config?.allowHostManifestKey === true && config?.hostOrigin)),
  );
  const prefsFile = enabled && profileDir ? path.join(profileDir, 'updater-prefs.json') : null;
  let savedPrefs = {};
  if (prefsFile) {
    try { savedPrefs = JSON.parse(readFileSync(prefsFile, 'utf8')) ?? {}; } catch {}
  }
  let track = ['stable', 'nightly', 'dogfood'].includes(savedPrefs.track) ? savedPrefs.track : 'stable';
  // Default background auto-download ON unless explicitly disabled in Settings.
  let autoUpdateWhenIdle = savedPrefs.autoUpdateWhenIdle !== false;
  let state = enabled ? { type: 'idle' } : { type: 'disabled', reason: 'disabled-by-env' };
  let stagedFile = null;
  let stagedAsarInfo = null;
  let stagedVersion = null;
  let stagedMeta = null;
  let checking = null;
  let checkGeneration = 0;

  const pendingMetaPath = targetTrack =>
    profileDir ? path.join(profileDir, 'updates', `pending-${targetTrack}.json`) : null;

  const savePrefs = () => {
    if (!prefsFile) return;
    try {
      mkdirSync(path.dirname(prefsFile), { recursive: true });
      const tmp = `${prefsFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ track, autoUpdateWhenIdle }, null, 2));
      renameSync(tmp, prefsFile);
    } catch {}
  };

  const status = () => ({
    state,
    currentVersion: appVersion ?? '',
    ...(config?.builtAt ? { currentBuiltAt: config.builtAt } : {}),
    currentTrack: track,
    trackOverride: null,
    buildDefaultTrack: enabled ? 'stable' : null,
    availableTracks: enabled ? ['stable', 'nightly'] : ['stable'],
    isTrackManagedByPolicy: !enabled,
    delivery: enabled ? 'in-app' : 'package-manager',
    isBelowMinimumVersion: false,
    autoUpdateWhenIdle,
  });

  const emit = nextState => {
    state = nextState;
    const snap = status();
    try { onStatus(snap); } catch {}
    return snap;
  };

  const resolveVerificationKey = (rawManifest, feedUrl) => {
    const manifestKeyRaw = rawManifest?.publicKeyPem ?? rawManifest?.publicKeySpkiBase64;
    if (config.updatePublicKey) {
      const pinnedKey = normalizeEcPublicKey(config.updatePublicKey);
      if (manifestKeyRaw !== undefined && manifestKeyRaw !== null && String(manifestKeyRaw).trim() !== '') {
        const manifestKey = normalizeEcPublicKey(manifestKeyRaw);
        if (manifestKey !== pinnedKey) {
          throw new Error('Manifest public key does not match pinned update key');
        }
      }
      return pinnedKey;
    }
    if (config.allowHostManifestKey === true && config.hostOrigin) {
      let feedOrigin = '';
      try { feedOrigin = new URL(feedUrl).origin; } catch {}
      if (feedOrigin !== config.hostOrigin) {
        throw new Error('Host manifest key rejected for non-paired origin');
      }
      if (!manifestKeyRaw || String(manifestKeyRaw).trim() === '') {
        throw new Error('Missing Host manifest public key');
      }
      return normalizeEcPublicKey(manifestKeyRaw);
    }
    throw new Error('No trusted update public key');
  };

  const clearPendingPersistence = targetTrack => {
    const metaPath = pendingMetaPath(targetTrack);
    if (metaPath) {
      try { rmSync(metaPath, { force: true }); } catch {}
    }
  };

  const savePendingPersistence = (targetTrack, payload) => {
    const metaPath = pendingMetaPath(targetTrack);
    if (!metaPath) return;
    try {
      mkdirSync(path.dirname(metaPath), { recursive: true });
      const tmp = `${metaPath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2));
      renameSync(tmp, metaPath);
    } catch {}
  };

  const restorePendingForTrack = targetTrack => {
    if (!enabled) return false;
    const metaPath = pendingMetaPath(targetTrack);
    if (!metaPath) return false;
    let saved;
    try {
      saved = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      return false;
    }
    if (!saved || typeof saved.version !== 'string') {
      clearPendingPersistence(targetTrack);
      return false;
    }
    // The installer was started for this update but we are still on an older version: the
    // install did not take effect. Drop it and start normally rather than offer it again (#27);
    // the next check downloads it afresh.
    const installFailed = saved.installAttempt && compareVersions(saved.version, appVersion) > 0;
    if (installFailed) {
      console.warn('[updater] update', saved.version, 'was handed to the installer but', appVersion, 'is still running; discarding the staged update');
    }
    if (installFailed || compareVersions(saved.version, appVersion) <= 0) {
      // Upgraded or superseded: drop stale pending metadata and staged files.
      if (saved.kind === 'asar' && saved.asarInfo?.asarFile) {
        try { rmSync(saved.asarInfo.asarFile, { force: true }); } catch {}
      }
      if (saved.file) {
        try { rmSync(saved.file, { force: true }); } catch {}
      }
      clearPendingPersistence(targetTrack);
      return false;
    }
    try {
      if (saved.rawManifest) {
        const key = resolveVerificationKey(saved.rawManifest, saved.feedUrl || config.updateUrl);
        verifyDesktopManifest(saved.rawManifest, key);
      }
      if (saved.kind === 'asar' && saved.asarInfo?.asarFile) {
        const st = statSync(saved.asarInfo.asarFile);
        if (!st.isFile() || st.size !== saved.asarInfo.size) throw new Error('Staged ASAR size mismatch');
        if (sha256FileSync(saved.asarInfo.asarFile) !== String(saved.asarInfo.sha256 || '').toLowerCase()) {
          throw new Error('Staged ASAR checksum mismatch');
        }
        stagedAsarInfo = saved.asarInfo;
        stagedFile = null;
        stagedVersion = saved.version;
        stagedMeta = saved;
      } else if (saved.file) {
        const st = statSync(saved.file);
        if (!st.isFile() || st.size !== saved.size) throw new Error('Staged installer size mismatch');
        if (sha256FileSync(saved.file) !== String(saved.sha256 || '').toLowerCase()) {
          throw new Error('Staged installer checksum mismatch');
        }
        stagedAsarInfo = null;
        stagedFile = saved.file;
        stagedVersion = saved.version;
        stagedMeta = saved;
      } else {
        throw new Error('Incomplete pending metadata');
      }
      state = {
        type: 'ready',
        version: saved.version,
        readyMessage: '已下载，重启即可更新',
        pendingRestart: true,
      };
      return true;
    } catch {
      if (saved.kind === 'asar' && saved.asarInfo?.asarFile) {
        try { rmSync(saved.asarInfo.asarFile, { force: true }); } catch {}
      }
      if (saved.file) {
        try { rmSync(saved.file, { force: true }); } catch {}
      }
      clearPendingPersistence(targetTrack);
      return false;
    }
  };

  restorePendingForTrack(track);

  // Mark the staged update as handed to the installer before the app quits, so a start that is
  // still on the old version can tell the install failed. If the hand-over itself throws, the app
  // keeps running and the update stays staged.
  const handOver = async install => {
    const meta = stagedMeta;
    if (meta) savePendingPersistence(track, { ...meta, installAttempt: { fromVersion: appVersion ?? '', at: Date.now() } });
    try {
      await install();
    } catch (error) {
      if (meta) savePendingPersistence(track, meta);
      throw error;
    }
  };

  async function tryStageAsarDelta({ manifest, rawManifest, verifyKey, feedUrl, updatesDir, activeTrack, isCurrentGen }) {
    if (!resourcesDir || typeof onInstallAsar !== 'function' || !Array.isArray(manifest.asarDeltas) || manifest.asarDeltas.length === 0) {
      return null;
    }
    const asarMetaPath = path.join(updatesDir, `ready-asar-${activeTrack}-${manifest.version}.json`);
    try {
      const existing = JSON.parse(await readFile(asarMetaPath, 'utf8'));
      const info = await stat(existing.asarFile);
      if (info.isFile() && info.size === existing.size &&
          (await sha256File(existing.asarFile)) === existing.sha256.toLowerCase()) {
        const hdr = await readAsarHeaderInfo(existing.asarFile);
        if (hdr.headerSha256 === existing.headerSha256.toLowerCase()) {
          return existing;
        }
      }
    } catch {}

    const currentAsar = path.join(resourcesDir, 'app.asar');
    const asarStat = await stat(currentAsar).catch(() => null);
    if (!asarStat?.isFile()) return null;
    const candidates = manifest.asarDeltas.filter(a => a.baseSize === asarStat.size);
    if (candidates.length === 0) return null;

    if (typeof canUseAsarUpdate === 'function') {
      if (!(await canUseAsarUpdate({ resourcesDir, execPath }))) return null;
    } else {
      try { await access(resourcesDir, constants.W_OK); } catch { return null; }
    }

    const currentAsarSha = await sha256File(currentAsar);
    const matching = candidates.find(a => a.baseSha256.toLowerCase() === currentAsarSha);
    if (!matching || !matching.url) return null;

    verifyDesktopDeltasManifest(rawManifest, verifyKey, { feedUrl, allowOrigin: config.allowOrigin });
    const currentHeader = await readAsarHeaderInfo(currentAsar);
    if (matching.baseHeaderSha256 && matching.baseHeaderSha256.toLowerCase() !== currentHeader.headerSha256) {
      return null;
    }

    if (!isCurrentGen()) return null;
    emit({ type: 'available', version: manifest.version });
    const tmpDelta = path.join(updatesDir, `asar-${activeTrack}-${manifest.version}.rbdelta.part`);
    const ok = await downloadVerifiedFile({
      fetchImpl,
      url: matching.url,
      expectedSize: matching.size,
      expectedSha256: matching.sha256,
      tmpFile: tmpDelta,
      isCurrentGen,
      retryDelayMs,
      onProgress: progress => emit({ type: 'downloading', version: manifest.version, progress }),
    });
    if (!ok) return null;

    emit({ type: 'staging', version: manifest.version });
    const targetAsar = path.join(updatesDir, `asar-${activeTrack}-${manifest.version}.asar`);
    try {
      await applyDeltaFile(currentAsar, tmpDelta, targetAsar, {
        expectedSourceSha256: matching.baseSha256,
        expectedTargetSha256: matching.targetSha256,
        expectedTargetSize: matching.targetSize,
      });
      const targetHdr = await readAsarHeaderInfo(targetAsar);
      if (targetHdr.headerSha256 !== matching.targetHeaderSha256.toLowerCase()) {
        throw new Error('Reconstructed ASAR header integrity mismatch');
      }
      const meta = {
        version: manifest.version,
        asarFile: targetAsar,
        sha256: matching.targetSha256.toLowerCase(),
        size: matching.targetSize,
        headerSha256: matching.targetHeaderSha256.toLowerCase(),
        baseHeaderSha256: currentHeader.headerSha256,
        resourcesDir,
        execPath,
      };
      const metaTmp = `${asarMetaPath}.tmp-${process.pid}`;
      await writeFile(metaTmp, JSON.stringify(meta, null, 2));
      await rename(metaTmp, asarMetaPath);
      return meta;
    } catch (err) {
      await rm(targetAsar, { force: true }).catch(() => {});
      throw err;
    } finally {
      await rm(tmpDelta, { force: true }).catch(() => {});
    }
  }

  async function tryStageInstallerDelta({ manifest, rawManifest, verifyKey, feedUrl, updatesDir, target, isCurrentGen }) {
    if (!Array.isArray(manifest.deltas) || manifest.deltas.length === 0) return false;
    const found = await findMatchingBaseInstaller(updatesDir, manifest.deltas);
    if (!found || !found.delta.url) return false;

    verifyDesktopDeltasManifest(rawManifest, verifyKey, { feedUrl, allowOrigin: config.allowOrigin });
    if (!isCurrentGen()) return false;
    emit({ type: 'available', version: manifest.version });
    const tmpDelta = `${target}.rbdelta.part`;
    const ok = await downloadVerifiedFile({
      fetchImpl,
      url: found.delta.url,
      expectedSize: found.delta.size,
      expectedSha256: found.delta.sha256,
      tmpFile: tmpDelta,
      isCurrentGen,
      retryDelayMs,
      onProgress: progress => emit({ type: 'downloading', version: manifest.version, progress }),
    });
    if (!ok) return false;

    emit({ type: 'staging', version: manifest.version });
    try {
      await applyDeltaFile(found.baseFile, tmpDelta, target, {
        expectedSourceSha256: found.delta.baseSha256,
        expectedTargetSha256: manifest.sha256,
        expectedTargetSize: manifest.size,
        maxTargetBytes: MAX_INSTALLER_BYTES,
      });
      return true;
    } finally {
      await rm(tmpDelta, { force: true }).catch(() => {});
    }
  }

  async function check({ download = false } = {}) {
    if (!enabled) return status();
    if (checking) return checking;
    const myGen = ++checkGeneration;
    const activeTrack = track;
    const isCurrentGen = () => myGen === checkGeneration;
    const shouldDownload = download === true || autoUpdateWhenIdle;

    const promise = (async () => {
      emit({ type: 'checking' });
      try {
        const baseFeedName = activeTrack === 'stable' ? `${platformId}.json` : `${platformId}-${activeTrack}.json`;
        const normalizedUrl = normalizeDesktopUpdateUrl(config.updateUrl, config.feedFile);
        const configuredFeed = normalizedUrl.feedFile;
        const primaryFeedName = configuredFeed
          ? (activeTrack === 'stable'
              ? configuredFeed
              : configuredFeed.endsWith('.json')
                ? `${configuredFeed.slice(0, -5)}-${activeTrack}.json`
                : `${configuredFeed}-${activeTrack}.json`)
          : baseFeedName;
        const baseUpdateUrl = normalizedUrl.baseUpdateUrl;
        let feedUrl = `${baseUpdateUrl}/${primaryFeedName}?t=${Date.now()}`;
        let res = await fetchImpl(feedUrl, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        if (!isCurrentGen()) return status();
        if (res.status === 404 && configuredFeed && primaryFeedName !== baseFeedName) {
          await res.body?.cancel?.().catch(() => {});
          feedUrl = `${baseUpdateUrl}/${baseFeedName}?t=${Date.now()}`;
          res = await fetchImpl(feedUrl, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
          if (!isCurrentGen()) return status();
        }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'feed_http_status', httpStatus: res.status });
        let rawManifest;
        try { rawManifest = await res.json(); } catch { throw Object.assign(new Error('Invalid feed JSON'), { kind: 'feed_malformed' }); }
        const flat = flattenManifestForVerification(rawManifest);
        const resolvedUrl = flat ? resolveManifestUrl(flat.url, feedUrl, config.allowOrigin) : null;
        if (!flat || typeof flat.version !== 'string' || !flat.version.trim() || !resolvedUrl ||
            !SHA_HEX_RE.test(String(flat.sha256 || '')) || !Number.isSafeInteger(flat.size) || flat.size <= 0) {
          throw Object.assign(new Error('Invalid manifest fields'), { kind: 'feed_malformed' });
        }
        let verifyKey;
        try {
          verifyKey = resolveVerificationKey(rawManifest, feedUrl);
          verifyDesktopManifest(rawManifest, verifyKey);
        } catch (err) {
          throw Object.assign(err, { kind: 'installer_signature_invalid' });
        }
        if (!platformMatches(flat.platform, platformId) || (flat.track ?? 'stable') !== activeTrack) {
          throw Object.assign(new Error('Manifest target mismatch'), { kind: 'feed_malformed' });
        }
        const manifest = {
          ...flat,
          url: resolvedUrl,
          deltas: Array.isArray(flat.deltas)
            ? flat.deltas.map(d => ({ ...d, url: resolveManifestUrl(d?.url, feedUrl, config.allowOrigin) }))
            : undefined,
          asarDeltas: Array.isArray(flat.asarDeltas)
            ? flat.asarDeltas.map(a => ({ ...a, url: resolveManifestUrl(a?.url, feedUrl, config.allowOrigin) }))
            : undefined,
        };

        if (compareVersions(manifest.version, appVersion) <= 0) {
          return isCurrentGen()
            ? emit({ type: 'idle', lastCheck: { at: Date.now(), result: 'up-to-date' } })
            : status();
        }

        const updatesDir = path.join(profileDir, 'updates');
        await mkdir(updatesDir, { recursive: true });
        const ext = path.extname(new URL(manifest.url).pathname) || (process.platform === 'win32' ? '.exe' : process.platform === 'linux' ? '.deb' : '.dmg');
        const target = path.join(updatesDir, `ready-${activeTrack}-${manifest.version}${ext}`);

        // 1. Check already-staged full installer first.
        let needFullOrDelta = true;
        try {
          const info = await stat(target);
          if (info.isFile() && info.size === manifest.size && (await sha256File(target)) === manifest.sha256.toLowerCase()) {
            needFullOrDelta = false;
          }
        } catch {}

        if (!needFullOrDelta) {
          if (!isCurrentGen()) return status();
          stagedAsarInfo = null;
          stagedFile = target;
          stagedVersion = manifest.version;
          stagedMeta = {
            kind: 'file',
            version: manifest.version,
            file: target,
            sha256: manifest.sha256.toLowerCase(),
            size: manifest.size,
            feedUrl,
            rawManifest,
          };
          savePendingPersistence(activeTrack, stagedMeta);
          return emit({ type: 'ready', version: manifest.version, readyMessage: '已下载，重启即可更新', pendingRestart: true });
        }

        if (!shouldDownload) {
          if (!isCurrentGen()) return status();
          return emit({ type: 'available', version: manifest.version });
        }

        // 2. Try lightweight ASAR incremental update when eligible (falls back cleanly if unavailable or failed).
        try {
          const asarStaged = await tryStageAsarDelta({ manifest, rawManifest, verifyKey, feedUrl, updatesDir, activeTrack, isCurrentGen });
          if (asarStaged && isCurrentGen()) {
            stagedFile = null;
            stagedAsarInfo = asarStaged;
            stagedVersion = manifest.version;
            stagedMeta = {
              kind: 'asar',
              version: manifest.version,
              asarInfo: asarStaged,
              feedUrl,
              rawManifest,
            };
            savePendingPersistence(activeTrack, stagedMeta);
            return emit({ type: 'ready', version: manifest.version, readyMessage: '已下载，重启即可更新', pendingRestart: true });
          }
        } catch {}
        if (!isCurrentGen()) return status();

        // 3. Try binary delta against cached previous installer (falls back cleanly if base/delta fails).
        let stagedByDelta = false;
        try {
          stagedByDelta = await tryStageInstallerDelta({ manifest, rawManifest, verifyKey, feedUrl, updatesDir, target, isCurrentGen });
        } catch {
          await rm(target, { force: true }).catch(() => {});
        }
        if (!isCurrentGen()) return status();

        // 4. Fallback to full installer download when no verified incremental path applies.
        if (!stagedByDelta) {
          emit({ type: 'available', version: manifest.version });
          const tmpFile = `${target}.part`;
          const ok = await downloadVerifiedFile({
            fetchImpl,
            url: manifest.url,
            expectedSize: manifest.size,
            expectedSha256: manifest.sha256,
            tmpFile,
            isCurrentGen,
            retryDelayMs,
            onProgress: progress => emit({ type: 'downloading', version: manifest.version, progress }),
          });
          if (!ok) return status();
          emit({ type: 'staging', version: manifest.version });
          await rename(tmpFile, target);
        }

        await pruneOldInstallers(updatesDir, target, activeTrack, ext);
        if (!isCurrentGen()) return status();
        stagedAsarInfo = null;
        stagedFile = target;
        stagedVersion = manifest.version;
        stagedMeta = {
          kind: 'file',
          version: manifest.version,
          file: target,
          sha256: manifest.sha256.toLowerCase(),
          size: manifest.size,
          feedUrl,
          rawManifest,
        };
        savePendingPersistence(activeTrack, stagedMeta);
        return emit({ type: 'ready', version: manifest.version, readyMessage: '已下载，重启即可更新', pendingRestart: true });
      } catch (err) {
        if (!isCurrentGen()) return status();
        const failure = err.kind === 'feed_http_status'
          ? { kind: 'feed_http_status', httpStatus: err.httpStatus }
          : { kind: err.kind ?? 'update_failed' };
        return emit({
          type: 'idle',
          lastCheck: {
            at: Date.now(),
            result: 'error',
            failure,
            errorMessage: err.message,
            message: err.message,
          },
        });
      } finally {
        if (checking === promise) checking = null;
      }
    })();
    checking = promise;
    return promise;
  }

  return {
    status,
    check,
    download() {
      return check({ download: true });
    },
    setTrack({ track: next } = {}) {
      if (!['stable', 'nightly', 'dogfood'].includes(next)) throw new Error('Invalid track');
      checkGeneration += 1;
      checking = null;
      track = next;
      stagedFile = null;
      stagedAsarInfo = null;
      stagedVersion = null;
      stagedMeta = null;
      savePrefs();
      if (enabled && restorePendingForTrack(next)) {
        return emit(state);
      }
      return enabled ? emit({ type: 'idle' }) : status();
    },
    setAutoUpdateWhenIdle({ enabled: val } = {}) {
      autoUpdateWhenIdle = Boolean(val);
      savePrefs();
      if (autoUpdateWhenIdle && state.type === 'available') {
        void check({ download: true });
      }
      return emit(state);
    },
    async quitAndInstall({ expectedVersion } = {}) {
      if (!enabled || (!stagedFile && !stagedAsarInfo)) throw new Error('No update ready');
      if (expectedVersion && stagedVersion && expectedVersion !== stagedVersion) {
        return { status: 'superseded' };
      }
      if (stagedAsarInfo) {
        const actualSha = await sha256File(stagedAsarInfo.asarFile).catch(() => '');
        if (actualSha !== String(stagedAsarInfo.sha256 || '').toLowerCase()) {
          await rm(stagedAsarInfo.asarFile, { force: true }).catch(() => {});
          clearPendingPersistence(track);
          stagedAsarInfo = null;
          stagedVersion = null;
          emit({ type: 'idle', lastCheck: { at: Date.now(), result: 'error', failure: { kind: 'installer_signature_invalid' }, errorMessage: 'Staged ASAR checksum mismatch' } });
          throw Object.assign(new Error('Staged ASAR checksum mismatch'), { kind: 'installer_signature_invalid' });
        }
        await handOver(() => onInstallAsar(stagedAsarInfo));
      } else {
        const expectedFileSha = stagedMeta?.sha256;
        if (expectedFileSha) {
          const actualSha = await sha256File(stagedFile).catch(() => '');
          if (actualSha !== expectedFileSha.toLowerCase()) {
            await rm(stagedFile, { force: true }).catch(() => {});
            clearPendingPersistence(track);
            stagedFile = null;
            stagedVersion = null;
            emit({ type: 'idle', lastCheck: { at: Date.now(), result: 'error', failure: { kind: 'installer_signature_invalid' }, errorMessage: 'Staged installer checksum mismatch' } });
            throw Object.assign(new Error('Staged installer checksum mismatch'), { kind: 'installer_signature_invalid' });
          }
        }
        await handOver(() => onInstallFile(stagedFile, stagedVersion));
      }
      return { status: 'requested' };
    },
  };
}
