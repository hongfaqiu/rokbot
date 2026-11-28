import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { listAgentLibraryFiles } from '../server/library.mjs';

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const BOX_TRANSFER_TIMEOUT_MS = 60_000;
const TRACKED_TASK_STATUSES = ['queued', 'in_progress', 'for_review', 'done', 'canceled'];
const EFFORT_LEVELS = ['low', 'high'];

function readJsonFileSync(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFileSync(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isPathInside(root, targetPath) {
  if (!root || !targetPath) return false;
  const rel = relative(resolve(root), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function stateWriteOk(detail, extra = {}) {
  return { ok: true, detail, ...extra };
}

function stateWriteFailed(reason) {
  return { ok: false, reason };
}

function readMemoryDirFiles(memoryDir) {
  let profile = '';
  try { profile = readFileSync(join(memoryDir, 'profile.md'), 'utf8'); } catch {}
  const logs = new Map();
  const logDir = join(memoryDir, 'log');
  try {
    for (const name of readdirSync(logDir)) {
      if (!name.endsWith('.md')) continue;
      try { logs.set(name, readFileSync(join(logDir, name), 'utf8')); } catch {}
    }
  } catch {}
  return { profile, logs };
}

function writeMemoryDirFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { mode: 0o600 });
}

/** Shared user-level memory store at `<sandRoot>/user-memory`. */
export function createLocalUserMemoryStore(library, sandRoot) {
  if (!sandRoot || typeof library?.MemoryFolderView !== 'function') return undefined;
  const memoryDir = join(sandRoot, 'user-memory');
  const view = new library.MemoryFolderView(
    memoryDir,
    () => readMemoryDirFiles(memoryDir),
    (filePath, content) => writeMemoryDirFile(filePath, content),
    () => false,
  );
  const withVia = (rec) => (rec && typeof rec === 'object' ? { ...rec, via: typeof rec.via === 'string' ? rec.via : '' } : rec);
  const store = {
    facts: () => view.facts(),
    recall: (limit = 20) => {
      const r = view.recall(limit);
      return {
        profile: (r?.profile ?? []).map(withVia),
        recent: (r?.recent ?? []).map(withVia),
      };
    },
    listMemories: (limit = 500) => (view.listMemories(limit) ?? []).map(withVia),
    listAll: (limit = 500) => (view.listMemories(limit) ?? []).map(withVia),
    addMemory: (content, createdAt = Date.now(), kind = 'log', provenance) =>
      view.addMemory(content, createdAt, kind, provenance),
    removeMemoryByContent: (content) => view.removeMemoryByContent(content),
    getLocation: () => view.getLocation(),
    getOwnShardLocation: () => view.getLocation(),
    flush: async () => {},
    setOnChange() {},
  };
  store.own = store;
  return store;
}

/**
 * Self-hosted runner gates layered onto `defaultSandRunnerGates('local-host')`.
 * Turns on only gates whose backends are implemented locally on RokBot.
 */
export function createLocalRunnerGates(baseGates = {}, { teamAdminPolicyExt } = {}) {
  return {
    ...baseGates,
    cloudAgentsDisabledByTeam: () => teamAdminPolicyExt?.isCloudAgentsDisabled?.() ?? true,
    eventFilter: () => true,
    botReference: () => true,
    botReferenceDocs: () => true,
    chatPrimitivesDisclosure: () => true,
    transcriptSearch: () => true,
    draftExternalMessage: () => true,
    // Keep `tasks` false so the subagent launcher stays named `Task` (instead of renaming to
    // `Subagent`) and the server-only `## Tasks` / CloudAgent prompt section is not injected.
    // All four tracked-task tools (List/Create/Update/UpdateTags) are still mounted via `trackedTasks`.
    tasks: () => false,
  };
}

async function readBoxOrHostBytes({ library, remoteBox, agentId, agentDir, rawPath }) {
  const cleaned = String(rawPath ?? '').trim();
  if (!cleaned) throw new Error('Path is empty.');
  const path = cleaned.startsWith('file://') ? cleaned.slice('file://'.length) : cleaned;
  if (isAbsolute(path) && existsSync(path)) {
    return readFileSync(path);
  }
  const onBox = isAbsolute(path) && !isPathInside(agentDir, path) && typeof remoteBox?.downloadFile === 'function';
  if (onBox) {
    const [ctx, cancel] = library.createContext().withCancel();
    const timer = setTimeout(() => cancel(new Error('File read from box timed out')), BOX_TRANSFER_TIMEOUT_MS);
    try {
      const data = await remoteBox.downloadFile(ctx, agentId, path);
      return Buffer.from(data ?? []);
    } finally {
      clearTimeout(timer);
      cancel();
    }
  }
  const resolved = isAbsolute(path) ? path : resolve(agentDir, path);
  if (!existsSync(resolved)) throw new Error(`File not found: ${path}`);
  return readFileSync(resolved);
}

function isSupportedImageBytes(bytes) {
  if (!bytes || bytes.length < 12) return false;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // WebP
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  return false;
}

function notifyAutomationsChanged(tm, session, automationsExt) {
  try {
    tm.automationRuntime?.emitAutomations?.(session);
  } catch {}
  try {
    void automationsExt?.reconcileNow?.().catch?.(() => {});
  } catch {}
}

/**
 * Local `agentState` port backing UpdateMemory, UpdateRoutine, UpdateSkill,
 * UpdateProfile, UpdateAvatar, and DisconnectChannel.
 */
export function createLocalAgentStatePort({
  library,
  tm,
  session,
  agentId,
  agentDir,
  memoryStore,
  userMemory,
  remoteBox,
  automationsExt,
}) {
  const selectMemory = (scope) => (scope === 'user' && userMemory ? userMemory : memoryStore);

  return {
    async writeMemory({ content, tier = 'log', scope = 'agent' }) {
      const store = selectMemory(scope);
      if (!store || typeof store.addMemory !== 'function') {
        return stateWriteFailed('Memory store is unavailable for this agent.');
      }
      const text = String(content ?? '').trim();
      if (!text) return stateWriteFailed('Memory content cannot be empty.');
      const kind = tier === 'profile' ? 'profile' : 'log';
      store.addMemory(text, Date.now(), kind, 'agent');
      const scopeLabel = scope === 'user' ? 'user memory' : 'memory';
      return stateWriteOk(`Saved to ${scopeLabel} (${kind}): "${text}".`);
    },

    async removeMemory({ content, scope = 'agent' }) {
      const store = selectMemory(scope);
      if (!store || typeof store.removeMemoryByContent !== 'function') {
        return stateWriteFailed('Memory store is unavailable for this agent.');
      }
      const text = String(content ?? '').trim();
      if (!text) return stateWriteFailed('Memory text to forget cannot be empty.');
      const removed = store.removeMemoryByContent(text);
      if (!removed) return stateWriteFailed(`No matching memory found for "${text}".`);
      return stateWriteOk(`Forgot memory: "${text}".`);
    },

    async createAutomation({ spec, provenance = 'user' }) {
      const store = session.automations;
      if (!store || typeof store.upsert !== 'function') {
        return stateWriteFailed('Routine storage is unavailable for this agent.');
      }
      const created = store.upsert(spec, provenance);
      if (!created) {
        return stateWriteFailed('Could not create routine (check schedule validity or routine limit).');
      }
      notifyAutomationsChanged(tm, session, automationsExt);
      return stateWriteOk(`Created routine "${created.name}" (id: ${created.id}).`);
    },

    async updateAutomation({ id, spec, provenance = 'user' }) {
      const store = session.automations;
      if (!store || typeof store.update !== 'function') {
        return stateWriteFailed('Routine storage is unavailable for this agent.');
      }
      const updated = store.update(id, spec, provenance);
      if (!updated) {
        return stateWriteFailed(`Routine "${id}" could not be updated or was not found.`);
      }
      notifyAutomationsChanged(tm, session, automationsExt);
      return stateWriteOk(`Updated routine "${updated.name}" (id: ${updated.id}).`);
    },

    async setAutomationEnabled({ id, isEnabled }) {
      const store = session.automations;
      if (!store || typeof store.setEnabled !== 'function') {
        return stateWriteFailed('Routine storage is unavailable for this agent.');
      }
      const updated = store.setEnabled(id, Boolean(isEnabled));
      if (!updated) return stateWriteFailed(`Routine "${id}" was not found.`);
      notifyAutomationsChanged(tm, session, automationsExt);
      return stateWriteOk(`${isEnabled ? 'Resumed' : 'Paused'} routine "${updated.name}" (id: ${updated.id}).`);
    },

    async deleteAutomation({ id }) {
      const store = session.automations;
      const removeFn = store?.remove ?? store?.delete;
      if (!store || typeof removeFn !== 'function') {
        return stateWriteFailed('Routine storage is unavailable for this agent.');
      }
      const existing = store.get?.(id);
      const deleted = removeFn.call(store, id);
      if (!deleted) return stateWriteFailed(`Routine "${id}" was not found.`);
      notifyAutomationsChanged(tm, session, automationsExt);
      return stateWriteOk(`Deleted routine "${existing?.name ?? id}" (id: ${id}).`);
    },

    async writeSkill({ id, name, description, body, provenance = 'user' }) {
      const store = session.skills;
      if (!store) return stateWriteFailed('Skill storage is unavailable for this agent.');
      const existing = id ? store.get?.(id) : null;
      let saved = null;
      if (existing && existing.source !== 'managed' && existing.source !== 'automation') {
        saved = store.update?.(existing.id, { name, description, body }, provenance);
      }
      if (!saved) {
        saved = store.create?.({ name, description, body }, provenance);
      }
      if (!saved) {
        return stateWriteFailed(`Could not save skill "${name}".`);
      }
      try { tm.skillCommands?.emitSkills?.(session); } catch {}
      return stateWriteOk(`Saved skill "${saved.name}" (id: ${saved.id}).`, {
        savedSkill: { id: saved.id, name: saved.name },
      });
    },

    async deleteSkill({ id }) {
      const store = session.skills;
      const removeFn = store?.remove ?? store?.delete;
      if (!store || typeof removeFn !== 'function') {
        return stateWriteFailed('Skill storage is unavailable for this agent.');
      }
      const existing = store.get?.(id);
      const deleted = removeFn.call(store, id);
      if (!deleted) return stateWriteFailed(`Skill "${id}" was not found or cannot be deleted.`);
      try { tm.skillCommands?.emitSkills?.(session); } catch {}
      return stateWriteOk(`Deleted skill "${existing?.name ?? id}" (id: ${id}).`);
    },

    async updateProfile({ name, description, title, avatarShape, avatarColor }) {
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.description = description;
      if (title !== undefined) patch.title = title;
      if (avatarShape !== undefined) patch.avatarShape = avatarShape;
      if (avatarColor !== undefined) patch.avatarColor = avatarColor;
      if (Object.keys(patch).length === 0) {
        return stateWriteOk('No profile fields were changed.');
      }
      if (typeof tm.agentLifecycle?.updateAgent !== 'function') {
        return stateWriteFailed('Agent profile updates are unavailable.');
      }
      const updated = await tm.agentLifecycle.updateAgent(agentId, patch);
      if (!updated) return stateWriteFailed(`Agent ${agentId} was not found.`);
      return stateWriteOk(`Updated profile for "${updated.name}".`);
    },

    async updateSettings({ hiddenFromSidebar, notifyOnAgentUpdates, draftingDisabled }) {
      const changed = [];
      if (hiddenFromSidebar !== undefined && typeof tm.agentLifecycle?.setAgentHiddenFromSidebar === 'function') {
        await tm.agentLifecycle.setAgentHiddenFromSidebar(agentId, Boolean(hiddenFromSidebar));
        changed.push(`hidden_from_sidebar=${Boolean(hiddenFromSidebar)}`);
      }
      if (notifyOnAgentUpdates !== undefined && typeof tm.agentLifecycle?.setAgentNotifyOnUpdates === 'function') {
        await tm.agentLifecycle.setAgentNotifyOnUpdates(agentId, Boolean(notifyOnAgentUpdates));
        changed.push(`notify_on_updates=${Boolean(notifyOnAgentUpdates)}`);
      }
      if (draftingDisabled !== undefined && typeof tm.agentLifecycle?.setAgentDraftingDisabled === 'function') {
        await tm.agentLifecycle.setAgentDraftingDisabled(agentId, Boolean(draftingDisabled));
        changed.push(`drafting_disabled=${Boolean(draftingDisabled)}`);
      }
      if (changed.length === 0) return stateWriteOk('No settings were changed.');
      return stateWriteOk(`Updated settings (${changed.join(', ')}).`);
    },

    async setAvatar({ path }) {
      if (typeof tm.agentLifecycle?.setAgentAvatarBytes !== 'function') {
        return stateWriteFailed('Avatar updates are unavailable on this host.');
      }
      let bytes;
      try {
        bytes = await readBoxOrHostBytes({ library, remoteBox, agentId, agentDir, rawPath: path });
      } catch (err) {
        return stateWriteFailed(`Could not read avatar file at ${path}: ${err?.message ?? err}`);
      }
      if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
        return stateWriteFailed(`Avatar image must be between 1 byte and ${AVATAR_MAX_BYTES} bytes.`);
      }
      if (!isSupportedImageBytes(bytes)) {
        return stateWriteFailed('Avatar must be a valid PNG, JPEG, or WebP image.');
      }
      await tm.agentLifecycle.setAgentAvatarBytes(agentId, new Uint8Array(bytes));
      return stateWriteOk(`Updated avatar from ${basename(String(path))}.`);
    },

    async clearAvatar() {
      if (typeof tm.agentLifecycle?.setAgentAvatarBytes !== 'function') {
        return stateWriteFailed('Avatar updates are unavailable on this host.');
      }
      await tm.agentLifecycle.setAgentAvatarBytes(agentId, null);
      return stateWriteOk('Cleared avatar.');
    },

    async copyAvatar() {
      let bytes = null;
      try {
        if (typeof tm.sessionStore?.getAgentAvatarPng === 'function') {
          bytes = await tm.sessionStore.getAgentAvatarPng(agentId);
        }
      } catch {}
      if (!bytes && agentDir) {
        for (const candidate of ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp']) {
          const p = join(agentDir, candidate);
          if (existsSync(p)) {
            try { bytes = readFileSync(p); break; } catch {}
          }
        }
      }
      if (!bytes || bytes.length === 0) {
        return stateWriteFailed('No custom profile picture is currently set for this bot.');
      }
      const buf = Buffer.from(bytes);
      const hostCopyPath = agentDir ? join(agentDir, 'assets', 'avatar.png') : '';
      if (hostCopyPath) {
        mkdirSync(dirname(hostCopyPath), { recursive: true, mode: 0o700 });
        writeFileSync(hostCopyPath, buf, { mode: 0o600 });
      }
      if (typeof remoteBox?.uploadFile === 'function') {
        const boxPath = `/workspace/avatar-${agentId.slice(0, 8)}.png`;
        const [ctx, cancel] = library.createContext().withCancel();
        const timer = setTimeout(() => cancel(new Error('Avatar copy to box timed out')), BOX_TRANSFER_TIMEOUT_MS);
        try {
          await remoteBox.uploadFile(ctx, agentId, boxPath, buf);
          return stateWriteOk(`Copied your profile picture to ${boxPath}.`, { path: boxPath });
        } catch {
          // Fall back to local host path below.
        } finally {
          clearTimeout(timer);
          cancel();
        }
      }
      if (!hostCopyPath) return stateWriteFailed('Could not determine a destination path for the avatar copy.');
      return stateWriteOk(`Copied your profile picture to ${hostCopyPath}.`, { path: hostCopyPath });
    },

    async disconnectChannel({ platform }) {
      if (typeof tm.disconnectChannel !== 'function') {
        return stateWriteFailed('Channel management is not available on this self-hosted instance.');
      }
      tm.disconnectChannel(agentId, platform);
      return stateWriteOk(`Disconnected ${platform} channel.`);
    },
  };
}

/** Local `automationRunLog` port backing ListRoutineRuns. */
export function createLocalAutomationRunLogPort({ session }) {
  return {
    ownerChat: true,
    async list({ automationId, verdict = 'all', limit = 10, cursor }) {
      const rawRuns = session.automations?.readRuns?.(automationId) ?? [];
      const filteredRuns = rawRuns.filter((run) => {
        if (verdict === 'filtered') return run.status === 'filtered';
        if (verdict === 'accepted') return run.status !== 'filtered' && run.status !== 'skipped';
        return true;
      });
      let offset = 0;
      if (cursor !== undefined) {
        try {
          const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
          if (decoded.automationId !== automationId || decoded.verdict !== verdict || !Number.isInteger(decoded.offset) || decoded.offset < 0) {
            return { kind: 'bad_cursor' };
          }
          offset = decoded.offset;
        } catch {
          return { kind: 'bad_cursor' };
        }
      }
      const page = filteredRuns.slice(offset, offset + limit).map((run) => ({
        id: run.id,
        createdAtMs: run.startedAt ?? Date.now(),
        status: run.status === 'ok' ? 'succeeded' : (run.status ?? 'succeeded'),
        trigger: run.trigger ?? 'cron',
        ...(run.detail ? { reportedOutcome: { kind: run.status === 'error' ? 'failed' : 'acted', reason: String(run.detail) } } : {}),
        ...(run.event ? { payload: { view: 'raw', text: String(run.event) } } : {}),
      }));
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < filteredRuns.length
        ? Buffer.from(JSON.stringify({ automationId, verdict, offset: nextOffset })).toString('base64url')
        : undefined;
      return {
        kind: 'listed',
        verdict,
        runs: page,
        ...(nextCursor ? { nextCursor } : {}),
      };
    },
  };
}

/** Local `botReference` port backing UpdateReference (links + kept docs) + Reference skill view. */
export function createLocalBotReferencePort({ agentDir, agentId, remoteBox, library }) {
  const refPath = join(agentDir, 'reference.json');
  const docsDir = join(agentDir, 'reference-docs');
  const refSkillPath = join(agentDir, 'reference', 'SKILL.md');

  const load = () => {
    const data = readJsonFileSync(refPath, { links: [], docs: [] });
    return {
      links: Array.isArray(data.links) ? data.links : [],
      docs: Array.isArray(data.docs) ? data.docs : [],
    };
  };
  const renderReferenceSkillBody = (data) => {
    const sections = ['# Reference'];
    if (data.links.length > 0) {
      sections.push('\n## Links');
      for (const item of data.links) {
        const topics = item.commaSeparatedTopics ? ` (${item.commaSeparatedTopics})` : '';
        const note = item.oneLineNote && item.oneLineNote !== item.title ? ` — ${item.oneLineNote}` : '';
        sections.push(`- [${item.title}](${item.url})${topics}${note}`);
      }
    }
    if (data.docs.length > 0) {
      sections.push('\n## Kept Documents');
      for (const item of data.docs) {
        const topics = item.commaSeparatedTopics ? ` (${item.commaSeparatedTopics})` : '';
        const note = item.oneLineNote && item.oneLineNote !== item.title ? ` — ${item.oneLineNote}` : '';
        sections.push(`- **${item.title}** (\`${item.fileName}\`, host path \`${join(docsDir, item.fileName)}\`)${topics}${note}`);
      }
    }
    return sections.join('\n') + '\n';
  };
  const syncReferenceSkillFile = (data) => {
    if (data.links.length === 0 && data.docs.length === 0) {
      try { rmSync(refSkillPath, { force: true }); } catch {}
      return;
    }
    const body = renderReferenceSkillBody(data);
    const md = `---\nname: Reference\ndescription: Kept reference links and documents for this bot.\n---\n\n${body}`;
    mkdirSync(dirname(refSkillPath), { recursive: true, mode: 0o700 });
    writeFileSync(refSkillPath, md, { mode: 0o600 });
  };
  const save = (data) => {
    writeJsonFileSync(refPath, data);
    syncReferenceSkillFile(data);
  };
  const getReferenceSkill = () => {
    const data = load();
    if (data.links.length === 0 && data.docs.length === 0) return null;
    if (!existsSync(refSkillPath)) syncReferenceSkillFile(data);
    return {
      id: 'reference',
      name: 'Reference',
      description: `Kept reference links (${data.links.length}) and documents (${data.docs.length}) for this bot.`,
      body: renderReferenceSkillBody(data),
      trigger: null,
      source: 'workflow',
      sourceRef: null,
      pluginId: null,
      publishedByCurrentUser: false,
      scheduleDescription: null,
      createdAt: Date.now(),
      lastRunAt: null,
      nextRunAt: null,
      helperScripts: [],
      runs: [],
      filePath: refSkillPath,
    };
  };
  const allTitles = (data) => [
    ...data.links.map((item) => item.title),
    ...data.docs.map((item) => item.title),
  ];

  return {
    getReferenceSkill,
    async turnRefusal() {
      return undefined;
    },
    async addLink({ link }) {
      const data = load();
      const idx = data.links.findIndex((entry) => entry.url === link.url);
      const record = {
        title: link.title,
        url: link.url,
        oneLineNote: link.oneLineNote ?? link.title,
        ...(link.commaSeparatedTopics ? { commaSeparatedTopics: link.commaSeparatedTopics } : {}),
        updatedAtMs: Date.now(),
      };
      const kind = idx >= 0 ? 'updated' : 'added';
      if (idx >= 0) data.links[idx] = record;
      else data.links.push(record);
      save(data);
      return {
        kind,
        title: record.title,
        urlOrFileName: record.url,
        titlesHeldAfterChange: allTitles(data),
      };
    },
    async remove({ url }) {
      const data = load();
      const idx = data.links.findIndex((entry) => entry.url === url);
      if (idx < 0) return { kind: 'refused', reason: `No reference link found for ${url}.` };
      const [removed] = data.links.splice(idx, 1);
      save(data);
      return {
        kind: 'removed',
        title: removed.title,
        urlOrFileName: removed.url,
        titlesHeldAfterChange: allTitles(data),
      };
    },
    docs: {
      async add({ doc }) {
        const data = load();
        let bytes;
        let fileName = doc.requestedFileName;
        if (doc.source?.kind === 'text') {
          bytes = Buffer.from(String(doc.source.text ?? ''), 'utf8');
          fileName = fileName || `${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note'}.md`;
        } else if (doc.source?.kind === 'sent_file') {
          try {
            bytes = await readBoxOrHostBytes({ library, remoteBox, agentId, agentDir, rawPath: doc.source.path });
          } catch (err) {
            return { kind: 'refused', reason: `Could not read file ${doc.source.path}: ${err?.message ?? err}` };
          }
          fileName = fileName || basename(doc.source.path);
        } else {
          return { kind: 'refused', reason: 'Unsupported reference document source.' };
        }
        const safeName = basename(String(fileName || 'reference.txt')).replace(/[\x00-\x1f/\\]/g, '_');
        mkdirSync(docsDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(docsDir, safeName), bytes, { mode: 0o600 });
        const idx = data.docs.findIndex((entry) => entry.fileName === safeName);
        const record = {
          title: doc.title,
          fileName: safeName,
          oneLineNote: doc.oneLineNote ?? doc.title,
          ...(doc.commaSeparatedTopics ? { commaSeparatedTopics: doc.commaSeparatedTopics } : {}),
          updatedAtMs: Date.now(),
        };
        const kind = idx >= 0 ? 'updated' : 'added';
        if (idx >= 0) data.docs[idx] = record;
        else data.docs.push(record);
        save(data);
        return {
          kind,
          title: record.title,
          urlOrFileName: safeName,
          keptFile: { openToEveryoneWhoUsesTheBot: false },
          titlesHeldAfterChange: allTitles(data),
        };
      },
      async remove({ fileName }) {
        const data = load();
        const idx = data.docs.findIndex((entry) => entry.fileName === fileName || entry.title === fileName);
        if (idx < 0) return { kind: 'refused', reason: `No kept reference document named "${fileName}".` };
        const [removed] = data.docs.splice(idx, 1);
        let fileDeleted = true;
        try { rmSync(join(docsDir, removed.fileName), { force: true }); } catch { fileDeleted = false; }
        save(data);
        return {
          kind: 'removed',
          title: removed.title,
          urlOrFileName: removed.fileName,
          keptFile: { fileDeleted },
          titlesHeldAfterChange: allTitles(data),
        };
      },
    },
  };
}

/** Local `botResources` and `botResourceRemoval` ports for ListBotResources / RemoveBotResource. */
export function createLocalBotResourcesPorts({ agentId, dataDir, session, tm, mcpExt }) {
  const listFiles = async () => {
    if (!dataDir) return [];
    try {
      const { files } = await listAgentLibraryFiles(dataDir, agentId);
      return files;
    } catch {
      return [];
    }
  };
  const listSkills = () => (session.skills?.list?.() ?? []).filter((skill) => skill.source !== 'managed');
  const listAccounts = async () => {
    try {
      const servers = await mcpExt?.management?.listServers?.() ?? [];
      return servers.map((srv) => ({ name: srv.name ?? srv.identifier ?? String(srv), status: srv.status ?? 'connected' }));
    } catch {
      return [];
    }
  };

  const botResources = {
    async list({ sections = ['files', 'skills', 'vault', 'connectors'] } = {}) {
      const want = new Set(sections);
      const listing = { unavailable: [] };
      if (want.has('files')) {
        const files = await listFiles();
        listing.files = files.map((f) => ({ name: f.name, sizeBytes: f.sizeBytes }));
      }
      if (want.has('skills')) {
        listing.skills = listSkills().map((s) => ({ id: s.id, name: s.name, description: s.description }));
      }
      if (want.has('vault') || want.has('credentials')) {
        listing.vaultLogins = [];
      }
      if (want.has('connectors')) {
        listing.botAccounts = await listAccounts();
      }
      return { kind: 'ok', listing };
    },
  };

  const botResourceRemoval = {
    async prepare({ kind, name }) {
      const target = String(name ?? '').trim().toLowerCase();
      const botName = tm.roster?.listAgentsSync?.()?.find((a) => a.id === agentId)?.name ?? 'this bot';
      if (kind === 'bot-file') {
        const files = await listFiles();
        const match = files.find((f) => f.name.toLowerCase() === target);
        if (!match) return { kind: 'not_found', listed: files.map((f) => f.name) };
        return { kind: 'ready', botName, removal: { kind: 'bot-file', id: match.name, name: match.name } };
      }
      if (kind === 'bot-skill') {
        const skills = listSkills();
        const match = skills.find((s) => s.name.toLowerCase() === target || s.id.toLowerCase() === target);
        if (!match) return { kind: 'not_found', listed: skills.map((s) => s.name) };
        return { kind: 'ready', botName, removal: { kind: 'bot-skill', id: match.id, name: match.name } };
      }
      return { kind: 'not_found', listed: [] };
    },
  };

  return { botResources, botResourceRemoval };
}

/** Build a lightweight harness-compatible tool backed by ToolFramework bindings. */
export function makeLocalHarnessTool(library, { name, description, schema, contextType, run }) {
  const tf = library?.getToolFrameworkRecoveryBindings?.() ?? {};
  const jsonSchemaFn = tf.jsonSchema ?? ((s) => ({ jsonSchema: s }));
  const createStringResult = tf.createStringResult ?? ((content, isError = false) => ({
    content: [{ type: 'text', text: content }],
    isError,
  }));

  // The harness hands `execute`'s return value to `render` and merges it into the
  // client-visible McpToolCall as `McpToolCall.result`, which is an `McpToolResult`
  // (oneof success: McpSuccess { content: McpToolResultContentItem[] }, error: McpToolError).
  // `McpResult` is the executor-level envelope and must not be used here: building it
  // around an `McpToolResult({ content })` silently drops the text (McpToolResult has no
  // `content` field), which is how every local tool used to return an empty body.
  const hasProto = Boolean(tf.McpToolResult && tf.McpSuccess && tf.McpToolResultContentItem && tf.McpTextContent);
  const buildResultPayload = (text, isError = false) => {
    if (hasProto) {
      return new tf.McpToolResult({
        result: {
          case: 'success',
          value: new tf.McpSuccess({
            content: [new tf.McpToolResultContentItem({
              content: { case: 'text', value: new tf.McpTextContent({ text }) },
            })],
            isError,
          }),
        },
      });
    }
    return {
      result: {
        case: 'success',
        value: { content: [{ content: { case: 'text', value: { text } } }], isError },
      },
    };
  };

  const wrapToolCall = (toolCallId, resultPayload) => {
    if (tf.ToolCall && tf.McpToolCall) {
      const argsInit = { name, toolName: name, providerIdentifier: 'rokbot-local', ...(toolCallId ? { toolCallId } : {}) };
      return new tf.ToolCall({
        tool: {
          case: 'mcpToolCall',
          value: new tf.McpToolCall({
            args: tf.McpArgs ? new tf.McpArgs(argsInit) : argsInit,
            ...(resultPayload ? { result: resultPayload } : {}),
          }),
        },
      });
    }
    return { tool: { case: 'mcpToolCall', value: { args: { name, toolName: name }, result: resultPayload } } };
  };

  const textOfItem = (item) => {
    const value = item?.content?.value ?? item;
    if (typeof value === 'string') return value;
    return String(value?.text ?? item?.text ?? '');
  };

  return {
    toolIdentifier: name,
    name,
    ...(contextType ? { contextType } : {}),
    descriptionGenerator: () => description,
    parameters: jsonSchemaFn(schema),
    rebuildsEqualParameters: true,
    execute: async (ctx, interactionHandler, argsStream, meta) => {
      let raw = '';
      for await (const chunk of argsStream) raw += chunk;
      let parsed = {};
      if (raw.trim().length > 0) {
        try { parsed = JSON.parse(raw); } catch { parsed = {}; }
      }
      const invoke = async () => {
        try {
          const text = await run(parsed, ctx, meta);
          return buildResultPayload(String(text ?? ''), false);
        } catch (err) {
          return buildResultPayload(err?.message ?? String(err), true);
        }
      };
      if (typeof interactionHandler?.executeToolCall === 'function') {
        const toolCallId = meta?.toolCallId ?? randomUUID();
        return await interactionHandler.executeToolCall(
          ctx,
          wrapToolCall(toolCallId),
          toolCallId,
          invoke,
          (resultPayload) => wrapToolCall(toolCallId, resultPayload),
        );
      }
      return await invoke();
    },
    render: async (_ctx, output) => {
      const res = output?.result;
      if (res?.case === 'error') {
        return createStringResult(String(res.value?.error ?? 'Tool failed.'), true);
      }
      if (res?.case === 'rejected') {
        return createStringResult(String(res.value?.reason || 'Tool rejected.'), true);
      }
      const items = res?.value?.content;
      if (Array.isArray(items) && items.length > 0) {
        return createStringResult(items.map(textOfItem).join('\n'), Boolean(res?.value?.isError));
      }
      return createStringResult(String(res?.value?.text ?? ''), Boolean(res?.value?.isError));
    },
    serializeError: (err) => wrapToolCall(undefined, buildResultPayload(err?.message ?? String(err), true)),
  };
}

/**
 * Local JSON-backed Tracked Tasks store + tools
 * (ListTrackedTasks, CreateTrackedTasks, UpdateTrackedTasks, UpdateTrackedTaskTags).
 */
export function createLocalTrackedTasksPort({ library, agentDir }) {
  const filePath = join(agentDir, 'tracked-tasks.json');
  const load = () => {
    const data = readJsonFileSync(filePath, { nextSeq: 1, tags: [], tasks: [] });
    return {
      nextSeq: Number.isInteger(data.nextSeq) && data.nextSeq > 0 ? data.nextSeq : 1,
      tags: Array.isArray(data.tags) ? data.tags : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
    };
  };
  const save = (data) => writeJsonFileSync(filePath, data);

  const formatTaskLine = (t) => {
    const tagStr = Array.isArray(t.tags) && t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : '';
    const notesStr = t.notes ? ` — ${t.notes}` : '';
    return `- ${t.key} (v${t.version}) [${t.status}]${tagStr}: ${t.title}${notesStr}`;
  };

  const listTool = makeLocalHarnessTool(library, {
    name: 'ListTrackedTasks',
    description: 'List tracked tasks for this bot. Optionally filter by status or tag.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: TRACKED_TASK_STATUSES, description: 'Optional status filter.' },
        tag: { type: 'string', description: 'Optional tag filter.' },
        include_closed: { type: 'boolean', description: 'Include done and canceled tasks (default false).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const data = load();
      const filtered = data.tasks.filter((t) => {
        if (args.status && t.status !== args.status) return false;
        if (!args.status && !args.include_closed && (t.status === 'done' || t.status === 'canceled')) return false;
        if (args.tag && !(t.tags ?? []).includes(args.tag)) return false;
        return true;
      });
      if (filtered.length === 0) {
        const tagLine = data.tags.length > 0 ? ` Available tags: ${data.tags.join(', ')}.` : '';
        return `No tracked tasks match.${tagLine}`;
      }
      const header = data.tags.length > 0 ? `Tags: ${data.tags.join(', ')}\n` : '';
      return `${header}${filtered.map(formatTaskLine).join('\n')}`;
    },
  });

  const createTool = makeLocalHarnessTool(library, {
    name: 'CreateTrackedTasks',
    description: 'Create one or more tracked tasks to organize work streams and subagent handoffs.',
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1 },
              status: { type: 'string', enum: TRACKED_TASK_STATUSES },
              notes: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
            additionalProperties: true,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: true,
    },
    run: async (args) => {
      const items = Array.isArray(args.tasks) ? args.tasks : [];
      if (items.length === 0) return 'No tasks provided.';
      const data = load();
      const created = [];
      for (const item of items) {
        const title = String(item?.title ?? '').trim();
        if (!title) continue;
        const key = `T-${data.nextSeq++}`;
        const status = TRACKED_TASK_STATUSES.includes(item.status) ? item.status : 'queued';
        const tags = Array.isArray(item.tags) ? item.tags.map((s) => String(s).trim()).filter(Boolean) : [];
        for (const tag of tags) if (!data.tags.includes(tag)) data.tags.push(tag);
        const task = {
          key,
          title,
          status,
          version: 1,
          notes: typeof item.notes === 'string' ? item.notes.trim() : '',
          tags,
          links: [],
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        };
        data.tasks.push(task);
        created.push(task);
      }
      save(data);
      return `Created ${created.length} task(s):\n${created.map(formatTaskLine).join('\n')}`;
    },
  });

  const updateTool = makeLocalHarnessTool(library, {
    name: 'UpdateTrackedTasks',
    description: 'Update status, title, notes, tags, or worker links on one or more existing tracked tasks.',
    schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', minLength: 1 },
              task_key: { type: 'string', minLength: 1 },
              version: { type: 'number' },
              title: { type: 'string' },
              status: { type: 'string', enum: TRACKED_TASK_STATUSES },
              notes: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: true,
          },
        },
      },
      required: ['updates'],
      additionalProperties: true,
    },
    run: async (args) => {
      const updates = Array.isArray(args.updates) ? args.updates : [];
      if (updates.length === 0) return 'No task updates provided.';
      const data = load();
      const lines = [];
      for (const patch of updates) {
        const key = String(patch?.key ?? patch?.task_key ?? '').trim();
        const task = data.tasks.find((t) => t.key === key);
        if (!task) {
          lines.push(`- ${key || '(empty)'}: not found`);
          continue;
        }
        if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim();
        if (TRACKED_TASK_STATUSES.includes(patch.status)) task.status = patch.status;
        if (typeof patch.notes === 'string') task.notes = patch.notes.trim();
        if (Array.isArray(patch.tags)) {
          task.tags = patch.tags.map((s) => String(s).trim()).filter(Boolean);
          for (const tag of task.tags) if (!data.tags.includes(tag)) data.tags.push(tag);
        }
        task.version = (task.version ?? 1) + 1;
        task.updatedAtMs = Date.now();
        lines.push(formatTaskLine(task));
      }
      save(data);
      return `Updated tasks:\n${lines.join('\n')}`;
    },
  });

  const tagsTool = makeLocalHarnessTool(library, {
    name: 'UpdateTrackedTaskTags',
    description: 'Add, rename, or remove tracked task tags for this bot.',
    schema: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
    run: async (args) => {
      const data = load();
      for (const tag of args.add ?? []) {
        const clean = String(tag).trim();
        if (clean && !data.tags.includes(clean)) data.tags.push(clean);
      }
      const removals = new Set((args.remove ?? []).map((t) => String(t).trim()));
      if (removals.size > 0) {
        data.tags = data.tags.filter((t) => !removals.has(t));
        for (const task of data.tasks) {
          task.tags = (task.tags ?? []).filter((t) => !removals.has(t));
        }
      }
      save(data);
      return data.tags.length > 0 ? `Tracked task tags: ${data.tags.join(', ')}.` : 'No tracked task tags configured.';
    },
  });

  return {
    tools: [listTool, createTool, updateTool, tagsTool],
    async read(key) {
      const data = load();
      return data.tasks.find((t) => t.key === key);
    },
    async linkSubagent({ keys, subagentId, callId }) {
      const data = load();
      const linked = [];
      for (const key of keys ?? []) {
        const task = data.tasks.find((t) => t.key === key);
        if (!task) continue;
        const reopened = task.status === 'done';
        const staysCanceled = task.status === 'canceled';
        if (!staysCanceled) task.status = 'in_progress';
        task.links = [...(task.links ?? []), { kind: 'subagent', subagentId, callId, linkedAtMs: Date.now() }];
        task.version = (task.version ?? 1) + 1;
        task.updatedAtMs = Date.now();
        linked.push({ key: task.key, title: task.title, reopened, ...(staysCanceled ? { staysCanceled: true } : {}) });
      }
      save(data);
      return linked;
    },
    async currentTaskList() {
      const data = load();
      const open = data.tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled');
      if (open.length === 0) return '';
      return open.map(formatTaskLine).join('\n');
    },
  };
}

