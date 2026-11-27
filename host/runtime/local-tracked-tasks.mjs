import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TASK_STATUSES = ['todo', 'in_progress', 'for_review', 'done', 'canceled'];
const OPEN_STATUSES = new Set(['todo', 'in_progress', 'for_review']);
const MAX_TASKS_PER_CREATE = 20;

function defaultStoreState() {
  return { version: 1, nextSeq: 1, tags: [], tasks: [] };
}

function loadStoreState(filePath) {
  if (!existsSync(filePath)) return defaultStoreState();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaultStoreState();
    return {
      version: 1,
      nextSeq: Number.isInteger(parsed.nextSeq) && parsed.nextSeq > 0 ? parsed.nextSeq : 1,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return defaultStoreState();
  }
}

function saveStoreState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function normalizeStatus(raw, fallback = 'todo') {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return TASK_STATUSES.includes(s) ? s : fallback;
}

function formatTaskLine(task) {
  const tags = Array.isArray(task.tags) && task.tags.length > 0 ? ` [${task.tags.join(', ')}]` : '';
  const subs = Array.isArray(task.subagentIds) && task.subagentIds.length > 0 ? ` (subagents: ${task.subagentIds.join(', ')})` : '';
  return `- ${task.key} [${task.status}] ${task.title}${tags}${subs}${task.notes ? ` — ${task.notes}` : ''}`;
}

