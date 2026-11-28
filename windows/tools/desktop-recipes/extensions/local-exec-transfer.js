// Bounded-memory chunked local-exec file transfer extension (desktop recipes: 1.3.0, 1.2.3, 0.71.2).
// Removes the 100 MiB single-file cap for CopyToBox / CopyFromBox while keeping Read's inline cap intact,
// and verifies SHA-256 before atomically committing received files.
//
// Local paths. Read, ls and copy-out (CopyToBox, chunked reads, hashes) resolve anywhere on the
// computer, except a short fixed deny list of credential stores, checked on the requested path
// and again after following symlinks. Files copied onto the computer (CopyFromBox, uploads)
// still land only inside the local-exec workspace. Both kinds pass isLocalUseBlocked (approval
// or auto-review) before they get here.
function rokbotLocalPathRules() {
  return {
    // Relative to the user's home directory.
    homeDirs: ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gh', '.config/gcloud',
      '.password-store', '.rokbot-local', '.local/share/keyrings', 'Library/Keychains', 'Library/Cookies',
      'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials',
      'AppData/Roaming/Microsoft/Protect', 'AppData/Local/Microsoft/Vault'],
    systemDirs: ['/Library/Keychains'],
    // Any file with this name, wherever it is (browser password and cookie stores included).
    fileNames: ['auth.json', 'credentials.json', 'secrets.json', 'model.env', 'setup-key', 'android-signing.json',
      '.admin-password', '.netrc', '.git-credentials', 'login data', 'login data for account', 'web data',
      'cookies', 'cookies.sqlite', 'cookies.binarycookies', 'logins.json', 'key3.db', 'key4.db'],
    filePrefixes: ['setup-key.'],
  };
}

// The reason `target` is off limits, or undefined. `roots` are local-exec workspaces: the RokBot
// profile that holds them (sign-in, approvals) is off limits, the workspaces themselves are not.
function rokbotSensitiveLocalPath(target, { roots = [], homes, platform = process.platform } = {}) {
  const path = require('node:path');
  const api = platform === 'win32' ? path.win32 : path.posix;
  const fold = platform === 'linux' ? value => value : value => value.toLowerCase();
  const inside = (base, candidate) => {
    const rel = api.relative(fold(api.resolve(base)), fold(api.resolve(candidate)));
    return rel === '' || (!rel.startsWith(`..${api.sep}`) && rel !== '..' && !api.isAbsolute(rel));
  };
  const rules = rokbotLocalPathRules();
  const name = fold(api.basename(target));
  if (rules.fileNames.includes(name) || rules.filePrefixes.some(prefix => name.startsWith(prefix))) {
    return `a credentials file named ${api.basename(target)}`;
  }
  for (const home of homes ?? [require('node:os').homedir()]) {
    for (const dir of rules.homeDirs) {
      if (inside(api.join(home, ...dir.split('/')), target)) return `~/${dir}`;
    }
  }
  if (platform !== 'win32') {
    for (const dir of rules.systemDirs) if (inside(dir, target)) return dir;
  }
  for (const root of roots) {
    if (!root || api.basename(api.dirname(root)) !== 'local-exec') continue;
    const profile = api.dirname(api.dirname(root));
    if (inside(profile, target) && !inside(root, target)) return 'RokBot\'s own data folder';
  }
  return undefined;
}

function rokbotNormalizeLocalPath(root, requested) {
  const path = require('node:path');
  if (typeof requested !== 'string' || requested.length === 0) throw new Error('File path is required');
  let normalized = requested;
  if (normalized.startsWith('file://')) {
    try { normalized = require('node:url').fileURLToPath(normalized); } catch {}
  }
  normalized = normalized.replace(/^~(?=$|\/|\\)/, require('node:os').homedir());
  return root && !path.isAbsolute(normalized) ? path.resolve(root, normalized) : path.resolve(normalized);
}