/** Local `agentManagement` port backing ListSections, CreateAgent, UpdateAgent, SetPrimaryBot. */
export function createLocalAgentManagementPort({ tm, dataDir }) {
  const sectionsPath = dataDir ? join(dataDir, 'sidebar-sections.json') : null;
  const primaryBotPath = dataDir ? join(dataDir, 'primary-bot.json') : null;

  return {
    async listSections() {
      if (!sectionsPath) return [];
      const stored = readJsonFileSync(sectionsPath, []);
      const list = Array.isArray(stored) ? stored : (Array.isArray(stored?.sections) ? stored.sections : []);
      return list
        .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
        .map((s) => ({ id: s.id, name: s.name }));
    },
    async create({ name, description, sectionId }) {
      const cleanName = String(name ?? '').trim() || 'Assistant';
      const cleanDesc = String(description ?? '').trim();
      if (typeof tm.sessionStore?.createSession === 'function') {
        const createdSession = await tm.sessionStore.createSession(
          { name: cleanName, description: cleanDesc },
          'agent',
        );
        try {
          await createdSession.agentStore?.dispose?.();
          createdSession.db?.close?.({ checkpoint: true });
        } catch {}
        if (sectionId && sectionsPath) {
          const assignmentsPath = join(dirname(sectionsPath), 'agent-sections.json');
          const assignments = readJsonFileSync(assignmentsPath, {});
          assignments[createdSession.id] = sectionId;
          writeJsonFileSync(assignmentsPath, assignments);
        }
        await tm.roster?.emitAgents?.();
        return { id: createdSession.id, name: cleanName };
      }
      const created = await tm.agentLifecycle.createAgent({ name: cleanName, description: cleanDesc }, 'agent');
      return { id: created.agent.id, name: created.agent.name };
    },
    async update(targetId, patch) {
      const updated = await tm.agentLifecycle?.updateAgent?.(targetId, patch);
      if (!updated) return null;
      return { id: updated.id, name: updated.name };
    },
    async setPrimaryBot(targetId) {
      const agents = tm.roster?.listAgentsSync?.() ?? [];
      const target = agents.find((a) => a.id === targetId && !a.isGroup);
      if (!target) {
        return { kind: 'refused', reason: 'not_owner' };
      }
      if (primaryBotPath) {
        writeJsonFileSync(primaryBotPath, { agentId: target.id, updatedAtMs: Date.now() });
      }
      return { id: target.id, name: target.name };
    },
  };
}

function transcriptEntryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.kind === 'message') {
    return typeof entry.content === 'string' ? entry.content : '';
  }
  if (entry.kind === 'send-message') {
    const msg = entry.message;
    if (typeof msg?.content === 'string') return msg.content;
    if (typeof msg?.text === 'string') return msg.text;
    if (msg?.type === 'widget' && typeof msg?.widget?.prompt === 'string') return msg.widget.prompt;
  }
  return '';
}

function isSpokenTranscriptEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
    return transcriptEntryText(entry).trim().length > 0;
  }
  if (entry.kind === 'send-message') {
    return transcriptEntryText(entry).trim().length > 0;
  }
  return false;
}

/** Local group chat ports backing ListGroupBots, ReadGroupChat, PostToGroupChat, RemoveGroupBot. */
export function createLocalGroupChatPorts({ tm, agentId }) {
  const listGroups = () => (tm.roster?.listAgentsSync?.() ?? []).filter((a) => a.isGroup);
  const groupMemberIds = (groupId) => {
    try {
      const dir = tm.sessionStore?.getAgentDir?.(groupId);
      const cfg = dir ? tm.groupChat?.localGroupConfig?.(dir) : null;
      return Array.isArray(cfg?.memberIds) ? cfg.memberIds : [];
    } catch {
      return [];
    }
  };
  const agentNameById = (id) => tm.roster?.listAgentsSync?.()?.find((a) => a.id === id)?.name ?? id;

  const messagingGroupBots = {
    async list() {
      const groups = listGroups();
      return {
        kind: 'shown',
        bots: groups.map((g) => ({
          id: g.id,
          name: g.name,
          named: true,
          state: 'active',
          otherMembers: groupMemberIds(g.id).map(agentNameById),
        })),
        notShown: 0,
      };
    },
    async checkRemoval(groupId) {
      const group = listGroups().find((g) => g.id === groupId);
      if (!group) return { kind: 'not_found' };
      const members = groupMemberIds(groupId);
      return {
        kind: 'ready',
        groupBot: { id: group.id, name: group.name, otherMemberCount: members.length },
      };
    },
    countRemovalApproval() {},
    async remove(groupId) {
      const group = listGroups().find((g) => g.id === groupId);
      if (!group) return { kind: 'not_found' };
      const members = groupMemberIds(groupId);
      if (!members.includes(agentId)) return { kind: 'not_in_group' };
      const remaining = members.filter((id) => id !== agentId);
      if (remaining.length === 0) return { kind: 'muted', reason: 'too_small' };
      await tm.groupChat.setGroupMembers(groupId, remaining);
      return { kind: 'left' };
    },
  };

  const messagingGroupRead = {
    async read(groupId) {
      const group = listGroups().find((g) => g.id === groupId);
      if (!group) return { kind: 'not_found' };
      const entries = (await tm.sessions?.getAgentTranscript?.(groupId)) ?? [];
      const lines = entries
        .filter(isSpokenTranscriptEntry)
        .slice(-50)
        .map((entry) => {
          const text = transcriptEntryText(entry);
          const isUser = entry.kind === 'message' && entry.role === 'user';
          const senderName = entry.senderName ?? entry.authorName ?? entry.message?.senderName;
          return {
            author: isUser ? 'owner' : (senderName ? 'member' : 'bot'),
            ...(senderName ? { member: String(senderName) } : {}),
            text,
            attachments: 0,
            omittedBefore: 0,
            postedByGrokBot: Boolean(entry.kind === 'send-message' && entry.senderId === agentId),
          };
        });
      return { kind: 'shown', lines };
    },
  };

  const messagingGroupPost = {
    async availability() {
      return 'available';
    },
    async describe(groupId) {
      const group = listGroups().find((g) => g.id === groupId);
      if (!group) return undefined;
      return {
        id: group.id,
        name: group.name,
        otherMemberCount: groupMemberIds(groupId).length,
      };
    },
    async post({ groupBotId, text }) {
      const group = listGroups().find((g) => g.id === groupBotId);
      if (!group) return 'not_found';
      if (typeof tm.groupChat?.postToGroupWithStatus === 'function') {
        const res = await tm.groupChat.postToGroupWithStatus({
          fromAgentId: agentId,
          groupId: groupBotId,
          text,
        });
        if (res?.status === 'delivered' || res?.status === 'posted' || res?.status === 'ok') return 'posted';
        if (res?.status === 'not_found') return 'not_found';
        if (res?.status === 'not_member') {
          // Allow posting into local group on behalf of the owner when this bot isn't a member.
          await tm.sendPrompt(text, { agentId: groupBotId, awaitTurn: false });
          return 'posted';
        }
      }
      await tm.sendPrompt(text, { agentId: groupBotId, awaitTurn: false });
      return 'posted';
    },
  };

  return { messagingGroupBots, messagingGroupRead, messagingGroupPost };
}

