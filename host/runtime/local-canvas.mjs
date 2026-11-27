import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_CANVAS_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const SAFE_CANVAS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sanitizeCanvasId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return SAFE_CANVAS_ID.test(trimmed) ? trimmed : null;
}

function canvasFilePath(canvasesDir, canvasId) {
  return join(canvasesDir, `${canvasId}.json`);
}

function readCanvasRecord(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.canvasId !== 'string' || typeof parsed.source !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Self-hosted file-backed cloudCanvas port for 97658ad (ReadCanvas / WriteCanvas / EditCanvas / ListCanvases).
 * Persists canvases under `<agentDir>/canvases/<canvasId>.json` with zero external cloud dependency.
 */
export function createLocalCanvasPort({ agentDir, agentId = 'local' } = {}) {
  if (!agentDir) return undefined;
  const canvasesDir = join(agentDir, 'canvases');
  const urlFor = (canvasId) => `rokbot-local://canvas/${encodeURIComponent(agentId)}/${encodeURIComponent(canvasId)}`;

  return {
    async read({ canvasId } = {}) {
      const id = sanitizeCanvasId(canvasId);
      if (!id) {
        return { ok: false, reason: 'not_found', detail: 'Invalid canvas_id.' };
      }
      const record = readCanvasRecord(canvasFilePath(canvasesDir, id));
      if (!record) {
        return { ok: false, reason: 'not_found', detail: `Canvas "${id}" was not found.` };
      }
      return {
        ok: true,
        canvasId: record.canvasId,
        ...(record.title !== undefined ? { title: record.title } : {}),
        url: urlFor(record.canvasId),
        source: record.source,
      };
    },

    async write({ source, canvasId, title } = {}) {
      if (typeof source !== 'string') {
        return { ok: false, reason: 'refused', detail: 'Canvas source must be a string.' };
      }
      if (Buffer.byteLength(source, 'utf8') > MAX_CANVAS_BYTES) {
        return { ok: false, reason: 'too_large', detail: `Canvas exceeds maximum size (${MAX_CANVAS_BYTES} bytes).` };
      }
      let id;
      let existing = null;
      if (canvasId !== undefined) {
        id = sanitizeCanvasId(canvasId);
        if (!id) {
          return { ok: false, reason: 'refused', detail: 'Invalid canvas_id.' };
        }
        existing = readCanvasRecord(canvasFilePath(canvasesDir, id));
      } else {
        id = `canvas-${randomUUID().slice(0, 12)}`;
      }
      const now = new Date().toISOString();
      const resolvedTitle = typeof title === 'string' && title.trim().length > 0
        ? title.trim()
        : (existing?.title ?? 'Untitled canvas');
      const record = {
        canvasId: id,
        title: resolvedTitle,
        source,
        visibility: 'PRIVATE',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      try {
        mkdirSync(canvasesDir, { recursive: true, mode: 0o700 });
        writeFileSync(canvasFilePath(canvasesDir, id), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      } catch (error) {
        return { ok: false, reason: 'unavailable', detail: error?.message ?? String(error) };
      }
      return {
        ok: true,
        canvasId: id,
        title: resolvedTitle,
        url: urlFor(id),
      };
    },

    async list({ query, updatedAfter, limit } = {}) {
      if (!existsSync(canvasesDir)) {
        return { ok: true, canvases: [], hasMore: false };
      }
      const maxItems = Math.max(1, Math.min(MAX_LIST_LIMIT, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIST_LIMIT));
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
      const afterMs = typeof updatedAfter === 'string' && updatedAfter.trim() ? Date.parse(updatedAfter) : Number.NaN;
      const records = [];
      let entries = [];
      try {
        entries = readdirSync(canvasesDir);
      } catch (error) {
        return { ok: false, reason: 'unavailable', detail: error?.message ?? String(error) };
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const record = readCanvasRecord(join(canvasesDir, name));
        if (!record) continue;
        if (needle) {
          const hay = `${record.title ?? ''}\n${record.canvasId}\n${record.source.slice(0, 4000)}`.toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        if (Number.isFinite(afterMs)) {
          const updatedMs = Date.parse(record.updatedAt ?? '');
          if (!Number.isFinite(updatedMs) || updatedMs <= afterMs) continue;
        }
        records.push(record);
      }
      records.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
      const sliced = records.slice(0, maxItems);
      return {
        ok: true,
        canvases: sliced.map((record) => ({
          canvasId: record.canvasId,
          title: record.title ?? 'Untitled canvas',
          visibility: record.visibility ?? 'PRIVATE',
          updatedAt: record.updatedAt ?? new Date().toISOString(),
          url: urlFor(record.canvasId),
        })),
        hasMore: records.length > maxItems,
      };
    },
  };
}