async function readArgsJson(argsStream) {
  let raw = '';
  for await (const chunk of argsStream) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function makeTextTool({ name, toolIdentifier, description, parameters, contextType, handler }) {
  return {
    name,
    toolIdentifier,
    ...(contextType ? { contextType } : {}),
    descriptionGenerator: () => description,
    parameters: { jsonSchema: parameters },
    async execute(_ctx, _interactionHandler, argsStream) {
      let args;
      try {
        args = await readArgsJson(argsStream);
      } catch (error) {
        return { content: [{ type: 'text', text: `Invalid JSON arguments for ${name}: ${error?.message ?? error}` }] };
      }
      try {
        const text = await handler(args ?? {});
        return { content: [{ type: 'text', text: String(text) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in ${name}: ${error?.message ?? error}` }] };
      }
    },
  };
}

/**
 * Self-hosted local tracked-tasks store for 97658ad (`CreateTrackedTasks`, `ListTrackedTasks`,
 * `UpdateTrackedTasks`, `UpdateTrackedTaskTags`, plus `task_ids` handoff on `Task`).
 */
export function createLocalTrackedTasks({ agentDir } = {}) {
  if (!agentDir) return undefined;
  const storePath = join(agentDir, 'tracked-tasks.json');

  const read = async (key) => {
    const state = loadStoreState(storePath);
    const normalized = String(key ?? '').trim().toUpperCase();
    return state.tasks.find((t) => t.key.toUpperCase() === normalized);
  };

  const linkSubagent = async ({ keys = [], subagentId, callId } = {}) => {
    const state = loadStoreState(storePath);
    const linked = [];
    const now = new Date().toISOString();
    for (const rawKey of keys) {
      const normalized = String(rawKey ?? '').trim().toUpperCase();
      const task = state.tasks.find((t) => t.key.toUpperCase() === normalized);
      if (!task) continue;
      if (task.status === 'canceled') {
        linked.push({ key: task.key, title: task.title, staysCanceled: true });
        continue;
      }
      const reopened = task.status === 'done';
      task.status = 'in_progress';
      task.updatedAt = now;
      if (!Array.isArray(task.subagentIds)) task.subagentIds = [];
      if (subagentId && !task.subagentIds.includes(subagentId)) task.subagentIds.push(subagentId);
      if (callId) task.lastCallId = callId;
      linked.push({ key: task.key, title: task.title, reopened });
    }
    saveStoreState(storePath, state);
    return linked;
  };

  const createTool = makeTextTool({
    name: 'CreateTrackedTasks',
    toolIdentifier: 'create_tracked_tasks',
    description: 'Create one or more tracked tasks for this conversation and return their keys (e.g. RB-1).',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'List of tasks to create.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short task title.' },
              status: { type: 'string', enum: TASK_STATUSES, description: 'Initial status (default: todo).' },
              notes: { type: 'string', description: 'Optional task notes or details.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag IDs.' },
              messages: { type: 'array', items: { type: 'string' }, description: 'Optional triggering message IDs.' },
            },
            required: ['title'],
          },
        },
        title: { type: 'string', description: 'Shorthand single-task title when tasks array is omitted.' },
        notes: { type: 'string', description: 'Optional notes for single-task shorthand.' },
        messages: { type: 'array', items: { type: 'string' }, description: 'Optional triggering message IDs.' },
      },
    },
    handler: (args) => {
      const state = loadStoreState(storePath);
      const rawList = Array.isArray(args.tasks) && args.tasks.length > 0
        ? args.tasks
        : (typeof args.title === 'string' && args.title.trim() ? [args] : []);
      if (rawList.length === 0) return 'No tasks provided. Pass `tasks: [{ title: "..." }]`.';
      if (rawList.length > MAX_TASKS_PER_CREATE) return `Too many tasks in one call (max ${MAX_TASKS_PER_CREATE}).`;
      const created = [];
      const now = new Date().toISOString();
      for (const item of rawList) {
        const title = String(item?.title ?? '').trim();
        if (!title) continue;
        const key = `RB-${state.nextSeq++}`;
        const task = {
          key,
          title,
          status: normalizeStatus(item.status, 'todo'),
          notes: typeof item.notes === 'string' ? item.notes.trim() : '',
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
          messages: Array.isArray(item.messages ?? args.messages) ? (item.messages ?? args.messages).map(String) : [],
          subagentIds: [],
          createdAt: now,
          updatedAt: now,
        };
        state.tasks.push(task);
        created.push(task);
      }
      if (created.length === 0) return 'No valid tasks with a non-empty title were created.';
      saveStoreState(storePath, state);
      return `Created ${created.length} tracked ${created.length === 1 ? 'task' : 'tasks'}:\n${created.map(formatTaskLine).join('\n')}`;
    },
  });

  const listTool = makeTextTool({
    name: 'ListTrackedTasks',
    toolIdentifier: 'list_tracked_tasks',
    description: 'List tracked tasks for this conversation, optionally filtered by status or tag.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional status filter (todo, in_progress, for_review, done, canceled, open, all).' },
        include_closed: { type: 'boolean', description: 'Include done and canceled tasks (default: false).' },
        tag: { type: 'string', description: 'Optional tag ID filter.' },
      },
    },
    handler: (args) => {
      const state = loadStoreState(storePath);
      const statusFilter = typeof args.status === 'string' ? args.status.trim().toLowerCase() : '';
      const includeClosed = args.include_closed === true || statusFilter === 'all' || statusFilter === 'done' || statusFilter === 'canceled';
      const tagFilter = typeof args.tag === 'string' ? args.tag.trim() : '';
      const filtered = state.tasks.filter((task) => {
        if (tagFilter && !(task.tags ?? []).includes(tagFilter)) return false;
        if (statusFilter && statusFilter !== 'all' && statusFilter !== 'open') {
          return task.status === normalizeStatus(statusFilter, statusFilter);
        }
        return includeClosed || OPEN_STATUSES.has(task.status);
      });
      if (filtered.length === 0) return 'No tracked tasks match.';
      const tagHeader = state.tags.length > 0
        ? `Tags: ${state.tags.map((t) => `${t.id} (${t.label})`).join(', ')}\n`
        : '';
      return `${tagHeader}${filtered.map(formatTaskLine).join('\n')}`;
    },
  });

  const updateTool = makeTextTool({
    name: 'UpdateTrackedTasks',
    toolIdentifier: 'update_tracked_tasks',
    description: 'Update status, title, notes, or tags of one or more existing tracked tasks by key.',
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Task key (e.g. RB-1).' },
              task_id: { type: 'string', description: 'Alias for key.' },
              status: { type: 'string', enum: TASK_STATUSES },
              title: { type: 'string' },
              notes: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        key: { type: 'string', description: 'Shorthand single-task key.' },
        status: { type: 'string', enum: TASK_STATUSES },
        title: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: (args) => {
      const state = loadStoreState(storePath);
      const list = Array.isArray(args.updates) && args.updates.length > 0
        ? args.updates
        : (args.key || args.task_id ? [args] : []);
      if (list.length === 0) return 'No updates provided.';
      const now = new Date().toISOString();
      const updated = [];
      const missing = [];
      for (const patch of list) {
        const key = String(patch?.key ?? patch?.task_id ?? '').trim().toUpperCase();
        if (!key) continue;
        const task = state.tasks.find((t) => t.key.toUpperCase() === key);
        if (!task) {
          missing.push(key);
          continue;
        }
        if (patch.status !== undefined) task.status = normalizeStatus(patch.status, task.status);
        if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim();
        if (typeof patch.notes === 'string') task.notes = patch.notes.trim();
        if (Array.isArray(patch.tags)) task.tags = patch.tags.map(String);
        task.updatedAt = now;
        updated.push(task);
      }
      if (updated.length > 0) saveStoreState(storePath, state);
      const lines = [];
      if (updated.length > 0) lines.push(`Updated ${updated.length} ${updated.length === 1 ? 'task' : 'tasks'}:\n${updated.map(formatTaskLine).join('\n')}`);
      if (missing.length > 0) lines.push(`Not found: ${missing.join(', ')}`);
      return lines.join('\n') || 'No tasks were updated.';
    },
  });

  const tagsTool = makeTextTool({
    name: 'UpdateTrackedTaskTags',
    toolIdentifier: 'update_tracked_task_tags',
    description: "Replace your task list's tags (id, label, color), which the user filters tasks by.",
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              color: { type: 'string' },
            },
            required: ['id', 'label'],
          },
        },
      },
      required: ['tags'],
    },
    handler: (args) => {
      const state = loadStoreState(storePath);
      const nextTags = Array.isArray(args.tags)
        ? args.tags
            .filter((t) => t && typeof t.id === 'string' && t.id.trim() && typeof t.label === 'string' && t.label.trim())
            .map((t) => ({ id: t.id.trim(), label: t.label.trim(), ...(typeof t.color === 'string' && t.color.trim() ? { color: t.color.trim() } : {}) }))
        : [];
      state.tags = nextTags;
      saveStoreState(storePath, state);
      return `Saved ${nextTags.length} task ${nextTags.length === 1 ? 'tag' : 'tags'}.`;
    },
  });

  return {
    unavailable: false,
    tools: [createTool, listTool, updateTool, tagsTool],
    read,
    linkSubagent,
  };
}