/** Local `transcriptReader` port backing ReadTranscript and SearchTranscripts. */
export function createLocalTranscriptReaderPort({ tm, session, agentId }) {
  const listAgents = () => tm.roster?.listAgentsSync?.() ?? [];
  const resolveAgentId = (target) => {
    if (!target || target.kind === 'self') return agentId;
    if (target.kind === 'session') return target.sessionId;
    if (target.kind === 'agent') return target.agentId;
    return undefined;
  };
  const labelFor = (id) => {
    if (id === agentId) return 'this session';
    const agent = listAgents().find((a) => a.id === id);
    return agent ? `${agent.name} (${agent.id})` : id;
  };
  const readEntriesFor = async (id) => {
    if (id === agentId && tm.sessions?.activeSession?.id === agentId && typeof tm.sessions?.getEntries === 'function') {
      return tm.sessions.getEntries();
    }
    if (id === agentId && typeof session.db?.getTranscriptEntries === 'function') {
      return session.db.getTranscriptEntries();
    }
    return (await tm.sessions?.getAgentTranscript?.(id)) ?? [];
  };
  const spokenMessagesOf = async (id) => {
    const entries = await readEntriesFor(id);
    const messages = [];
    let pos = 0;
    for (const entry of entries) {
      if (!isSpokenTranscriptEntry(entry)) continue;
      const role = entry.kind === 'message' && entry.role === 'user' ? 'user' : 'assistant';
      const text = transcriptEntryText(entry);
      messages.push({
        position: pos++,
        role,
        text,
        timestampMs: entry.timestampMs ?? Date.now(),
        ...(role === 'user' ? { speaker: 'User' } : { speaker: labelFor(id) }),
      });
    }
    return messages;
  };

  const openSpoken = async (_ctx, target) => {
    const targetId = resolveAgentId(target);
    if (!targetId) return { kind: 'refused', message: 'Unknown transcript target.' };
    if (targetId !== agentId && !listAgents().some((a) => a.id === targetId)) {
      return { kind: 'refused', message: `No transcript found for ${targetId}.` };
    }
    return {
      kind: 'messages-only',
      label: labelFor(targetId),
      async readMessages({ limit = 30, before } = {}) {
        const all = await spokenMessagesOf(targetId);
        const end = before === undefined ? all.length : Math.max(0, Math.min(all.length, before));
        const start = Math.max(0, end - limit);
        return {
          messages: all.slice(start, end),
          ...(start > 0 ? { nextBefore: start } : {}),
        };
      },
    };
  };

  const searchInAgent = async (id, req) => {
    const messages = await spokenMessagesOf(id);
    const q = typeof req.query === 'string' ? req.query.trim().toLowerCase() : '';
    const hits = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (req.afterMs !== undefined && msg.timestampMs < req.afterMs) continue;
      if (req.beforeMs !== undefined && msg.timestampMs > req.beforeMs) continue;
      if (req.onlyWhereViewerSpoke && msg.role !== 'user') continue;
      if (q && !msg.text.toLowerCase().includes(q) && !(msg.speaker ?? '').toLowerCase().includes(q)) continue;
      hits.push({
        position: msg.position,
        text: msg.text.slice(0, 500),
        speaker: msg.speaker,
        timestampMs: msg.timestampMs,
        ...(id === agentId ? {} : { sessionId: id, sessionLabel: labelFor(id) }),
      });
    }
    return hits;
  };

  return {
    async resolveTranscriptId(_ctx, scope) {
      const cleaned = String(scope ?? '').trim();
      if (!cleaned || cleaned === 'this' || cleaned === agentId) return { kind: 'self' };
      const agents = listAgents();
      const byId = agents.find((a) => a.id === cleaned);
      if (byId) return { kind: 'session', sessionId: byId.id };
      const byName = agents.filter((a) => a.name.toLowerCase() === cleaned.toLowerCase());
      if (byName.length === 1) return { kind: 'session', sessionId: byName[0].id };
      return { kind: 'refused', message: `No session found matching "${cleaned}".` };
    },
    openTranscript: openSpoken,
    openSpokenTranscript: openSpoken,
    async searchTranscript(_ctx, target, req) {
      const targetId = resolveAgentId(target);
      if (!targetId) return { kind: 'refused', message: 'Unknown transcript target.' };
      const hits = await searchInAgent(targetId, req);
      const limit = req.limit ?? 10;
      return { kind: 'ok', hits: hits.slice(0, limit) };
    },
    async searchReadableTranscripts(_ctx, req) {
      const agents = listAgents();
      const ids = [...new Set([agentId, ...agents.map((a) => a.id)])];
      const allHits = [];
      for (const id of ids) {
        allHits.push(...await searchInAgent(id, req));
      }
      allHits.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
      const limit = req.limit ?? 10;
      return { kind: 'ok', hits: allHits.slice(0, limit) };
    },
  };
}