async function rokbotRealpathNearest(targetPath) {
  const path = require('node:path');
  const fsp = require('node:fs/promises');
  const suffix = [];
  let current = targetPath;
  for (;;) {
    try {
      const resolved = await fsp.realpath(current);
      return suffix.length === 0 ? resolved : path.join(resolved, ...suffix.reverse());
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return targetPath;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

const ROKBOT_SENSITIVE_NOTE = 'RokBot never reads or copies SSH/GPG keys, cloud and GitHub CLI credentials, keychains, '
  + 'browser password and cookie stores, credential files or RokBot\'s own sign-in data on this computer.';

// Read side: Read, ls, CopyToBox, chunked reads and hashes.
async function rokbotLocalReadPath({ root, path: requested }) {
  const resolved = rokbotNormalizeLocalPath(root, requested);
  const lexical = rokbotSensitiveLocalPath(resolved, { roots: [root] });
  if (lexical !== undefined) {
    throw new Error(`Refused: ${requested} is a sensitive path on this computer (${lexical}). ${ROKBOT_SENSITIVE_NOTE}`);
  }
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const real = await rokbotRealpathNearest(resolved);
  const realRoot = root ? await fsp.realpath(root).catch(() => root) : root;
  const realHome = await fsp.realpath(os.homedir()).catch(() => os.homedir());
  const linked = rokbotSensitiveLocalPath(real, { roots: [root, realRoot], homes: [os.homedir(), realHome] });
  if (linked !== undefined) {
    throw new Error(`Refused: ${requested} resolves through a symlink to ${real}, a sensitive path on this computer (${linked}). ${ROKBOT_SENSITIVE_NOTE}`);
  }
  return resolved;
}

function rokbotLocalWriteRefusal(requested, root, throughSymlink = false) {
  return throughSymlink
    ? `Refused to write ${requested}: it resolves through a symlink to outside RokBot's local workspace (${root}). `
      + 'Files copied onto this computer are saved only inside that folder.'
    : `Refused to write ${requested}: files copied onto this computer are saved only inside RokBot's local workspace (${root}). `
      + 'Save it there, then move it with a Shell command, which goes through approval or auto-review.';
}

// Write side: files copied onto the computer stay inside the workspace.
async function rokbotLocalWritePath({ root, path: requested }) {
  const path = require('node:path');
  const resolved = rokbotNormalizeLocalPath(root, requested);
  const outside = (base, candidate) => {
    const rel = path.relative(base, candidate);
    return rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel));
  };
  if (root && outside(root, resolved)) throw new Error(rokbotLocalWriteRefusal(requested, root));
  if (root) {
    let realRoot;
    try { realRoot = await require('node:fs/promises').realpath(root); } catch { return resolved; }
    if (outside(realRoot, await rokbotRealpathNearest(resolved))) throw new Error(rokbotLocalWriteRefusal(requested, root, true));
  }
  return resolved;
}

function rokbotEnhanceLocalExecProvider(BaseProvider) {
  if (typeof BaseProvider !== 'function' || BaseProvider.__rokbotChunkedTransferWrapped) return BaseProvider;
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');

  const CHUNK_VARIANT = 'rokbot-chunked-v1';
  const MAX_READ_CHUNK_BYTES = 8 * 1024 * 1024;
  const HASH_BUFFER_BYTES = 1024 * 1024;
  const UPLOAD_IDLE_TIMEOUT_MS = 10 * 60_000;
  const TRANSFER_KINDS = new Set([
    'file-read-chunk',
    'file-write-begin',
    'file-write-chunk',
    'file-write-commit',
    'file-write-abort',
    'file-hash',
  ]);

  function resolveMaxTransferBytes() {
    const raw = process.env.ROKBOT_MAX_TRANSFER_BYTES;
    if (raw === undefined || raw === null) return Infinity;
    const trimmed = String(raw).trim().toLowerCase();
    if (!trimmed || trimmed === '0' || trimmed === 'unlimited' || trimmed === 'none' || trimmed === 'infinity' || trimmed === 'false') {
      return Infinity;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return Infinity;
    return Math.floor(parsed);
  }

  async function streamFileSha256(filePath) {
    const handle = await fsp.open(filePath, 'r');
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new Error(`Not a regular file: ${filePath}`);
      const hash = crypto.createHash('sha256');
      const buf = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, Math.max(1, st.size)));
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        total += bytesRead;
      }
      return { bytes: total, sha256: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  }

  async function writeAll(handle, buf) {
    let written = 0;
    while (written < buf.length) {
      const { bytesWritten } = await handle.write(buf, written, buf.length - written, null);
      if (bytesWritten <= 0) throw new Error('Short write while writing file chunk');
      written += bytesWritten;
    }
  }

  function appendChunkedVariant(variant) {
    if (typeof variant !== 'string' || variant.length === 0) return CHUNK_VARIANT;
    return variant.includes(CHUNK_VARIANT) ? variant : `${variant}+${CHUNK_VARIANT}`;
  }

  class RokbotTransferProvider extends BaseProvider {
    constructor(options) {
      super(options);
      this.__rokbotExplicitMaxBytes = options?.maxFileBytes;
      this.__rokbotUploads = new Map();
      this.__rokbotDownloads = new Map();
      // Keep this.executor.execManager (inline Read tool) at its 100 MiB default,
      // while removing the 100 MiB cap for file transfers (configurable via ROKBOT_MAX_TRANSFER_BYTES).
      const transferLimit = this.__rokbotMaxTransferBytes();
      if (this.executor && options?.maxFileBytes === undefined) {
        this.executor.maxFileBytes = transferLimit;
        this.executor.maxUploadFrameBytes = Number.isFinite(transferLimit)
          ? Math.max(this.executor.maxUploadFrameBytes || 0, Math.ceil(transferLimit * 4 / 3) + 64 * 1024)
          : Infinity;
      }
    }

    __rokbotMaxTransferBytes() {
      if (typeof this.__rokbotExplicitMaxBytes === 'number' && Number.isFinite(this.__rokbotExplicitMaxBytes)) {
        return this.__rokbotExplicitMaxBytes;
      }
      return resolveMaxTransferBytes();
    }

    postBatch(frames, deadline) {
      const mapped = Array.isArray(frames)
        ? frames.map((frame) => (frame && frame.kind === 'hello'
          ? { ...frame, variant: appendChunkedVariant(frame.variant) }
          : frame))
        : frames;
      return super.postBatch(mapped, deadline);
    }

    close() {
      void this.__rokbotCleanupAllUploads();
      this.__rokbotCleanupAllDownloads();
      return super.close();
    }

    __rokbotCleanupDownload(transferId) {
      const session = this.__rokbotDownloads.get(transferId);
      if (!session) return;
      this.__rokbotDownloads.delete(transferId);
      if (session.timer) clearTimeout(session.timer);
    }

    __rokbotCleanupAllDownloads() {
      for (const id of [...this.__rokbotDownloads.keys()]) {
        this.__rokbotCleanupDownload(id);
      }
    }

    __rokbotTouchDownload(transferId, session) {
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        this.__rokbotCleanupDownload(transferId);
      }, UPLOAD_IDLE_TIMEOUT_MS);
      session.timer.unref?.();
    }

    async __rokbotCleanupUpload(transferId) {
      const session = this.__rokbotUploads.get(transferId);
      if (!session) return;
      this.__rokbotUploads.delete(transferId);
      if (session.timer) clearTimeout(session.timer);
      try { await session.handle?.close(); } catch {}
      try { await fsp.rm(session.partPath, { force: true }); } catch {}
    }

    async __rokbotCleanupAllUploads() {
      const ids = [...this.__rokbotUploads.keys()];
      await Promise.all(ids.map((id) => this.__rokbotCleanupUpload(id)));
    }

    __rokbotTouchUpload(transferId, session) {
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        void this.__rokbotCleanupUpload(transferId);
      }, UPLOAD_IDLE_TIMEOUT_MS);
      session.timer.unref?.();
    }

    dispatchEventBlock(block) {
      const dataLines = String(block).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
      if (dataLines.length > 0) {
        let parsed;
        try { parsed = JSON.parse(dataLines.join('\n')); } catch { parsed = undefined; }
        if (parsed && typeof parsed === 'object' && TRANSFER_KINDS.has(parsed.kind) && typeof parsed.requestId === 'string') {
          void this.__rokbotHandleTransferFrame(parsed);
          return;
        }
      }
      return super.dispatchEventBlock(block);
    }

    async __rokbotCheckBlocked(frame, describes) {
      const check = this.executor?.options?.isLocalUseBlocked;
      if (typeof check !== 'function') return undefined;
      return await check({
        approvalId: frame.approvalId,
        authorization: { kind: 'none' },
        describes,
        terminalsFolder: this.executor?.terminalsFolder,
      });
    }

    async __rokbotHandleTransferFrame(frame) {
      const reply = (payload) => {
        this.enqueue({
          kind: 'client',
          requestId: frame.requestId,
          message: { rokbotFileTransfer: true, ...payload },
        });
      };
      try {
        const root = this.executor?.root;
        const limit = this.__rokbotMaxTransferBytes();

        if (frame.kind === 'file-read-chunk') {
          const offset = Number(frame.offset ?? 0);
          const requestedLen = Number(frame.length ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLen) || requestedLen < 0) {
            return reply({ error: 'Invalid chunk range' });
          }
          const resolved = await rokbotLocalReadPath({ root, path: frame.path });
          const transferId = typeof frame.transferId === 'string' && frame.transferId.length > 0 ? frame.transferId : null;
          const existingDownload = transferId ? this.__rokbotDownloads.get(transferId) : null;
          const authorizedContinuation = Boolean(existingDownload && existingDownload.targetPath === resolved && offset > 0);
          if (!authorizedContinuation) {
            const blocked = await this.__rokbotCheckBlocked(frame, {
              action: 'read-file',
              target: frame.path,
              attachToResourcePath: frame.path,
            });
            if (blocked !== undefined) return reply({ error: blocked });
          }
          const handle = await fsp.open(resolved, 'r');
          try {
            const st = await handle.stat();
            if (!st.isFile()) return reply({ error: `Not a regular file: ${frame.path}` });
            if (st.size > limit) {
              return reply({ error: `File exceeds local-exec transfer size limit (${st.size} > ${limit})` });
            }
            const identity = JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs]);
            if (authorizedContinuation && existingDownload.identity !== identity) {
              this.__rokbotCleanupDownload(transferId);
              return reply({ error: 'Local file changed during transfer' });
            }
            const toRead = Math.min(requestedLen, MAX_READ_CHUNK_BYTES, Math.max(0, st.size - offset));
            const buf = toRead > 0 ? Buffer.allocUnsafe(toRead) : Buffer.alloc(0);
            let bytesRead = 0;
            while (bytesRead < toRead) {
              const res = await handle.read(buf, bytesRead, toRead - bytesRead, offset + bytesRead);
              if (res.bytesRead === 0) break;
              bytesRead += res.bytesRead;
            }
            const eof = offset + bytesRead >= st.size;
            if (transferId) {
              if (eof) {
                this.__rokbotCleanupDownload(transferId);
              } else if (existingDownload && existingDownload.targetPath === resolved) {
                this.__rokbotTouchDownload(transferId, existingDownload);
              } else {
                const dlSession = { targetPath: resolved, identity, timer: null };
                this.__rokbotDownloads.set(transferId, dlSession);
                this.__rokbotTouchDownload(transferId, dlSession);
              }
            }
            return reply({
              size: st.size,
              identity,
              offset,
              bytesRead,
              bytesBase64: bytesRead > 0 ? buf.toString('base64', 0, bytesRead) : '',
              eof,
            });
          } finally {
            await handle.close();
          }
        }

        if (frame.kind === 'file-hash') {
          const blocked = await this.__rokbotCheckBlocked(frame, {
            action: 'read-file',
            target: frame.path,
            attachToResourcePath: frame.path,
          });
          if (blocked !== undefined) return reply({ error: blocked });
          const resolved = await rokbotLocalReadPath({ root, path: frame.path });
          const digest = await streamFileSha256(resolved);
          return reply(digest);
        }

        if (frame.kind === 'file-write-begin') {
          const blocked = await this.__rokbotCheckBlocked(frame, {
            action: 'write-file',
            target: frame.path,
          });
          if (blocked !== undefined) return reply({ error: blocked });
          if (typeof frame.transferId !== 'string' || frame.transferId.length === 0) {
            return reply({ error: 'Missing transferId' });
          }
          if (frame.totalSize !== undefined && Number(frame.totalSize) > limit) {
            return reply({ error: `File exceeds local-exec transfer size limit (${frame.totalSize} > ${limit})` });
          }
          const resolved = await rokbotLocalWritePath({ root, path: frame.path });
          await fsp.mkdir(path.dirname(resolved), { recursive: true });
          const partPath = `${resolved}.rokbot-${crypto.randomBytes(8).toString('hex')}.part`;
          const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
          const handle = await fsp.open(partPath, flags, 0o600);
          const session = {
            handle,
            partPath,
            targetPath: resolved,
            offset: 0,
            hash: crypto.createHash('sha256'),
            timer: null,
          };
          this.__rokbotUploads.set(frame.transferId, session);
          this.__rokbotTouchUpload(frame.transferId, session);
          return reply({ ok: true });
        }

        if (frame.kind === 'file-write-chunk') {
          const session = this.__rokbotUploads.get(frame.transferId);
          if (!session) return reply({ error: 'Unknown or expired file upload session' });
          this.__rokbotTouchUpload(frame.transferId, session);
          const expectedOffset = Number(frame.offset);
          if (!Number.isSafeInteger(expectedOffset) || expectedOffset !== session.offset) {
            await this.__rokbotCleanupUpload(frame.transferId);
            return reply({ error: `Chunk offset mismatch (${expectedOffset} != ${session.offset})` });
          }
          const chunk = frame.bytesBase64 ? Buffer.from(frame.bytesBase64, 'base64') : Buffer.alloc(0);
          if (session.offset + chunk.length > limit) {
            await this.__rokbotCleanupUpload(frame.transferId);
            return reply({ error: `File exceeds local-exec transfer size limit (${session.offset + chunk.length} > ${limit})` });
          }
          if (chunk.length > 0) {
            await writeAll(session.handle, chunk);
            session.hash.update(chunk);
            session.offset += chunk.length;
          }
          return reply({ ok: true, written: session.offset });
        }

        if (frame.kind === 'file-write-commit') {
          const session = this.__rokbotUploads.get(frame.transferId);
          if (!session) return reply({ error: 'Unknown or expired file upload session' });
          this.__rokbotUploads.delete(frame.transferId);
          if (session.timer) clearTimeout(session.timer);
          try {
            try { await session.handle.datasync(); } catch {}
            await session.handle.close();
            session.handle = null;
            const streamSha = session.hash.digest('hex');
            if (frame.expectedBytes !== undefined && session.offset !== Number(frame.expectedBytes)) {
              throw new Error(`Upload byte count mismatch (${session.offset} != ${frame.expectedBytes})`);
            }
            if (frame.expectedSha256 && streamSha !== frame.expectedSha256) {
              throw new Error(`Upload stream SHA-256 mismatch (${streamSha} != ${frame.expectedSha256})`);
            }
            const verified = await streamFileSha256(session.partPath);
            if (frame.expectedBytes !== undefined && verified.bytes !== Number(frame.expectedBytes)) {
              throw new Error(`On-disk byte count mismatch (${verified.bytes} != ${frame.expectedBytes})`);
            }
            if (frame.expectedSha256 && verified.sha256 !== frame.expectedSha256) {
              throw new Error(`On-disk SHA-256 mismatch (${verified.sha256} != ${frame.expectedSha256})`);
            }
            await fsp.rename(session.partPath, session.targetPath);
            return reply({ ok: true, bytes: verified.bytes, sha256: verified.sha256 });
          } catch (err) {
            try { await session.handle?.close(); } catch {}
            try { await fsp.rm(session.partPath, { force: true }); } catch {}
            throw err;
          }
        }

        if (frame.kind === 'file-write-abort') {
          await this.__rokbotCleanupUpload(frame.transferId);
          return reply({ ok: true });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : undefined;
        return reply({ error: message, ...(code ? { code } : {}) });
      }
    }
  }

  RokbotTransferProvider.__rokbotChunkedTransferWrapped = true;
  return RokbotTransferProvider;
}
