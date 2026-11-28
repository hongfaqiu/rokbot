import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Restart-safe tracking of interrupted turns and background work for 2bb5e41 local runners.
 *
 * 2bb5e41 moved the runner out of the Host, so its Host no longer wires the runner's
 * background-subagent / background-shell settle handlers or the pending-wake markers
 * (the d0a4baa Host did this in wireRunnerLifecycle + PendingWakeRearm). Without them a
 * background task's result never reaches the bot that dispatched it, and a restart loses
 * every in-flight task without a trace. This module restores that contract:
 *
 * - every dispatched subagent / background shell and every in-flight turn is written to
 *   host-pending-wakes.json (the file the d0a4baa Host used; legacy markers stay readable);
 * - settled work wakes the parent bot, and the marker is kept until that wake was delivered;
 * - on startup, work left by the previous Host process wakes its bot with what was
 *   interrupted and where it stopped (read-only media subagents are re-dispatched, side-effecting
 *   ones are reported, never re-run blindly); shells are re-watched; old markers are cleared
 *   after one notice;
 * - a watchdog wakes the bot when a subagent made no progress for a configurable time or
 *   vanished without a result, with dedup and backoff. It also checks subagents it lost its
 *   runner handle for (marker present, no live entry) and subagents that are neither reporting
 *   progress nor settling, so a task that dies silently still reaches its bot;
 * - a subagent stopped outside its parent's own turn (not by the parent's AbortSubagent) wakes
 *   the parent with the reason instead of disappearing.
 *
 * Logging: one line when the watchdog starts, a debug line per pass (ROKBOT_BACKGROUND_DEBUG=1),
 * info lines for stalls / vanished / orphaned work, and a periodic summary while work is tracked.
 */

export const PENDING_WAKE_FILE_NAME = 'host-pending-wakes.json';
const FILE_VERSION = 1;
const KINDS = new Set(['subagent', 'shell', 'turn']);
const SAFE_REDISPATCH_SUBAGENT_TYPES = new Set(['watchVideo', 'videoReview']);
const PROMPT_MAX = 4000;
const TITLE_MAX = 200;
const ACTIVITY_MAX = 600;
const RESULT_MAX = 20_000;
const SKIPPED_TURN_SOURCES = new Set(['automation', 'event']);

function intFrom(value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

/** Host settings via environment (all durations in milliseconds; 0 disables the stall watchdog). */
export function resolveBackgroundRecoveryConfig(env = process.env) {
  const tickMs = intFrom(env.ROKBOT_BACKGROUND_WATCHDOG_TICK_MS, 60_000, { min: 10 });
  return {
    stallMs: intFrom(env.ROKBOT_SUBAGENT_STALL_MS, 15 * 60_000),
    tickMs,
    maxStallNotices: intFrom(env.ROKBOT_SUBAGENT_STALL_MAX_NOTICES, 3, { min: 1 }),
    staleMs: intFrom(env.ROKBOT_PENDING_WAKE_MAX_AGE_MS, 48 * 60 * 60_000, { min: 1 }),
    vanishGraceMs: intFrom(env.ROKBOT_SUBAGENT_VANISH_GRACE_MS, Math.max(2 * tickMs, 5_000)),
    maxDeliveryAttempts: intFrom(env.ROKBOT_PENDING_WAKE_MAX_ATTEMPTS, 10, { min: 1 }),
    retryBaseMs: intFrom(env.ROKBOT_PENDING_WAKE_RETRY_MS, 2_000, { min: 1 }),
    retryMaxMs: intFrom(env.ROKBOT_PENDING_WAKE_RETRY_MAX_MS, 5 * 60_000, { min: 1 }),
    readyPollMs: intFrom(env.ROKBOT_BACKGROUND_READY_POLL_MS, 2_000, { min: 10 }),
    /** Info-level "still watching N tasks" line while anything is tracked (0 disables). */
    summaryEveryMs: intFrom(env.ROKBOT_BACKGROUND_SUMMARY_MS, 30 * 60_000),
    debug: /^(1|true|yes|on)$/i.test(String(env.ROKBOT_BACKGROUND_DEBUG ?? '').trim()),
  };
}

function clip(text, max) {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function pendingWakeKey(agentId, kind, workId) {
  return `${agentId}\u0000${kind}\u0000${workId}`;
}

function keyOf(entry) {
  return pendingWakeKey(entry.agentId, entry.kind, entry.workId);
}

/** Accept current entries and d0a4baa markers ({agentId, kind, workId, markedAtMs, title, ...}). */
export function coercePendingWake(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!nonEmpty(raw.agentId) || !nonEmpty(raw.workId) || !KINDS.has(raw.kind)) return null;
  const entry = { ...raw };
  entry.markedAtMs = finiteOr(raw.markedAtMs, 0);
  const hasPayload = raw.completedPayload !== null && typeof raw.completedPayload === 'object';
  entry.status = hasPayload ? 'settled' : 'running';
  if (!hasPayload) delete entry.completedPayload;
  return entry;
}

export function parsePendingWakeFile(text) {
  return readPendingWakeFile(text).pending;
}

function readPendingWakeFile(text) {
  if (typeof text !== 'string' || text.trim() === '') return { pending: [] };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { pending: [] };
  }
  const list = Array.isArray(value?.pending) ? value.pending : [];
  const byKey = new Map();
  for (const raw of list) {
    const entry = coercePendingWake(raw);
    if (entry) byKey.set(keyOf(entry), entry);
  }
  const heartbeatAtMs = finiteOr(value?.heartbeatAtMs, undefined);
  return { pending: [...byKey.values()], ...(heartbeatAtMs ? { heartbeatAtMs } : {}) };
}

/** Write-through store for host-pending-wakes.json (atomic rename, file removed when empty). */
export class PendingWakeStore {
  constructor(filePath, { log = () => {} } = {}) {
    this.filePath = filePath;
    this.log = log;
    this.entries = new Map();
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {}
    const file = readPendingWakeFile(text);
    for (const entry of file.pending) this.entries.set(keyOf(entry), entry);
    /** Last watchdog pass of the Host that wrote the file: when it was last known alive. */
    this.previousHeartbeatAtMs = file.heartbeatAtMs;
    this.heartbeatAtMs = undefined;
    this.dirty = false;
  }