/** Local `agentActivity` port backing ReadAgentActivity. */
export function createLocalAgentActivityPort({ tm, agentId }) {
  return {
    async readOwnedAgentActivity({ sinceHours = 24, maxAgents = 10, excerptChars = 600 }) {
      const others = (tm.roster?.listAgentsSync?.() ?? []).filter((a) => a.id !== agentId && !a.isGroup);
      if (others.length === 0) return { kind: 'unavailable' };
      const cutoff = Date.now() - sinceHours * 3600 * 1000;
      const summaries = [];
      for (const agent of others) {
        const entries = (await tm.sessions?.getAgentTranscript?.(agent.id)) ?? [];
        const spoken = entries.filter(isSpokenTranscriptEntry);
        let lastUserMs = null;
        let lastAssistantMs = null;
        const recentLines = [];
        for (const entry of spoken) {
          const ts = entry.timestampMs ?? 0;
          if (entry.kind === 'message' && entry.role === 'user') {
            if (lastUserMs === null || ts > lastUserMs) lastUserMs = ts;
          } else if (lastAssistantMs === null || ts > lastAssistantMs) {
            lastAssistantMs = ts;
          }
          if (ts >= cutoff) {
            const who = entry.kind === 'message' && entry.role === 'user' ? 'User' : agent.name;
            recentLines.push(`${who}: ${transcriptEntryText(entry)}`);
          }
        }
        const latestMs = Math.max(lastUserMs ?? 0, lastAssistantMs ?? 0);
        if (latestMs < cutoff) continue;
        let excerpt = recentLines.slice(-8).join('\n');
        if (excerpt.length > excerptChars) excerpt = `…${excerpt.slice(-(excerptChars - 1))}`;
        const todos = (await tm.agentTodos?.get?.(agent.id)) ?? [];
        const openTodos = Array.isArray(todos)
          ? todos.filter((t) => t.status === 'pending' || t.status === 'in_progress').map((t) => ({ status: t.status, content: t.content }))
          : [];
        summaries.push({
          agentId: agent.id,
          name: agent.name,
          description: agent.description ?? '',
          latestMs,
          lastUserMessageAt: lastUserMs ? new Date(lastUserMs).toISOString() : null,
          lastAssistantMessageAt: lastAssistantMs ? new Date(lastAssistantMs).toISOString() : null,
          openTodos,
          pendingQuestions: [],
          recentExcerpt: excerpt,
        });
      }
      summaries.sort((a, b) => b.latestMs - a.latestMs);
      const truncated = summaries.length > maxAgents;
      return {
        kind: 'ok',
        agents: summaries.slice(0, maxAgents).map(({ latestMs: _m, ...rest }) => rest),
        truncated,
      };
    },
  };
}

/** Local `boxHandoff` port backed by the host's built-in BoxHandoffService (extensions('session')). */
export function createLocalBoxHandoffPort({ sessionExt }) {
  if (typeof sessionExt?.startHandoff !== 'function') return undefined;
  return {
    requestHelp: (request) => sessionExt.startHandoff(request),
  };
}

/**
 * Local `userForm` port. Showing a form needs no registration: the kernel's UserFormResponses
 * finds the pending card by its transcript entry (formRequestId), fills through the session
 * UserFormService (fillUserForm) and, for 1:1 bots, installLocalUserFormResume resumes the turn.
 * There is no local remap write path (the session extension exposes no way to re-write a held
 * value), so remapTargets always answers no_hold and the tool tells the model to re-ask.
 */
export function createLocalUserFormPort({ sessionExt }) {
  if (!sessionExt) return undefined;
  const activeRemaps = new Set();
  return {
    async requestForm({ agentId, form }) {
      const requestId = randomUUID();
      return { kind: 'started', requestId, form };
    },
    hasRemapHold: (id) => activeRemaps.has(id),
    async remapTargets({ agentId, targets }) {
      if (!activeRemaps.has(agentId)) {
        return { kind: 'no_hold' };
      }
      activeRemaps.delete(agentId);
      return { kind: 'remapped', targetsCount: Array.isArray(targets) ? targets.length : 0 };
    },
  };
}