  list() { return [...this.entries.values()]; }
  get(key) { return this.entries.get(key); }

  upsert(entry, { flush = true } = {}) {
    this.entries.set(keyOf(entry), entry);
    this.dirty = true;
    if (flush) this.flush();
    return entry;
  }

  patch(key, update, { flush = true } = {}) {
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    const next = { ...existing, ...update };
    this.entries.set(key, next);
    this.dirty = true;
    if (flush) this.flush();
    return next;
  }

  remove(key, { flush = true } = {}) {
    if (!this.entries.delete(key)) return false;
    this.dirty = true;
    if (flush) this.flush();
    return true;
  }

  flush() {
    if (!this.dirty) return;
    try {
      if (this.entries.size === 0) {
        rmSync(this.filePath, { force: true });
      } else {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const part = `${this.filePath}.${process.pid}.part`;
        const heartbeat = this.heartbeatAtMs ? { heartbeatAtMs: this.heartbeatAtMs } : {};
        writeFileSync(part, JSON.stringify({ version: FILE_VERSION, ...heartbeat, pending: this.list() }), { mode: 0o600 });
        renameSync(part, this.filePath);
      }
      this.dirty = false;
    } catch (error) {
      this.log(`[rokbot:background] could not persist ${this.filePath}: ${error?.message ?? error}`, 'error');
    }
  }
}

function formatWhen(ms, now) {
  if (!Number.isFinite(ms) || ms <= 0) return 'an unknown time';
  return `${new Date(ms).toISOString()} (${formatDuration(now - ms)} ago)`;
}