/** Local `botFileCopy` port backing CopyBotFile using RokBot's per-bot Library. */
export function createLocalBotFileCopyPort({ dataDir, agentId, remoteBox, library }) {
  const listFiles = async () => {
    if (!dataDir) return [];
    const { files } = await listAgentLibraryFiles(dataDir, agentId);
    return files;
  };
  return {
    async list() {
      try {
        const files = await listFiles();
        return { kind: 'ok', names: files.map((f) => f.name) };
      } catch (err) {
        return { kind: 'unavailable', message: `Could not read bot library: ${err?.message ?? err}` };
      }
    },
    async copyToBox({ name }) {
      let files;
      try {
        files = await listFiles();
      } catch (err) {
        return { kind: 'unavailable', message: `Could not read bot library: ${err?.message ?? err}` };
      }
      const match = files.find((f) => f.name === name);
      if (!match) return { kind: 'not_found', available: files.map((f) => f.name) };
      const bytes = readFileSync(match.path);
      if (typeof remoteBox?.uploadFile === 'function') {
        const boxPath = `/workspace/.rokbot-library/${agentId}/${match.name}`;
        const [ctx, cancel] = library.createContext().withCancel();
        const timer = setTimeout(() => cancel(new Error('CopyBotFile upload timed out')), BOX_TRANSFER_TIMEOUT_MS);
        try {
          await remoteBox.uploadFile(ctx, agentId, boxPath, bytes);
        } finally {
          clearTimeout(timer);
          cancel();
        }
        return { kind: 'copied', name: match.name, boxPath, sizeBytes: bytes.length };
      }
      const text = bytes.toString('utf8');
      const truncated = text.length > 32_000;
      return { kind: 'read', name: match.name, sizeBytes: bytes.length, text: truncated ? text.slice(0, 32_000) : text, truncated };
    },
  };
}

/**
 * Local `connectorFiles` port backing UploadFile and DownloadFile.
 * Exposes connected MCP file-storage connectors when present, or reports available connections clearly.
 */
export function createLocalConnectorFilesPort({ agentId, agentDir, remoteBox, mcpExt, library }) {
  const detectStorageService = (name) => {
    const lower = String(name ?? '').toLowerCase();
    if (lower.includes('google-drive') || lower.includes('gdrive')) return 'google-drive';
    if (lower.includes('onedrive')) return 'onedrive';
    if (lower.includes('sharepoint')) return 'sharepoint';
    if (lower.includes('gmail')) return 'gmail';
    if (lower.includes('outlook')) return 'outlook';
    return null;
  };

  return {
    offersWithoutMcpTools: true,
    async listConnections(_direction) {
      const servers = (await mcpExt?.management?.listServers?.().catch?.(() => [])) ?? [];
      const connections = [];
      for (const srv of servers) {
        if (srv?.status && srv.status !== 'connected') continue;
        const service = detectStorageService(srv?.name ?? srv?.identifier);
        if (!service) continue;
        connections.push({
          connection: srv.name ?? srv.identifier,
          service,
          displayName: srv.displayName ?? srv.name ?? srv.identifier,
        });
      }
      return connections;
    },
    async stage({ agentId: reqAgentId, sourcePath }) {
      let bytes;
      try {
        bytes = await readBoxOrHostBytes({ library, remoteBox, agentId: reqAgentId ?? agentId, agentDir, rawPath: sourcePath });
      } catch (err) {
        return { kind: 'not_found', message: `Could not read ${sourcePath}: ${err?.message ?? err}` };
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const fileName = basename(sourcePath);
      return {
        kind: 'staged',
        fileName,
        sha256,
        sizeBytes: bytes.length,
        async inspectReplaceTarget() {
          return { kind: 'unavailable', message: 'In-place file replacement requires a cloud connector upload endpoint.' };
        },
        async upload({ connection }) {
          return {
            kind: 'unavailable',
            message: `Direct binary upload to ${connection} is not wired on this self-hosted host; use the connector's MCP tools or attach the file directly with SendToUser.`,
          };
        },
      };
    },
    async prepareDownload({ connection }) {
      return {
        kind: 'unavailable',
        message: `Direct binary download from ${connection} is not wired on this self-hosted host; use the connector's MCP tools or WebFetch/Shell instead.`,
      };
    },
  };
}

/** Local `effortTool` port backing SetEffort, persisted per-agent in session.db kv. */
export function createLocalEffortToolPort({ session }) {
  const KV_KEY = 'rokbot.outputEffort';
  const readStored = () => {
    try {
      const raw = session.db?.readKv?.(KV_KEY);
      if (typeof raw === 'string' && EFFORT_LEVELS.includes(raw)) return raw;
    } catch {}
    return 'high';
  };
  let current = readStored();
  return {
    levels: EFFORT_LEVELS,
    topLevel: 'high',
    applies: () => true,
    level: () => current,
    choose: (level) => {
      if (!EFFORT_LEVELS.includes(level)) return;
      current = level;
      try { session.db?.writeKv?.(KV_KEY, level); } catch {}
    },
    record() {},
  };
}

/**
 * Remove a local bot resource (file or skill) when the user taps Remove on a
 * RemoveBotResource confirmation widget.
 */
export async function applyLocalBotResourceRemoval({ dataDir, session, tm, removal }) {
  if (!removal || typeof removal !== 'object') return false;
  if (removal.kind === 'bot-skill' && removal.id) {
    const store = session.skills;
    const removeFn = store?.remove ?? store?.delete;
    const deleted = typeof removeFn === 'function' ? removeFn.call(store, removal.id) : false;
    if (deleted) {
      try { tm.skillCommands?.emitSkills?.(session); } catch {}
      return true;
    }
    return false;
  }
  if (removal.kind === 'bot-file' && removal.name && dataDir) {
    try {
      const filePath = join(dataDir, 'library', session.id, basename(removal.name));
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
        return true;
      }
    } catch {}
  }
  return false;
}

/** Tools excluded on self-hosted RokBot even when a sibling builder emits them. */
export const SELF_HOSTED_HIDDEN_TOOLS = new Set(['DisconnectChannel']);

/**
 * Remove or adjust upstream prompt and tool-description copy that advertises cloud-only
 * tools or services not provided on self-hosted RokBot (native bot email inboxes,
 * CloudAgent, DisconnectChannel, JoinMeeting/UpdateMeeting, unconfigured web/image tools,
 * or absent Cursor-managed skills).
 */