export function formatDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(value / 1000))}s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days ${hours % 24} h`;
}

function taskLabel(entry) {
  const type = entry.subagentType ? `${entry.subagentType}, ` : '';
  return `"${clip(entry.title || entry.prompt || entry.workId, TITLE_MAX)}" (${type}task id: ${entry.workId})`;
}

function progressLines(entry, now) {
  const lines = [];
  if (entry.startedAtMs || entry.markedAtMs) lines.push(`- Started: ${formatWhen(entry.startedAtMs || entry.markedAtMs, now)}`);
  if (entry.toolCallCount != null) lines.push(`- Tool calls finished: ${entry.toolCallCount}`);
  if (entry.lastActivity) lines.push(`- Last action: ${clip(entry.lastActivity, ACTIVITY_MAX)}`);
  if (entry.lastProgressAtMs) lines.push(`- Last progress: ${formatWhen(entry.lastProgressAtMs, now)}`);
  return lines;
}

function interruptedAt(entry, fileHeartbeatAtMs) {
  return entry.interruptedAtMs || entry.lastSeenAtMs || fileHeartbeatAtMs || undefined;
}

function promptBlock(entry) {
  if (!entry.prompt) return [];
  return ['- Original task prompt (verbatim, may be truncated):', '"""', clip(entry.prompt, PROMPT_MAX), '"""'];
}

/** Text the bot gets for one notice. Exported for tests. */
export function describeNotice(entry, notice, now) {
  const lines = [];
  switch (notice.type) {
    case 'interrupted': {
      if (entry.kind === 'turn') {
        lines.push(`Your previous turn was cut off by a Host restart before it finished (turn started ${formatWhen(entry.startedAtMs || entry.markedAtMs, now)}; Host went down around ${formatWhen(notice.atMs, now)}).`);
        if (entry.prompt) lines.push(`- It was answering: "${clip(entry.prompt, 1500)}"`);
        lines.push(...progressLines({ ...entry, startedAtMs: undefined, markedAtMs: undefined }, now));
        lines.push('Look at what you already did in this conversation. If the rest is safe to continue (reading, checking, answering), continue now. If it would repeat actions with side effects (deploys, writes, messages, purchases) that may already have partly happened, check the real state first and tell the user where it stopped instead of redoing it blindly.');
        break;
      }
      lines.push(`Background task ${taskLabel(entry)} was interrupted by a Host restart (Host went down around ${formatWhen(notice.atMs, now)}). Its in-process run did not survive and no result will arrive.`);
      lines.push(...progressLines(entry, now));
      lines.push(...promptBlock(entry));
      if (notice.redispatch) {
        lines.push('This task type only reads/analyses and has no side effects, so restart it now: dispatch a new background Task with the same subagent_type and prompt, without asking the user. Mention the restart to the user only if they were waiting on it.');
      } else {
        lines.push('Do not re-run it blindly: it may already have done part of its work. If it is read-only or clearly idempotent, dispatch it again with the prompt above. Otherwise check the real state first (files, deploy status, messages already sent), then either finish the remaining part or tell the user exactly where it stopped and ask how to proceed.');
      }
      break;
    }
    case 'stale': {
      lines.push(`Background task ${taskLabel(entry)}, started ${formatWhen(entry.startedAtMs || entry.markedAtMs, now)}, never reported back: the Host restarted while it ran and its result was lost. It is too old to resume automatically and this is the only notice about it.`);
      lines.push(...progressLines({ ...entry, startedAtMs: undefined, markedAtMs: undefined }, now));
      lines.push(...promptBlock({ ...entry, prompt: entry.prompt ? clip(entry.prompt, 1500) : undefined }));
      lines.push('Do not re-run it automatically. If the user may still be waiting on it, tell them briefly that this task was lost and ask whether to redo it. If it was handled or superseded since, stay silent.');
      break;
    }
    case 'stall': {
      lines.push(`Background task ${taskLabel(entry)} has made no visible progress for ${formatDuration(notice.idleMs)} (running for ${formatDuration(notice.elapsedMs)} in total).`);
      lines.push(...progressLines(entry, now));
      lines.push('Check on it (CheckSubagent), and steer it (MessageSubagent) or stop it if it is stuck. Tell the user the current status of this task in one short message, unless you already told them about this stall. You will not be reminded about it again for a while.');
      break;
    }
    case 'vanished': {
      lines.push(`Background task ${taskLabel(entry)} stopped running without delivering a result (it exited abnormally or was killed).`);
      if (notice.reason) lines.push(`- What the Host saw: ${clip(notice.reason, ACTIVITY_MAX)}`);
      lines.push(...progressLines(entry, now));
      lines.push(...promptBlock(entry));
      lines.push('Find out what it got done (CheckSubagent with its task id), then tell the user what happened and either finish the remaining work or dispatch it again if that is safe.');
      break;
    }
    default:
      lines.push(`Background task ${taskLabel(entry)} needs your attention.`);
  }
  return lines.join('\n');
}

export function buildNoticePrompt(items, now) {
  const count = items.length;
  const intro = count === 1
    ? '[A background task needs attention] The Host is reporting on work you started earlier.'
    : `[Background tasks need attention] The Host is reporting on ${count} pieces of work you started earlier.`;
  return [
    intro,
    '',
    items.map(({ entry, notice }) => describeNotice(entry, notice, now)).join('\n\n'),
    '',
    'The user cannot see this report. When you tell them something, lead with the concrete task, not a bare pronoun. Keep your status current.',
  ].join('\n');
}

export function shellCompletionAsSubagent(completion) {
  const detail = [
    completion.detail,
    completion.outputPath == null ? undefined : `Full output: ${completion.outputPath}`,
  ].filter((line) => typeof line === 'string' && line.length > 0).join('\n');
  let result = detail;
  if (result.length === 0) {
    if (completion.status === 'success') result = 'The command finished successfully.';
    else if (completion.status === 'aborted') result = 'The command was stopped.';
    else result = 'The command failed.';
  }
  return {
    parentAgentId: completion.agentId,
    subagentAgentId: `shell:${completion.shellId}`,
    subagentType: 'shell',
    toolCallId: '',
    title: completion.title ?? `Background command ${completion.shellId}`,
    status: completion.status === 'success' ? 'completed' : 'error',
    result,
    ...(completion.quietOrigin ? { quietOrigin: completion.quietOrigin } : {}),
  };
}

function fallbackCompletionPrompt(completions) {
  const blocks = completions.map((completion) => {
    const verb = completion.status === 'error' ? 'failed' : 'finished';
    return `Background task "${completion.title}" (${completion.subagentType}) ${verb}:\n${completion.result}`;
  });
  return [
    `[A background task just completed] ${completions.length === 1 ? 'A background task you started has finished.' : `${completions.length} background tasks you started have finished.`}`,
    '',
    blocks.join('\n\n'),
    '',
    'Pick the work back up: review the result(s), then either keep going or wrap up. If this result is new and relevant to the user, or the user asked to be told when it finished, tell them with a SendToUser. If it is stale or a duplicate, stay silent.',
  ].join('\n');
}

function clipCompletion(completion) {
  if (typeof completion?.result !== 'string' || completion.result.length <= RESULT_MAX) return completion;
  return { ...completion, result: `${completion.result.slice(0, RESULT_MAX - 1)}…` };
}

/**
 * @param {object} deps
 * @param {string} deps.filePath           host-pending-wakes.json path
 * @param {(agentId: string, prompt: string, info: {source: string}) => Promise<string>} deps.deliver
 *        runs a hidden wake turn for the bot; resolves 'delivered' | 'superseded' | 'paused' | 'cancelled'
 * @param {() => boolean} [deps.isReady]   local turns may run (resume-ownership released, inference ready)
 * @param {(agentId: string) => boolean} [deps.isAgentGone]
 * @param {(agentId: string) => Promise<object|undefined>} [deps.getRunner] runner for re-watching shells
 * @param {(completions: object[], context: object) => string} [deps.buildCompletionPrompt]
 */
export class BackgroundRecovery {
  constructor({
    filePath, deliver, isReady = () => true, isAgentGone = () => false, getRunner, findRunner,
    buildCompletionPrompt, config = resolveBackgroundRecoveryConfig(), now = () => Date.now(),
    log = (line, level) => (level === 'error' ? console.error(line) : console.log(line)),
    setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    this.config = config;
    this.now = now;
    this.log = log;
    this.deliverWake = deliver;
    this.isReady = isReady;
    this.isAgentGone = isAgentGone;
    this.getRunner = getRunner;
    /** Current registry runner of a bot without creating one (undefined when none is open). */
    this.findRunner = findRunner;
    this.buildCompletionPrompt = buildCompletionPrompt;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.bootId = randomUUID();
    this.store = new PendingWakeStore(filePath, { log });
    this.live = new Map();
    this.attached = new WeakSet();
    this.delivering = new Set();
    this.deliverAgain = new Set();
    this.retryTimers = new Map();
    this.notReadyAgents = new Set();
    this.recovered = false;
    this.shuttingDown = false;
    this.disposed = false;
    this.ownRun = new AsyncLocalStorage();
    this.ownPrompts = new Set();
    this.tickTimer = undefined;
    this.readyTimer = undefined;
    /** Turns in flight per runner (user, automation and the Host's own wake turns). */
    this.activeTurns = new WeakMap();
    /** Marker key -> first time a running subagent marker had no runner that knows it. */
    this.orphanSince = new Map();
    this.detachedLogged = new Set();
    this.lastSummaryAtMs = 0;
    this.tickCount = 0;
  }

  debug(line) {
    if (this.config.debug) this.log(line, 'debug');
  }

  /** Begin startup recovery as soon as local turns may run, then run the watchdog. */
  start() {
    if (this.disposed || this.readyTimer || this.tickTimer) return;
    const { tickMs, stallMs, vanishGraceMs } = this.config;
    const previous = this.store.list().filter((entry) => entry.hostBootId !== this.bootId).length;
    this.log(`[rokbot:background] watchdog started (boot ${this.bootId.slice(0, 8)}, check every ${formatDuration(tickMs)}, stall after ${stallMs > 0 ? formatDuration(stallMs) : 'never (disabled)'}, vanish grace ${formatDuration(vanishGraceMs)}, ${previous} record(s) from the previous Host)`);
    let waitingLogged = false;
    const poll = () => {
      this.readyTimer = undefined;
      if (this.disposed || this.shuttingDown) return;
      if (!this.ready()) {
        if (!waitingLogged) {
          waitingLogged = true;
          this.log('[rokbot:background] waiting for local turns to be allowed before startup recovery');
        }
        this.readyTimer = this.unref(this.setTimer(poll, this.config.readyPollMs));
        return;
      }
      void this.recoverPrevious().finally(() => {
        this.log(`[rokbot:background] watchdog running (${this.store.list().length} record(s) tracked)`);
        this.scheduleTick();
      });
    };
    poll();
  }

  ready() {
    try {
      return this.isReady() === true;
    } catch {
      return false;
    }
  }

  unref(timer) {
    timer?.unref?.();
    return timer;
  }

  scheduleTick() {
    if (this.disposed || this.shuttingDown || this.tickTimer) return;
    this.tickTimer = this.unref(this.setTimer(() => {
      this.tickTimer = undefined;
      try {
        this.tick();
      } catch (error) {
        this.log(`[rokbot:background] watchdog tick failed: ${error?.message ?? error}`, 'error');
      }
      this.scheduleTick();
    }, this.config.tickMs));
  }

  /** Wire one runner: settle handlers, pending-wake markers, prompt capture and turn markers. */
  attachRunner(runner, agentId) {
    if (!runner || typeof runner !== 'object' || this.attached.has(runner)) return runner;
    this.attached.add(runner);
    runner.setPendingWakeArmedHandler?.((event) => this.onArmed(runner, event));
    runner.setPendingWakeDisarmedHandler?.((event) => this.onDisarmed(event, runner));
    runner.setBackgroundSubagentHandler?.((completion) => this.onSubagentSettled(completion));
    runner.setBackgroundShellHandler?.((completion) => this.onShellSettled(completion));

    const subagents = runner.subagents;
    if (subagents && typeof subagents.dispatchBackgroundSubagent === 'function' && !subagents.dispatchBackgroundSubagent.__rokbotTracked) {
      const dispatch = subagents.dispatchBackgroundSubagent;
      const tracked = (params, ...rest) => {
        const result = dispatch.call(subagents, params, ...rest);
        this.noteDispatch(runner, agentId, params);
        return result;
      };
      tracked.__rokbotTracked = true;
      subagents.dispatchBackgroundSubagent = tracked;
    }

    if (typeof runner.run === 'function' && !runner.run.__rokbotTracked) {
      const run = runner.run;
      const tracked = async (prompt, options, ...rest) => {
        const key = this.beginTurn(runner, agentId, prompt, options);
        this.activeTurns.set(runner, (this.activeTurns.get(runner) ?? 0) + 1);
        let result;
        try {
          result = await run.call(runner, prompt, options, ...rest);
          return result;
        } finally {
          const left = (this.activeTurns.get(runner) ?? 1) - 1;
          if (left > 0) this.activeTurns.set(runner, left); else this.activeTurns.delete(runner);
          this.endTurn(key, result);
        }
      };
      tracked.__rokbotTracked = true;
      runner.run = tracked;
    }
    return runner;
  }

  onArmed(runner, event) {
    if (!event || (event.kind !== 'subagent' && event.kind !== 'shell')) return;
    const agentId = nonEmpty(event.parentAgentId);
    const workId = nonEmpty(event.workId);
    if (!agentId || !workId) return;
    const key = pendingWakeKey(agentId, event.kind, workId);
    const now = this.now();
    const existing = this.store.get(key);
    // A resumed subagent re-arms the id it settled under: drop the old result and retry state so the
    // delivery of that result does not remove the new run's marker, and a restart does not replay it.
    const {
      completedPayload: _payload, settledAtMs: _settled, deliveryAttempts: _attempts, nextAttemptAtMs: _next,
      stallNotices: _stalls, nextStallNoticeAtMs: _nextStall, lastStallNoticeAtMs: _lastStall, ...kept
    } = existing ?? {};
    this.store.upsert({
      ...kept,
      armId: randomUUID(),
      agentId,
      kind: event.kind,
      workId,
      markedAtMs: existing?.markedAtMs || now,
      startedAtMs: existing?.startedAtMs || now,
      lastProgressAtMs: existing?.hostBootId === this.bootId ? existing.lastProgressAtMs ?? now : now,
      title: clip(event.title ?? existing?.title ?? workId, TITLE_MAX),
      ...(event.subagentType ? { subagentType: event.subagentType } : {}),
      ...(event.automationRunUuid ? { automationRunUuid: event.automationRunUuid } : {}),
      ...(event.quietOrigin ? { quietOrigin: event.quietOrigin } : {}),
      status: 'running',
      hostBootId: this.bootId,
      lastSeenAtMs: now,
      interruptedAtMs: undefined,
      interruptedReason: undefined,
      pendingNotice: undefined,
    });
    this.live.set(key, { runner, missingSinceMs: undefined });
    this.orphanSince.delete(key);
    this.detachedLogged.delete(key);
    this.debug(`[rokbot:background] tracking ${event.kind} ${workId} for ${agentId}${existing ? ' (re-armed)' : ''}`);
  }

  noteDispatch(runner, agentId, params) {
    const workId = nonEmpty(params?.subagentAgentId);
    const parentAgentId = nonEmpty(runner.getConversationId?.()) ?? agentId;
    if (!workId || !parentAgentId) return;
    const key = pendingWakeKey(parentAgentId, 'subagent', workId);
    if (!this.store.get(key)) return;
    this.store.patch(key, {
      ...(nonEmpty(params.prompt) ? { prompt: clip(params.prompt, PROMPT_MAX) } : {}),
      ...(nonEmpty(params.subagentType) ? { subagentType: params.subagentType } : {}),
      ...(nonEmpty(params.toolCallId) ? { toolCallId: params.toolCallId } : {}),
      ...(params.resume === true ? { resumed: true } : {}),
    });
  }

  onDisarmed(event, runner) {
    if (!event) return;
    const key = pendingWakeKey(event.parentAgentId, event.kind, event.workId);
    const entry = this.store.get(key);
    this.live.delete(key);
    this.orphanSince.delete(key);
    // The parent's own AbortSubagent runs inside one of its turns: it already knows. A stop with no
    // parent turn in flight came from elsewhere, so the parent is told instead of losing the task.
    const parentTurnActive = runner !== undefined && (this.activeTurns.get(runner) ?? 0) > 0;
    if (!entry || entry.status !== 'running' || entry.kind !== 'subagent' || parentTurnActive || runner === undefined || this.shuttingDown) {
      this.store.remove(key);
      if (entry) this.log(`[rokbot:background] ${event.kind} ${event.workId} of ${event.parentAgentId} was stopped by its parent; no wake`);
      return;
    }
    this.log(`[rokbot:background] ${event.kind} ${event.workId} of ${event.parentAgentId} was stopped outside its parent's turn; waking the parent`);
    this.settle(key, {
      parentAgentId: event.parentAgentId,
      subagentAgentId: event.workId,
      subagentType: entry.subagentType ?? 'unknown',
      toolCallId: entry.toolCallId ?? '',
      title: entry.title ?? event.workId,
      status: 'error',
      result: 'The background task was stopped before it finished, but not by you (no turn of yours was running when it was stopped). No result will arrive. Check what it already did before re-running it.',
    }, { kind: 'subagent', workId: event.workId });
  }

  onSubagentSettled(completion) {
    if (!completion?.parentAgentId || !completion?.subagentAgentId) return;
    const key = pendingWakeKey(completion.parentAgentId, 'subagent', completion.subagentAgentId);
    if (this.shuttingDown && completion.status !== 'completed') {
      this.markInterrupted(key, 'host-stop');
      return;
    }
    this.live.delete(key);
    this.orphanSince.delete(key);
    if (completion.automationRunUuid != null && completion.parentWakeRequested !== true) {
      // The automation runtime awaits this result itself; it is not a parent wake.
      this.store.remove(key);
      return;
    }
    this.log(`[rokbot:background] subagent ${completion.subagentAgentId} of ${completion.parentAgentId} settled (${completion.status}); waking the parent`);
    this.settle(key, completion, { kind: 'subagent', workId: completion.subagentAgentId });
  }

  onShellSettled(completion) {
    if (!completion?.agentId || !completion?.shellId) return;
    const key = pendingWakeKey(completion.agentId, 'shell', completion.shellId);
    if (this.shuttingDown && completion.status !== 'success') {
      this.markInterrupted(key, 'host-stop');
      return;
    }
    this.live.delete(key);
    this.settle(key, shellCompletionAsSubagent(completion), { kind: 'shell', workId: completion.shellId });
  }

  settle(key, completion, { kind, workId }) {
    const agentId = completion.parentAgentId;
    const existing = this.store.get(key);
    this.store.upsert({
      ...(existing ?? { markedAtMs: this.now(), title: clip(completion.title, TITLE_MAX) }),
      agentId,
      kind,
      workId,
      status: 'settled',
      hostBootId: this.bootId,
      settledAtMs: this.now(),
      completedPayload: clipCompletion(completion),
      pendingNotice: undefined,
    });
    if (this.isAgentGone(agentId)) {
      this.store.remove(key);
      return;
    }
    this.queueDelivery(agentId);
  }

  markInterrupted(key, reason) {
    const existing = this.store.get(key);
    if (!existing) return;
    const now = this.now();
    this.store.patch(key, {
      interruptedAtMs: existing.interruptedAtMs ?? now,
      interruptedReason: existing.interruptedReason ?? reason,
      lastSeenAtMs: now,
    });
  }

  beginTurn(runner, agentId, prompt, options = {}) {
    if (this.ownRun.getStore() === true || this.ownPrompts.has(prompt) || this.shuttingDown) return undefined;
    if (SKIPPED_TURN_SOURCES.has(options?.requestSource)) return undefined;
    if (!nonEmpty(agentId)) return undefined;
    const now = this.now();
    const workId = `turn-${randomUUID()}`;
    const entry = this.store.upsert({
      agentId,
      kind: 'turn',
      workId,
      markedAtMs: now,
      startedAtMs: now,
      title: clip(prompt, TITLE_MAX),
      prompt: clip(prompt, 1500),
      requestSource: options?.requestSource ?? 'turn',
      ...(options?.hidden ? { hidden: true } : {}),
      status: 'running',
      hostBootId: this.bootId,
      lastSeenAtMs: now,
    });
    const key = keyOf(entry);
    this.live.set(key, { runner, missingSinceMs: undefined });
    return key;
  }

  endTurn(key, result) {
    if (!key) return;
    this.live.delete(key);
    if (this.shuttingDown) {
      this.markInterrupted(key, 'host-stop');
      return;
    }
    if (result?.pausedForUpgrade === true) {
      this.markInterrupted(key, 'paused-for-upgrade');
      return;
    }
    this.store.remove(key);
  }

  /** Sweep work the previous Host process left behind. */
  async recoverPrevious() {
    if (this.recovered) return;
    this.recovered = true;
    const now = this.now();
    const agents = new Set();
    const shellRewatches = [];
    for (const entry of this.store.list()) {
      if (entry.hostBootId === this.bootId) continue;
      const key = keyOf(entry);
      if (this.isAgentGone(entry.agentId)) {
        this.log(`[rokbot:background] dropping ${entry.kind} ${entry.workId}: bot ${entry.agentId} is gone`);
        this.store.remove(key, { flush: false });
        continue;
      }
      const atMs = interruptedAt(entry, this.store.previousHeartbeatAtMs);
      if (entry.status === 'settled') {
        this.store.patch(key, { hostBootId: this.bootId }, { flush: false });
      } else if (entry.kind === 'subagent' && now - (entry.markedAtMs || 0) > this.config.staleMs) {
        this.store.patch(key, { hostBootId: this.bootId, pendingNotice: { type: 'stale', atMs } }, { flush: false });
      } else if (entry.kind === 'shell' && typeof this.getRunner === 'function') {
        shellRewatches.push(entry);
        continue;
      } else {
        const redispatch = entry.kind === 'subagent' && SAFE_REDISPATCH_SUBAGENT_TYPES.has(entry.subagentType) && !!entry.prompt;
        this.store.patch(key, {
          hostBootId: this.bootId,
          pendingNotice: { type: 'interrupted', atMs, ...(redispatch ? { redispatch: true } : {}) },
        }, { flush: false });
      }
      agents.add(entry.agentId);
    }
    this.store.flush();
    for (const entry of shellRewatches) {
      if (await this.rewatchShell(entry)) continue;
      this.store.patch(keyOf(entry), {
        hostBootId: this.bootId,
        pendingNotice: { type: 'interrupted', atMs: interruptedAt(entry, this.store.previousHeartbeatAtMs) },
      });
      agents.add(entry.agentId);
    }
    if (agents.size > 0) this.log(`[rokbot:background] recovering interrupted work for ${agents.size} bot(s)`);
    for (const agentId of agents) this.queueDelivery(agentId);
  }

  async rewatchShell(entry) {
    try {
      const runner = await this.getRunner(entry.agentId);
      if (typeof runner?.watchBackgroundShell !== 'function') return false;
      this.attachRunner(runner, entry.agentId);
      runner.watchBackgroundShell(entry.workId, { ...(entry.title ? { title: entry.title } : {}) });
      const current = this.store.get(keyOf(entry));
      if (current?.hostBootId !== this.bootId) {
        this.store.patch(keyOf(entry), { hostBootId: this.bootId });
        this.live.set(keyOf(entry), { runner, missingSinceMs: undefined });
      }
      this.log(`[rokbot:background] re-watching background shell ${entry.workId} for ${entry.agentId}`);
      return true;
    } catch (error) {
      this.log(`[rokbot:background] could not re-watch shell ${entry.workId}: ${error?.message ?? error}`, 'error');
      return false;
    }
  }

  /** One watchdog pass: record progress, detect stalls, vanished and orphaned subagents. */
  tick({ deliver = true } = {}) {
    if (this.disposed) return;
    const now = this.now();
    const ready = deliver && this.ready();
    const notify = new Set();
    const seen = [];
    this.tickCount++;
    if (deliver) for (const agentId of this.adoptOrphans(now)) notify.add(agentId);
    for (const [key, live] of this.live) {
      const entry = this.store.get(key);
      if (!entry) {
        this.live.delete(key);
        continue;
      }
      if (entry.kind === 'turn') {
        this.recordTurnProgress(key, entry, live.runner, now);
        continue;
      }
      if (entry.kind !== 'subagent' || entry.status !== 'running') {
        this.store.patch(key, { lastSeenAtMs: now }, { flush: false });
        continue;
      }
      let info = null;
      try {
        info = live.runner.getRunningSubagent?.(entry.workId) ?? null;
      } catch {}
      if (!info) {
        let running = false;
        try {
          running = live.runner.subagents?.isRunning?.(entry.workId) === true;
        } catch {}
        let held = false;
        try {
          held = live.runner.subagents?.heldSubagentIds?.()?.includes?.(entry.workId) === true;
        } catch {}
        if (!deliver) continue;
        if (!running && !held) {
          live.missingSinceMs ??= now;
          seen.push(`${entry.workId.slice(-8)}:missing ${formatDuration(now - live.missingSinceMs)}`);
          if (now - live.missingSinceMs >= this.config.vanishGraceMs) {
            this.live.delete(key);
            this.store.patch(key, { pendingNotice: { type: 'vanished', atMs: now, reason: 'its runner no longer has it running and no result was delivered' } }, { flush: false });
            this.log(`[rokbot:background] subagent ${entry.workId} of ${entry.agentId} vanished without a result (missing for ${formatDuration(now - live.missingSinceMs)}); waking the parent`);
            notify.add(entry.agentId);
          }
          continue;
        }
        // Still registered (running, or its result is held) but reporting nothing: no heartbeat and no
        // settle. It gets the same stall clock as a silent running subagent instead of being skipped.
        live.missingSinceMs = undefined;
        this.store.patch(key, { lastSeenAtMs: now }, { flush: false });
        seen.push(`${entry.workId.slice(-8)}:${held ? 'held' : 'no-info'} idle ${formatDuration(now - (entry.lastProgressAtMs || entry.startedAtMs || now))}`);
        if (this.maybeStall(key, this.store.get(key), now, ready, undefined)) notify.add(entry.agentId);
        continue;
      }
      live.missingSinceMs = undefined;
      this.noteDetached(key, entry, live.runner);
      const activity = Array.isArray(info.recentActivity) ? info.recentActivity : [];
      const lastActivity = activity.length > 0 ? clip(activity[activity.length - 1], ACTIVITY_MAX) : entry.lastActivity;
      const signature = `${info.toolCallCount ?? 0}|${activity.length}|${lastActivity ?? ''}`;
      const update = { lastSeenAtMs: now, ...(info.toolCallCount != null ? { toolCallCount: info.toolCallCount } : {}) };
      if (lastActivity) update.lastActivity = lastActivity;
      if (signature !== entry.progressSignature) {
        Object.assign(update, { progressSignature: signature, lastProgressAtMs: now, stallNotices: 0, nextStallNoticeAtMs: undefined });
      }
      const current = this.store.patch(key, update, { flush: false });
      seen.push(`${entry.workId.slice(-8)}:${current.toolCallCount ?? 0} calls idle ${formatDuration(now - (current.lastProgressAtMs || now))}`);
      if (this.maybeStall(key, current, now, ready, info.elapsedMs)) notify.add(entry.agentId);
    }
    if (this.store.entries.size > 0) {
      this.store.heartbeatAtMs = now;
      this.store.dirty = true;
    }
    this.store.flush();
    if (deliver) {
      this.debug(`[rokbot:background] watchdog pass ${this.tickCount}: ${this.store.entries.size} record(s), ${this.live.size} live${seen.length ? ` [${seen.join(', ')}]` : ''}${ready ? '' : ' (deliveries paused: not ready)'}`);
      this.maybeSummary(now);
    }
    if (!ready) return;
    for (const agentId of this.notReadyAgents) notify.add(agentId);
    this.notReadyAgents.clear();
    // Safety net: anything still owed to a bot (e.g. a retry that found nothing due yet) is retried here.
    for (const entry of this.store.list()) {
      if (entry.hostBootId !== this.bootId) continue;
      if (!(entry.status === 'settled' || entry.pendingNotice)) continue;
      if (entry.nextAttemptAtMs && entry.nextAttemptAtMs > now) continue;
      if (this.retryTimers.has(entry.agentId)) continue;
      notify.add(entry.agentId);
    }
    for (const agentId of notify) this.queueDelivery(agentId);
  }

  /** Arm a stall notice when a running subagent has been idle for the stall window. */
  maybeStall(key, current, now, ready, elapsedMs) {
    if (!current || !ready || this.config.stallMs <= 0 || current.pendingNotice) return false;
    const idleMs = now - (current.lastProgressAtMs || current.startedAtMs || now);
    const notices = current.stallNotices ?? 0;
    if (idleMs < this.config.stallMs || notices >= this.config.maxStallNotices) return false;
    if (current.nextStallNoticeAtMs && now < current.nextStallNoticeAtMs) return false;
    this.store.patch(key, {
      stallNotices: notices + 1,
      lastStallNoticeAtMs: now,
      // Backoff: the next reminder for the same stall waits 2x, 4x... the stall window.
      nextStallNoticeAtMs: now + this.config.stallMs * 2 ** (notices + 1),
      pendingNotice: { type: 'stall', idleMs, elapsedMs: finiteOr(elapsedMs, now - (current.startedAtMs || now)), atMs: now },
    }, { flush: false });
    this.log(`[rokbot:background] subagent ${current.workId} of ${current.agentId} stalled: no progress for ${formatDuration(idleMs)} (notice ${notices + 1}/${this.config.maxStallNotices}, last action: ${clip(current.lastActivity ?? 'none', 120)}); waking the parent`);
    return true;
  }

  /**
   * Running subagent markers of this boot that no live runner handle covers (the handle was lost, or
   * the marker was re-armed elsewhere): look the subagent up on the bot's current runner; if no
   * runner knows it for the vanish grace, it died without a result.
   */
  adoptOrphans(now) {
    const orphaned = new Set();
    for (const entry of this.store.list()) {
      if (entry.kind !== 'subagent' || entry.status !== 'running' || entry.hostBootId !== this.bootId || entry.pendingNotice) continue;
      const key = keyOf(entry);
      if (this.live.has(key)) {
        this.orphanSince.delete(key);
        continue;
      }
      let runner;
      try {
        runner = this.findRunner?.(entry.agentId);
      } catch {}
      let known = false;
      try {
        known = !!runner && (runner.getRunningSubagent?.(entry.workId) != null
          || runner.subagents?.isRunning?.(entry.workId) === true
          || runner.subagents?.heldSubagentIds?.()?.includes?.(entry.workId) === true);
      } catch {}
      if (known) {
        this.attachRunner(runner, entry.agentId);
        this.live.set(key, { runner, missingSinceMs: undefined });
        this.orphanSince.delete(key);
        this.log(`[rokbot:background] re-attached subagent ${entry.workId} of ${entry.agentId} to its bot's current runner`);
        continue;
      }
      const since = this.orphanSince.get(key) ?? now;
      this.orphanSince.set(key, since);
      if (now - since < this.config.vanishGraceMs) continue;
      this.orphanSince.delete(key);
      this.store.patch(key, { pendingNotice: { type: 'vanished', atMs: now, reason: 'no runner of this Host has it running any more and no result was delivered' } }, { flush: false });
      this.log(`[rokbot:background] subagent ${entry.workId} of ${entry.agentId} has no runner and no result (orphaned for ${formatDuration(now - since)}); waking the parent`);
      orphaned.add(entry.agentId);
    }
    return orphaned;
  }

  /** Log once when a subagent keeps running on a runner its bot no longer uses (CheckSubagent cannot see it). */
  noteDetached(key, entry, runner) {
    if (this.detachedLogged.has(key) || typeof this.findRunner !== 'function') return;
    let current;
    try {
      current = this.findRunner(entry.agentId);
    } catch {
      return;
    }
    if (!current || current === runner) return;
    this.detachedLogged.add(key);
    this.log(`[rokbot:background] subagent ${entry.workId} of ${entry.agentId} still runs on a previous runner of its bot (CheckSubagent from new turns cannot see it); its result will still wake the bot`);
  }

  maybeSummary(now) {
    if (this.config.summaryEveryMs <= 0 || this.store.entries.size === 0) return;
    if (this.lastSummaryAtMs && now - this.lastSummaryAtMs < this.config.summaryEveryMs) return;
    this.lastSummaryAtMs = now;
    const counts = {};
    for (const entry of this.store.list()) counts[`${entry.kind}:${entry.status}`] = (counts[`${entry.kind}:${entry.status}`] ?? 0) + 1;
    this.log(`[rokbot:background] watchdog alive: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} (${this.live.size} live)`);
  }

  recordTurnProgress(key, entry, runner, now) {
    const update = { lastSeenAtMs: now };
    try {
      const activity = runner.getActivitySnapshot?.();
      if (Array.isArray(activity) && activity.length > 0) update.lastActivity = clip(activity[activity.length - 1], ACTIVITY_MAX);
      const count = runner.getObservedToolCallCount?.();
      if (typeof count === 'number') update.toolCallCount = count;
    } catch {}
    if (update.lastActivity && update.lastActivity !== entry.lastActivity) update.lastProgressAtMs = now;
    this.store.patch(key, update, { flush: false });
  }

  queueDelivery(agentId, delayMs = 0) {
    if (this.disposed || this.shuttingDown || !agentId) return;
    if (delayMs > 0) {
      if (this.retryTimers.has(agentId)) return;
      this.retryTimers.set(agentId, this.unref(this.setTimer(() => {
        this.retryTimers.delete(agentId);
        this.queueDelivery(agentId);
      }, delayMs)));
      return;
    }
    if (this.delivering.has(agentId)) {
      this.deliverAgain.add(agentId);
      return;
    }
    void this.deliverFor(agentId);
  }

  /**
   * True while this bot has background work that will still wake it: a tracked subagent or shell
   * that is running, or settled and not yet delivered, or a wake being delivered right now.
   * In-flight turn markers do not count.
   */
  hasPendingWork(agentId) {
    if (this.delivering.has(agentId)) return true;
    return this.store.list().some((entry) => entry.agentId === agentId && entry.kind !== 'turn');
  }

  pendingFor(agentId) {
    const completions = [];
    const notices = [];
    const now = this.now();
    for (const entry of this.store.list()) {
      if (entry.agentId !== agentId) continue;
      if (entry.nextAttemptAtMs && entry.nextAttemptAtMs > now + 50) continue;
      if (entry.status === 'settled' && entry.completedPayload) completions.push(entry);
      else if (entry.pendingNotice) notices.push(entry);
    }
    return { completions, notices };
  }

  async deliverFor(agentId) {
    if (this.disposed || this.shuttingDown || this.delivering.has(agentId)) return;
    if (this.isAgentGone(agentId)) {
      for (const entry of this.store.list()) if (entry.agentId === agentId) this.store.remove(keyOf(entry), { flush: false });
      this.store.flush();
      return;
    }
    if (!this.ready()) {
      this.notReadyAgents.add(agentId);
      return;
    }
    this.delivering.add(agentId);
    try {
      const { completions, notices } = this.pendingFor(agentId);
      if (completions.length > 0) {
        const payloads = completions.map((entry) => entry.completedPayload);
        await this.attemptDelivery(agentId, completions, this.completionPrompt(payloads), 'background-completion');
      }
      if (notices.length > 0 && !this.shuttingDown && !this.disposed) {
        const prompt = buildNoticePrompt(notices.map((entry) => ({ entry, notice: entry.pendingNotice })), this.now());
        await this.attemptDelivery(agentId, notices, prompt, `background-${notices[0].pendingNotice.type}`);
      }
    } finally {
      this.delivering.delete(agentId);
    }
    if (this.deliverAgain.delete(agentId)) this.queueDelivery(agentId);
  }

  completionPrompt(completions) {
    let prompt;
    try {
      prompt = typeof this.buildCompletionPrompt === 'function' ? this.buildCompletionPrompt(completions, {}) : undefined;
    } catch (error) {
      this.log(`[rokbot:background] completion prompt builder failed: ${error?.message ?? error}`, 'error');
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') prompt = fallbackCompletionPrompt(completions);
    const ids = completions
      .filter((completion) => completion.subagentType !== 'shell')
      .map((completion) => `- "${clip(completion.title, TITLE_MAX)}": ${completion.subagentAgentId}`);
    return ids.length > 0 ? `${prompt}\n\nTask ids (for CheckSubagent or Task resume):\n${ids.join('\n')}` : prompt;
  }

  async attemptDelivery(agentId, entries, prompt, source) {
    let outcome;
    let failure;
    this.ownPrompts.add(prompt);
    try {
      outcome = await this.ownRun.run(true, () => this.deliverWake(agentId, prompt, { source }));
    } catch (error) {
      failure = error;
      outcome = 'error';
    } finally {
      this.ownPrompts.delete(prompt);
    }
    if (outcome === 'delivered') {
      for (const entry of entries) {
        const key = keyOf(entry);
        // Re-armed during the wake (e.g. the bot resumed this task id): the marker now belongs to the new run.
        if (this.reArmed(entry)) continue;
        if (entry.status === 'settled' || entry.pendingNotice?.type !== 'stall') {
          this.live.delete(key);
          this.store.remove(key, { flush: false });
        } else {
          this.store.patch(key, { pendingNotice: undefined, deliveryAttempts: 0, nextAttemptAtMs: undefined }, { flush: false });
        }
      }
      this.store.flush();
      this.log(`[rokbot:background] woke ${agentId} (${source}, ${entries.length} item(s))`);
      return true;
    }
    if (this.shuttingDown || this.disposed) return false;
    if (!this.ready()) {
      this.notReadyAgents.add(agentId);
      return false;
    }
    entries = entries.filter((entry) => !this.reArmed(entry));
    if (entries.length === 0) return false;
    const attempts = Math.max(...entries.map((entry) => entry.deliveryAttempts ?? 0)) + 1;
    if (attempts >= this.config.maxDeliveryAttempts) {
      for (const entry of entries) {
        const key = keyOf(entry);
        if (entry.pendingNotice?.type === 'stall') this.store.patch(key, { pendingNotice: undefined, deliveryAttempts: 0 }, { flush: false });
        else this.store.remove(key, { flush: false });
      }
      this.store.flush();
      this.log(`[rokbot:background] gave up waking ${agentId} after ${attempts} attempts (${source}): ${failure?.message ?? outcome}`, 'error');
      return false;
    }
    const delayMs = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** (attempts - 1));
    for (const entry of entries) {
      this.store.patch(keyOf(entry), { deliveryAttempts: attempts, nextAttemptAtMs: this.now() + delayMs }, { flush: false });
    }
    this.store.flush();
    this.log(`[rokbot:background] wake for ${agentId} not delivered (${failure?.message ?? outcome}); retry ${attempts} in ${delayMs} ms`, 'error');
    this.queueDelivery(agentId, delayMs);
    return false;
  }

  reArmed(entry) {
    const current = this.store.get(keyOf(entry));
    return !!current && current.status === 'running' && current.armId !== entry.armId;
  }

  /** Called before the Host stops: keep in-flight work and its last progress for the next start. */
  beginShutdown(reason = 'host-stop') {
    if (this.shuttingDown) return;
    try {
      this.tick({ deliver: false });
    } catch {}
    this.shuttingDown = true;
    const now = this.now();
    for (const entry of this.store.list()) {
      if (entry.hostBootId !== this.bootId || entry.status !== 'running') continue;
      this.store.patch(keyOf(entry), { interruptedAtMs: now, interruptedReason: reason, lastSeenAtMs: now }, { flush: false });
    }
    this.store.flush();
    this.stopTimers();
  }

  stopTimers() {
    if (this.tickTimer) this.clearTimer(this.tickTimer);
    if (this.readyTimer) this.clearTimer(this.readyTimer);
    for (const timer of this.retryTimers.values()) this.clearTimer(timer);
    this.tickTimer = undefined;
    this.readyTimer = undefined;
    this.retryTimers.clear();
  }

  dispose() {
    this.beginShutdown('host-stop');
    this.disposed = true;
    this.stopTimers();
  }
}

export function pendingWakeFilePath(sandRoot) {
  return join(sandRoot, PENDING_WAKE_FILE_NAME);
}