export function sanitizeSelfHostedPromptText(text, { offeredTools, installedSkillIds } = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;

  // 1. Native bot email inboxes do not exist on self-hosted RokBot.
  out = out.replace(/, and this bot's email inboxes, including send and claim/g, '');
  out = out.replace(/, and this bot's email inboxes, including send/g, '');

  // 2. CloudAgent is not used on self-hosted RokBot; strip cloud-agent stop clauses.
  out = out.replace(/, and cancels every cloud agent you launched/g, '');
  out = out.replace(/, and the outcome for each peer and cloud agent/g, ', and the outcome for each peer');
  out = out.replace(/when the result says peers or cloud agents could not be reached/g, 'when the result says peers could not be reached');
  out = out.replace(/, cancel each running cloud agent you launched yourself/g, '');
  out = out.replace(/Spawn local and cloud subagents natively\./g, 'Spawn local subagents natively.');

  // 3. Hidden / cloud-only sibling tools referenced in state-tool descriptions.
  out = out.replace(
    /Skills, profile and settings, picture, and channels have their own tools in the cursor namespace: UpdateSkill, UpdateProfile, UpdateAvatar, DisconnectChannel\./g,
    'Skills, profile and settings, and picture have their own tools in the cursor namespace: UpdateSkill, UpdateProfile, UpdateAvatar.',
  );
  out = out.replace(/, DisconnectChannel/g, '');
  out = out.replace(/, except joining a meeting or saving what to do in one \(JoinMeeting or UpdateMeeting\)/g, '');

  // 4. Conditional tool copy: only advertise WebSearch / WebFetch / GenerateImage when actually offered.
  if (offeredTools instanceof Set && offeredTools.size > 0) {
    const hasWebSearch = offeredTools.has('WebSearch');
    const hasWebFetch = offeredTools.has('WebFetch');
    if (!hasWebSearch && !hasWebFetch) {
      out = out.replace(/Use WebSearch and WebFetch for public information\. /g, '');
    } else if (!hasWebSearch) {
      out = out.replace(/Use WebSearch and WebFetch for public information\./g, 'Use WebFetch for public web pages.');
    } else if (!hasWebFetch) {
      out = out.replace(/Use WebSearch and WebFetch for public information\./g, 'Use WebSearch for public information.');
    }
    if (!offeredTools.has('GenerateImage')) {
      out = out.replace(/ Use GenerateImage only when the user asks you to create a visual, never to depict a real person or thing\./g, '');
    }
  }

  // 5. Cursor-managed built-in skills that are not installed on this self-hosted instance.
  if (installedSkillIds instanceof Set) {
    const missingManaged = ['voice', 'purchases', 'skill-authoring', 'box-desktop', 'routines', 'sign-in'].filter(
      (id) => !installedSkillIds.has(id),
    );
    if (missingManaged.includes('voice')) {
      out = out.replace(
        /skip the text acknowledgement and (?:load|Read) the Cursor-managed `voice` skill(?: with Skill)? before your first send\./g,
        'skip the text acknowledgement and send the voice memo directly.',
      );
    }
    if (missingManaged.includes('purchases')) {
      out = out.replace(
        / Whenever a credit card comes up, (?:load|Read) the Cursor-managed `purchases` skill(?: with Skill)? first and follow it\./g,
        '',
      );
    }
    if (missingManaged.includes('skill-authoring')) {
      out = out.replace(
        /\nBefore saving, rewriting, or deleting a skill, (?:load|Read) the Cursor-managed `skill-authoring` skill(?: with Skill)? first and follow it\./g,
        '',
      );
    }
    if (missingManaged.includes('box-desktop')) {
      out = out.replace(
        /\nBefore your first desktop or browser dispatch in a task, (?:load|Read) the Cursor-managed `box-desktop` skill(?: with Skill)? first and follow it\./g,
        '',
      );
    }
    if (missingManaged.includes('routines')) {
      out = out.replace(
        / Read the Cursor-managed `routines` skill before creating or changing one; it has the full recipe, including every trigger shape\./g,
        '',
      );
    }
    if (missingManaged.includes('sign-in')) {
      out = out.replace(
        /, and you continue with the `sign-in` skill, then dispatch it again\./g,
        ', and you can use RequestUserForm or request_box_help to let the user complete it, then dispatch it again.',
      );
    }
  }

  return out;
}

function sanitizeMessageParts(content, opts) {
  if (typeof content === 'string') return sanitizeSelfHostedPromptText(content, opts);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return { ...part, text: sanitizeSelfHostedPromptText(part.text, opts) };
      }
      return part;
    });
  }
  return content;
}

/** Wrap an inference port so every model call sanitizes unoffered tool/skill references. */
export function wrapInferenceForSelfHosted(inferencePort, { getOfferedTools, getInstalledSkillIds } = {}) {
  if (!inferencePort || typeof inferencePort.createSession !== 'function') return inferencePort;
  const wrapExecutor = (executor) => {
    if (!executor || typeof executor.getMessages !== 'function') return executor;
    const origGetMessages = executor.getMessages.bind(executor);
    executor.getMessages = () => {
      const messages = origGetMessages();
      const offeredTools = new Set(getOfferedTools?.() ?? []);
      const installedSkillIds = getInstalledSkillIds?.();
      const sanitizeOpts = { offeredTools, installedSkillIds };
      return Array.isArray(messages)
        ? messages.map((msg) => {
            if (!msg || typeof msg !== 'object') return msg;
            if (msg.role !== 'system' && msg.role !== 'user') return msg;
            return { ...msg, content: sanitizeMessageParts(msg.content, sanitizeOpts) };
          })
        : messages;
    };
    return executor;
  };
  return {
    ...inferencePort,
    createSession(onRequestId, options) {
      const session = inferencePort.createSession(onRequestId, options);
      if (!session) return session;
      return {
        ...session,
        ...(typeof session.getExecutor === 'function'
          ? { getExecutor: (...args) => wrapExecutor(session.getExecutor(...args)) }
          : {}),
        ...(typeof session.getExecutorWithoutResolvedModelTracking === 'function'
          ? { getExecutorWithoutResolvedModelTracking: (...args) => wrapExecutor(session.getExecutorWithoutResolvedModelTracking(...args)) }
          : {}),
      };
    },
  };
}

function wrapToolDescriptions(tools, getSanitizeOpts) {
  if (!Array.isArray(tools)) return tools;
  for (const tool of tools) {
    if (!tool || typeof tool.descriptionGenerator !== 'function' || tool.descriptionGenerator.__rokbotSanitized) continue;
    const orig = tool.descriptionGenerator.bind(tool);
    const wrapped = (...args) => {
      const desc = orig(...args);
      return typeof desc === 'string' ? sanitizeSelfHostedPromptText(desc, getSanitizeOpts?.() ?? {}) : desc;
    };
    wrapped.__rokbotSanitized = true;
    tool.descriptionGenerator = wrapped;
  }
  return tools;
}

function filterToolSetResult(result, onOfferedTools, getSanitizeOpts, getExtraTools) {
  if (!result) return result;
  // Local tools with no upstream builder slot (the canvas tools) are appended after the
  // upstream ones, unless a builder already offers a tool of the same name.
  const withExtras = (list) => {
    const extras = getExtraTools?.() ?? [];
    if (!Array.isArray(list) || extras.length === 0) return list;
    const names = new Set(list.map((t) => t?.name));
    return [...list, ...extras.filter((t) => !names.has(t.name))];
  };
  const filterList = (list) => (Array.isArray(list) ? withExtras(list.filter((t) => !SELF_HOSTED_HIDDEN_TOOLS.has(t?.name))) : list);
  if (typeof result.transformToolsInPlace === 'function' && typeof result.getAllTools === 'function') {
    result.transformToolsInPlace(filterList);
    const all = result.getAllTools();
    onOfferedTools?.(all.map((t) => t?.name).filter(Boolean));
    wrapToolDescriptions(all, getSanitizeOpts);
    return result;
  }
  if (Array.isArray(result)) {
    const filtered = filterList(result);
    onOfferedTools?.(filtered.map((t) => t?.name).filter(Boolean));
    wrapToolDescriptions(filtered, getSanitizeOpts);
    return filtered;
  }
  if (Array.isArray(result.tools)) {
    const filtered = filterList(result.tools);
    onOfferedTools?.(filtered.map((t) => t?.name).filter(Boolean));
    wrapToolDescriptions(filtered, getSanitizeOpts);
    return { ...result, tools: filtered };
  }
  if (typeof result.getTools === 'function') {
    const origGetTools = result.getTools.bind(result);
    return {
      ...result,
      getTools: (...args) => {
        const filtered = filterList(origGetTools(...args));
        onOfferedTools?.(filtered.map((t) => t?.name).filter(Boolean));
        wrapToolDescriptions(filtered, getSanitizeOpts);
        return filtered;
      },
    };
  }
  return result;
}

/**
 * Wrap `createTurnAgentComposition` so `buildTurnTools` hides cloud-only sibling
 * tools (e.g. DisconnectChannel), appends local-only tools (`getExtraTools`),
 * sanitizes remaining tool descriptions, and records the exact offered tool names.
 */
export function createSelfHostedTurnAgentComposition(library, onOfferedTools, getSanitizeOpts, getExtraTools) {
  const harness = library?.getHarnessRecoveryBindings?.();
  const origCreate = harness?.createTurnAgentComposition;
  if (typeof origCreate !== 'function') return undefined;
  return (compOpts) => {
    const origBuild = compOpts?.buildTurnTools;
    if (typeof origBuild !== 'function') return origCreate(compOpts);
    return origCreate({
      ...compOpts,
      buildTurnTools: (turn, props) => filterToolSetResult(origBuild(turn, props), onOfferedTools, getSanitizeOpts, getExtraTools),
    });
  };
}

