// Lazy, cached, low-latency input-box suggestions and synced settings/quick-phrases store
// for Web, Desktop, and Android clients.
// Routes through scenarioRoutes.suggestions (or falls back to defaultRoute with low-latency
// effort clamping). Never falls back to hardcoded static preset phrases.
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createModelSession } from '../runtime/model-session.mjs';
import { isConfiguredModelRouting, modelRouteForScenario } from '../runtime/model-routing.mjs';
import { reasoningOptions } from '../runtime/model-policy.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';
import {
  SuggestionHabits, filterAndRankSuggestions, habitSuggestions, frequentMessages, profilePromptSummary,
  MAX_SUGGESTION_CHARS_ZH,
} from './suggestion-habits.mjs';
import { isAssistantOfferPhrase, isSelfUserEntry } from './suggestion-voice.mjs';

// A suggestion answer is keyed by Bot + the last transcript entry, so it never goes stale while
// that entry is the last one: keep it for a day in memory and a week on disk (one per Bot).
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_PERSIST_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_CACHE = 200;
const MAX_PERSISTED_AGENTS = 200;
const MAX_SUGGESTIONS = 3;
// The model may propose a few more than shown: filtering (generic, repeats, ignored) picks from them.
const MAX_MODEL_ITEMS = 5;
// Short prompt, short answer: 3 items of at most ~22 characters fit in well under 120 tokens.
const SUGGESTION_MAX_TOKENS = 120;
const PROMPT_CONTEXT_MESSAGES = 4;
const PROMPT_LAST_MESSAGE_CHARS = 480;
const PROMPT_EARLIER_MESSAGE_CHARS = 160;
const PROMPT_CONTEXT_MESSAGES_WITH_PROFILE = 6;
const MAX_COMPLETION_CANDIDATES = 40;
const PROFILE_WAIT_MS = 1_500;
// A Bot's reply notification arrives as the turn ends; give the transcript a moment to settle.
const REPLY_PREFETCH_DELAY_MS = 800;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ITEM_CHARS = 72;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;
const MAX_QUICK_PHRASES = 50;
const MAX_PHRASE_CHARS = 120;
const PHRASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Inline completion (ghost text) limits: short, fast, single line.
const DEFAULT_COMPLETION_TIMEOUT_MS = 8_000;
const COMPLETION_MAX_TOKENS = 48;
const COMPLETION_MIN_CHARS = 2;
const COMPLETION_MAX_INPUT_CHARS = 2_000;
const COMPLETION_PROMPT_CHARS = 600;
const MAX_COMPLETION_CHARS = 80;
// Quotes the next message replies to (the composer's reply pills): context, never the user's words.
const MAX_QUOTES = 3;
const MAX_QUOTE_CHARS = 500;
// A reply notification can come in the middle of a turn (a message, then tool calls): the
// background answer waits until the Bot is idle, looking again every busyRetryMs.
const BUSY_RETRY_MS = 2_000;
const MAX_BUSY_RETRIES = 90;
// "[In reply to <id>: \"<quote>\"]" a runner may put in front of what the user typed.
const REPLY_CONTEXT_PREFIX_RE = /^\s*\[In reply to [^\]:]{1,256}:\s*"[\s\S]*?"\]\s*/;

/** The quotes of a request: [{ id, text }], at most 3, trimmed; anything else is dropped. */
export function normalizeQuotes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = String(typeof item === 'string' ? item : item?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_CHARS);
    const id = typeof item?.id === 'string' && AGENT_ID_RE.test(item.id) ? item.id : '';
    if (!text || seen.has(`${id}|${text}`)) continue;
    seen.add(`${id}|${text}`);
    out.push(id ? { id, text } : { text });
    if (out.length >= MAX_QUOTES) break;
  }
  return out;
}

/** A transcript entry still being written (a streamed reply, a running tool call). */
export function entryInProgress(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.isStreaming === true || entry.streaming === true) return true;
  const status = String(entry.status ?? entry.state ?? '').toLowerCase();
  return ['running', 'in_progress', 'in-progress', 'pending', 'streaming'].includes(status);
}

/**
 * Inline completion is offered only at the end of a one-line draft that is not a /command and not
 * inside code (the clients check the caret, the selection and the IME composition themselves).
 */
export function completionDraftAllowed(draft) {
  const text = String(draft ?? '');
  if (/\n/.test(text.replace(/\n+$/, ''))) return false;
  if (/^\s*\//.test(text)) return false;
  const fences = text.match(/(^|\n)\s*(```|~~~)/g)?.length ?? 0;
  if (fences % 2 === 1) return false;
  const ticks = text.replace(/(```|~~~)[\s\S]*?(```|~~~)/g, '').match(/`/g)?.length ?? 0;
  return ticks % 2 === 0;
}

/**
 * A suffix that rewrites the sentence instead of continuing it: it opens like the draft and reuses
 * most of its characters ("帮我看下" -> "帮你看下日志"), or starts a capitalised word in the middle
 * of one ("deplo" -> "Run tests"). Same rule as composer-assist.cjs.
 */
export function completionFitsDraft(draft, completion) {
  const suffix = String(completion ?? '');
  if (!suffix.trim()) return false;
  const key = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const typed = [...key(draft)];
  const head = [...key(suffix)].slice(0, typed.length);
  if (typed.length >= 2 && head.length >= 2 && head[0] === typed[0]) {
    const pool = new Set(typed);
    if (head.filter(ch => pool.has(ch)).length / head.length >= 0.75) return false;
  }
  if (/[A-Za-z]$/.test(String(draft ?? '')) && /^[A-Z]/.test(suffix)) return false;
  return true;
}

function normalizePhraseText(value) {
  check(typeof value === 'string', 400, '常用语内容无效');
  check(!value.includes('\0'), 400, '常用语内容无效');
  const cleaned = value.replace(/\s+/g, ' ').trim();
  check(cleaned.length >= 1, 400, '常用语不能为空');
  check([...cleaned].length <= MAX_PHRASE_CHARS, 400, `常用语最多 ${MAX_PHRASE_CHARS} 个字符`);
  return cleaned;
}

function generatePhraseId() {
  return `p_${randomBytes(6).toString('hex')}`;
}

function normalizeQuickPhrases(list) {
  check(Array.isArray(list), 400, '常用语列表格式无效');
  check(list.length <= MAX_QUICK_PHRASES, 400, `最多保存 ${MAX_QUICK_PHRASES} 条常用语`);
  const seenIds = new Set();
  const seenTexts = new Set();
  const result = [];
  for (const raw of list) {
    const rawText = typeof raw === 'string' ? raw : raw?.text;
    const text = normalizePhraseText(rawText);
    const textKey = text.toLowerCase();
    check(!seenTexts.has(textKey), 400, '常用语不能重复');
    seenTexts.add(textKey);

    let id = typeof raw === 'object' && raw !== null && typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || !PHRASE_ID_RE.test(id) || seenIds.has(id)) {
      do { id = generatePhraseId(); } while (seenIds.has(id));
    }
    seenIds.add(id);
    result.push({ id, text });
  }
  return result;
}

function sanitizeStoredState(raw) {
  const enabled = raw?.enabled !== false;
  const aiEnabled = raw?.aiEnabled !== false;
  const completionEnabled = raw?.completionEnabled !== false;
  const learningEnabled = raw?.learningEnabled !== false;
  const localCompletionEnabled = raw?.localCompletionEnabled !== false;
  const quickPhrases = [];
  const seenIds = new Set();
  const seenTexts = new Set();
  if (Array.isArray(raw?.quickPhrases)) {
    for (const item of raw.quickPhrases) {
      if (quickPhrases.length >= MAX_QUICK_PHRASES) break;
      const rawText = typeof item === 'string' ? item : item?.text;
      if (typeof rawText !== 'string' || rawText.includes('\0')) continue;
      const text = rawText.replace(/\s+/g, ' ').trim();
      if (!text || [...text].length > MAX_PHRASE_CHARS) continue;
      const key = text.toLowerCase();
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      let id = typeof item === 'object' && item !== null && typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || !PHRASE_ID_RE.test(id) || seenIds.has(id)) {
        do { id = generatePhraseId(); } while (seenIds.has(id));
      }
      seenIds.add(id);
      quickPhrases.push({ id, text });
    }
  }
  const updatedAt = typeof raw?.updatedAt === 'string' ? raw.updatedAt : null;
  return { version: 1, enabled, aiEnabled, completionEnabled, learningEnabled, localCompletionEnabled, quickPhrases, updatedAt };
}

export class SuggestionsSettings {
  constructor(directory) {
    this.store = new JsonStore(join(directory, 'suggestions-settings.json'), {
      version: 1,
      enabled: true,
      aiEnabled: true,
      completionEnabled: true,
      learningEnabled: true,
      localCompletionEnabled: true,
      quickPhrases: [],
      updatedAt: null,
    });
  }

  async load() {
    await this.store.load();
    const clean = sanitizeStoredState(this.store.value);
    Object.assign(this.store.value, clean);
    return this;
  }

  current() {
    const clean = sanitizeStoredState(this.store.value);
    return {
      enabled: clean.enabled,
      aiEnabled: clean.aiEnabled,
      completionEnabled: clean.completionEnabled,
      learningEnabled: clean.learningEnabled,
      localCompletionEnabled: clean.localCompletionEnabled,
      quickPhrases: clean.quickPhrases.map(item => ({ id: item.id, text: item.text })),
      updatedAt: clean.updatedAt,
    };
  }

  listPhrases() {
    const cur = this.current();
    return { quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async updateSettings(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '输入建议配置格式无效');
    const next = {};
    if (Object.hasOwn(input, 'enabled')) {
      check(typeof input.enabled === 'boolean', 400, 'enabled 必须为布尔值');
      next.enabled = input.enabled;
    }
    if (Object.hasOwn(input, 'aiEnabled')) {
      check(typeof input.aiEnabled === 'boolean', 400, 'aiEnabled 必须为布尔值');
      next.aiEnabled = input.aiEnabled;
    }
    if (Object.hasOwn(input, 'completionEnabled')) {
      check(typeof input.completionEnabled === 'boolean', 400, 'completionEnabled 必须为布尔值');
      next.completionEnabled = input.completionEnabled;
    }
    for (const key of ['learningEnabled', 'localCompletionEnabled']) {
      if (!Object.hasOwn(input, key)) continue;
      check(typeof input[key] === 'boolean', 400, `${key} 必须为布尔值`);
      next[key] = input[key];
    }
    if (Object.hasOwn(input, 'quickPhrases')) {
      next.quickPhrases = normalizeQuickPhrases(input.quickPhrases);
    }
    await this.store.mutate(state => {
      Object.assign(state, sanitizeStoredState(state), next, { updatedAt: new Date().toISOString() });
    });
    return this.current();
  }

  async addPhrase(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '常用语请求格式无效');
    const text = normalizePhraseText(input.text);
    let created = null;
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      check(clean.quickPhrases.length < MAX_QUICK_PHRASES, 400, `最多保存 ${MAX_QUICK_PHRASES} 条常用语`);
      const lower = text.toLowerCase();
      check(!clean.quickPhrases.some(item => item.text.toLowerCase() === lower), 400, '该常用语已存在');
      const used = new Set(clean.quickPhrases.map(item => item.id));
      let id;
      do { id = generatePhraseId(); } while (used.has(id));
      created = { id, text };
      clean.quickPhrases.push(created);
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { phrase: created, quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async updatePhrase(id, input) {
    check(typeof id === 'string' && PHRASE_ID_RE.test(id), 400, '常用语 ID 无效');
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '常用语请求格式无效');
    const text = normalizePhraseText(input.text);
    let updated = null;
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      const index = clean.quickPhrases.findIndex(item => item.id === id);
      check(index >= 0, 404, '常用语不存在');
      const lower = text.toLowerCase();
      check(
        !clean.quickPhrases.some((item, i) => i !== index && item.text.toLowerCase() === lower),
        400,
        '该常用语已存在',
      );
      updated = { id, text };
      clean.quickPhrases[index] = updated;
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { phrase: updated, quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async deletePhrase(id) {
    check(typeof id === 'string' && PHRASE_ID_RE.test(id), 400, '常用语 ID 无效');
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      const next = clean.quickPhrases.filter(item => item.id !== id);
      check(next.length !== clean.quickPhrases.length, 404, '常用语不存在');
      clean.quickPhrases = next;
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { ok: true, quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async reorderPhrases(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '排序参数无效');
    check(Array.isArray(input.ids), 400, '排序 ID 列表无效');
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      const byId = new Map(clean.quickPhrases.map(item => [item.id, item]));
      check(input.ids.length === clean.quickPhrases.length, 400, '排序 ID 列表与现有常用语数量不匹配');
      const seen = new Set();
      const reordered = [];
      for (const rawId of input.ids) {
        check(typeof rawId === 'string' && byId.has(rawId) && !seen.has(rawId), 400, '排序 ID 列表包含无效或重复项');
        seen.add(rawId);
        reordered.push(byId.get(rawId));
      }
      clean.quickPhrases = reordered;
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }
}

export function detectSuggestionLanguage(locale = '', messages = []) {
  const sample = messages
    .slice(-3)
    .map(item => item?.text ?? '')
    .join(' ');
  const cjkCount = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinCount = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjkCount >= 2 && cjkCount * 3 >= latinCount) return 'zh';
  if (latinCount >= 8 && cjkCount === 0) return 'en';
  if (typeof locale === 'string' && /^zh\b/i.test(locale.trim())) return 'zh';
  if (typeof locale === 'string' && locale.trim()) return 'en';
  return cjkCount > 0 ? 'zh' : 'en';
}

function extractText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.prompt === 'string') return value.prompt.trim();
    if (typeof value.body === 'string') return value.body.trim();
    if (value.content !== undefined) return extractText(value.content);
    if (value.message !== undefined) return extractText(value.message);
  }
  return '';
}

function normalizeRole(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // A "user" turn another Bot / an automation sent is not the user's voice: show it as the other side.
  if (entry.role === 'user') return isSelfUserEntry(entry) ? 'user' : 'assistant';
  if (entry.role === 'assistant') return entry.role;
  const kind = String(entry.kind ?? entry.type ?? '').toLowerCase();
  if (kind === 'user' || kind === 'user-message' || kind === 'prompt' || kind === 'user_message') return isSelfUserEntry(entry) ? 'user' : 'assistant';
  if (kind === 'assistant' || kind === 'assistant-message' || kind === 'send-message' || kind === 'agent-message' || kind === 'bot-message') {
    return 'assistant';
  }
  return null;
}

export function extractRecentMessages(entries, limit = MAX_CONTEXT_MESSAGES) {
  if (!Array.isArray(entries)) return [];
  const normalized = [];
  for (const entry of entries) {
    const role = normalizeRole(entry);
    if (!role) continue;
    const rawText = extractText(entry.text ?? entry.message ?? entry.content ?? entry.prompt);
    // A quoted reply in front of what the user typed is not the user's own words.
    const text = (role === 'user' ? rawText.replace(REPLY_CONTEXT_PREFIX_RE, '') : rawText).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    normalized.push({
      id: typeof entry.id === 'string' ? entry.id : '',
      role,
      text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}...` : text,
    });
  }
  return normalized.slice(-limit);
}

export function parseSuggestionResponse(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  let text = rawText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }

  let items = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.suggestions)) {
    items = parsed.suggestions;
  } else {
    items = text
      .split(/\r?\n/)
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
      .filter(Boolean);
  }

  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 2 || cleaned.length > MAX_ITEM_CHARS) continue;
    if (isAssistantOfferPhrase(cleaned)) continue;               // the Bot's voice, not the user's
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_MODEL_ITEMS) break;
  }
  return result;
}

function clipMiddle(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (max - head)).join('')}`;
}

/** The prompt only needs the gist: the last few messages, the latest one kept longest. */
export function compactSuggestionHistory(recentMessages, count = PROMPT_CONTEXT_MESSAGES) {
  const recent = recentMessages.slice(-count);
  return recent.map((item, index) => ({
    ...item,
    text: clipMiddle(item.text, index === recent.length - 1 ? PROMPT_LAST_MESSAGE_CHARS : PROMPT_EARLIER_MESSAGE_CHARS),
  }));
}

/**
 * The prompt: the recent turns plus what the Host learned about how this user writes to this Bot.
 * Generic filler ("继续执行下一步", "总结一下当前进展", ...) is forbidden; an empty array is a valid
 * answer when nothing specific fits (the strip then shows only the user's own phrases).
 */
export function buildSuggestionMessages(recentMessages, lang, { profileSummary = '', recentUserTexts = [], quotes = [] } = {}) {
  const isZh = lang === 'zh';
  const systemPrompt = isZh
    ? '你替用户预判他在这个对话里下一句最可能亲自打出来的话，用作输入框上方的快捷建议。' +
      '规则：1) 必须紧扣最后一条 Bot 回复里的具体对象（文件、命令、错误、选项、数字、名字），换个对话就不成立；' +
      '2) 用用户自己的口吻、语言、长短和常用说法（参考“用户习惯”），像他本人会打的字，不要客服腔；' +
      `3) 每条不超过${MAX_SUGGESTION_CHARS_ZH}个汉字；4) 0到3条，彼此不同，也不要重复用户最近发过的话；` +
      '5) 禁止空泛万能句，例如“继续”“继续执行下一步”“总结一下当前进展”“检查线上部署状态”“还有什么建议”“好的谢谢”“详细说说”；' +
      '没有足够具体的就少给或返回 []；6) Bot 在提问或给选项时，优先给出具体的回答或选择；' +
      '7) 每条都是用户发给 Bot 的话：“我”指用户本人，对象是 Bot（例如“帮我查一下这个问题”）；绝不能写成 Bot 主动提供帮助的口吻，' +
      '禁止“要不要我…”“需要我…”“我可以帮你…”“我来帮你…”“让我来…”这类说法。' +
      '只输出 JSON 字符串数组，不要解释、序号、Markdown 或表情。'
    : 'Predict what this user will most likely type next in this chat; shown as quick replies above the input. ' +
      'Rules: 1) tie each item to something concrete in the latest assistant reply (file, command, error, option, number, name) so it would not fit another chat; ' +
      "2) use the user's own voice, language, length and habits (see \"User habits\"); " +
      '3) at most 8 words each; 4) 0 to 3 items, distinct, not repeating what the user just sent; ' +
      '5) never generic filler like "continue", "next step", "summarize progress", "check the deployment status", "any other suggestions", "thanks", "tell me more" — return fewer or [] instead; ' +
      '6) when the assistant asks a question or offers options, answer or pick concretely. ' +
      '7) every item is something the USER sends to the assistant: first person ("I", "me") is the user, addressing the assistant (e.g. "check this issue for me"); ' +
      'never phrase an item as the assistant offering help — no "Would you like me to…", "Shall I…", "Do you want me to…", "Let me…", "I can help you…". ' +
      'Output ONLY a JSON array of strings, no explanation, numbering, markdown, or emojis.';

  const count = profileSummary ? PROMPT_CONTEXT_MESSAGES_WITH_PROFILE : PROMPT_CONTEXT_MESSAGES;
  const transcript = compactSuggestionHistory(recentMessages, count)
    .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`)
    .join('\n');
  const recentUser = recentUserTexts.slice(-5).map(text => `- ${clipMiddle(text, 80)}`).join('\n');
  const quoted = normalizeQuotes(quotes).map(item => `- ${clipMiddle(item.text, 200)}`).join('\n');
  const parts = [];
  if (profileSummary) parts.push(isZh ? `用户习惯：\n${profileSummary}` : `User habits:\n${profileSummary}`);
  if (quoted) {
    parts.push(isZh
      ? `用户正在引用并回复下面的内容（这是被引用的原文，不是用户说过的话；建议要围绕它来写用户接下来对它说的话）：\n${quoted}`
      : `The user is quoting and replying to the text below (quoted text, not something the user said; base the suggestions on what the user would say about it):\n${quoted}`);
  }
  if (recentUser) parts.push(isZh ? `用户最近发过（不要重复）：\n${recentUser}` : `User recently sent (do not repeat):\n${recentUser}`);
  parts.push(isZh ? `最近对话：\n${transcript}` : `Recent conversation:\n${transcript}`);
  parts.push(isZh ? '请只返回 JSON 字符串数组（可以是 []）：' : 'Return only the JSON array of strings (may be []):');
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** The model answered "nothing specific" ([]), as opposed to an unusable answer. */
export function isEmptySuggestionAnswer(rawText) {
  if (typeof rawText !== 'string') return false;
  let text = rawText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();
  return /^\[\s*\]$/.test(text) || /^\{\s*"suggestions"\s*:\s*\[\s*\]\s*\}$/.test(text);
}

function historySignature(recentMessages, explicitLastEntryId) {
  if (typeof explicitLastEntryId === 'string' && explicitLastEntryId.trim()) {
    return explicitLastEntryId.trim().slice(0, 128);
  }
  const last = recentMessages.at(-1);
  if (!last) return 'empty';
  if (last.id) return last.id;
  return createHash('sha256')
    .update(`${last.role}:${last.text}`)
    .digest('hex')
    .slice(0, 16);
}

// Suggestions need no reasoning: unless an effort was chosen explicitly (for the scenario or the
// default route), use the lowest one the model supports.
function optimizeRouteForLatency(route) {
  if (!route) return route;
  if (route.effort && route.effort !== 'default' && route.effort !== 'auto') return route;
  const supported = Array.isArray(route.efforts) ? route.efforts : [];
  for (const preferred of ['none', 'minimal', 'low']) {
    if (supported.includes(preferred)) {
      return { ...route, effort: preferred };
    }
  }
  return route;
}

function buildPayload({
  enabled, aiEnabled, quickPhrases, aiSuggestions, source, cached, lang, agentId = '', historyId = '',
  habitItems = [], completionCandidates, learningEnabled, localCompletionEnabled,
}) {
  const phrases = quickPhrases.map(item => ({ id: item.id, text: item.text }));
  const seen = new Set(phrases.map(item => item.text.toLowerCase()));
  const filteredAi = [];
  for (const text of aiSuggestions) {
    if (typeof text !== 'string') continue;
    const cleaned = text.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    filteredAi.push(cleaned);
    if (filteredAi.length >= MAX_SUGGESTIONS) break;
  }
  // The user's own repeated messages fill what the model left open (all of it without a model).
  const frequent = [];
  for (const text of habitItems) {
    if (filteredAi.length + frequent.length >= MAX_SUGGESTIONS) break;
    const key = String(text).toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    frequent.push(text);
  }
  const items = [
    ...phrases.map(item => ({ type: 'phrase', id: item.id, text: item.text })),
    ...filteredAi.map(text => ({ type: 'ai', text })),
    ...frequent.map(text => ({ type: 'frequent', text })),
  ];
  return {
    enabled,
    aiEnabled,
    quickPhrases: phrases,
    aiSuggestions: filteredAi,
    // rokbot habits (optional for older clients): repeated messages of this user to this Bot, and
    // the candidates the client matches locally while the user types (no request per keystroke).
    frequentSuggestions: frequent,
    ...(completionCandidates ? { completionCandidates } : {}),
    ...(typeof learningEnabled === 'boolean' ? { learningEnabled } : {}),
    ...(typeof localCompletionEnabled === 'boolean' ? { localCompletionEnabled } : {}),
    suggestions: items.map(item => item.text),
    items,
    source,
    cached,
    lang,
    // Which conversation the answer belongs to: clients drop an answer for another Bot.
    agentId,
    historyId,
  };
}

export function countChars(text) {
  return [...String(text ?? '')].length;
}

function buildCompletionMessages(recentMessages, draft, lang) {
  const isZh = lang === 'zh';
  const systemPrompt = isZh
    ? '你是聊天输入框的行内补全助手。用户正在输入一条消息，请根据最近对话与用户已输入的内容，预测这句话最可能的后半句。'
      + '要求：1) 只输出紧接在已输入内容之后的续写部分，不要重复已输入的内容；2) 只写一句、不换行，尽量简短（不超过 20 个字）；'
      + '3) 不要加引号、解释、Markdown 或表情符号；4) 没有把握时输出空内容；'
      + '5) 这是用户发给 Bot 的话：“我”是用户本人、对象是 Bot，绝不要续写成 Bot 主动提供帮助的口吻（如“要不要我…”“需要我…”“我来帮你…”）。'
    : 'You are an inline autocomplete for a chat composer. The user is typing a message. Using the recent conversation and the partial text, '
      + 'predict the most likely rest of the sentence. Rules: 1) Output ONLY the continuation that comes right after the partial text; never repeat it. '
      + '2) One short line (at most 8 words), no line breaks. 3) No quotes, explanations, markdown, or emojis. '
      + '4) Start with a space when the continuation begins a new word. 5) If unsure, output nothing. '
      + '6) This is the USER writing to the assistant: "I"/"me" is the user; never continue it as the assistant offering help ("Would you like me to…", "Shall I…", "Let me…").';
  const transcript = recentMessages
    .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`)
    .join('\n');
  const userPrompt = isZh
    ? `最近对话：\n${transcript}\n\n用户已输入：${draft}\n\n只输出续写部分：`
    : `Recent conversation:\n${transcript}\n\nPartial message: ${draft}\n\nContinuation only:`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * Turns raw model output into the suffix shown after the caret: first line only, without quotes,
 * without a repeated copy of the draft, capped in length. Returns '' when nothing usable remains.
 */
export function parseCompletionResponse(rawText, draft = '') {
  if (typeof rawText !== 'string') return '';
  let text = rawText.replace(/\r/g, '');
  const fenced = /```(?:\w+)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1];
  text = text.replace(/^\s*\n+/, '').split('\n')[0] ?? '';
  let leadingSpace = /^[ \t]/.test(text);
  text = text.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const typed = String(draft ?? '');
  const typedTrim = typed.trim();
  // The model sometimes repeats the whole draft (or its tail) before the continuation.
  if (typedTrim && text.toLowerCase().startsWith(typedTrim.toLowerCase())) {
    text = text.slice(typedTrim.length);
  } else {
    const tail = typedTrim.slice(-24);
    for (let k = Math.min(tail.length, text.length); k >= 4; k--) {
      if (text.toLowerCase().startsWith(tail.slice(-k).toLowerCase())) { text = text.slice(k); break; }
    }
  }
  if (/^\s/.test(text)) leadingSpace = true;
  const startsWord = /^[A-Za-z0-9]/.test(text.trimStart());
  text = text.trim();
  if (!text) return '';
  if ([...text].length > MAX_COMPLETION_CHARS) text = [...text].slice(0, MAX_COMPLETION_CHARS).join('').trimEnd();
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return '';
  // Latin continuations of a finished word need a separating space; CJK never does.
  const endsWithSpace = /\s$/.test(typed);
  const endsLatin = /[A-Za-z0-9,.;:!?]$/.test(typed);
  if (!endsWithSpace && endsLatin && startsWord && (leadingSpace || /[,.;:!?]$/.test(typed))) text = ` ${text}`;
  return text;
}

/**
 * '' when draft + completion turns into the assistant's offer ("要不要" + "我一起查一下"). What the
 * user typed themself stays theirs: a draft that already reads that way is completed as usual.
 */
export function voiceSafeCompletion(draft, completion) {
  if (!completion) return '';
  const typed = String(draft ?? '');
  if (isAssistantOfferPhrase(typed)) return completion;
  return isAssistantOfferPhrase(`${typed}${completion}`) ? '' : completion;
}

export class SuggestionsService {
  constructor({
    models,
    settings,
    hostCall,
    dataDir,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    completionTimeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
    ttlMs = DEFAULT_TTL_MS,
    persistTtlMs = DEFAULT_PERSIST_TTL_MS,
    maxCache = DEFAULT_MAX_CACHE,
    replyPrefetchDelayMs = REPLY_PREFETCH_DELAY_MS,
    profileWaitMs = PROFILE_WAIT_MS,
    busyRetryMs = BUSY_RETRY_MS,
    maxBusyRetries = MAX_BUSY_RETRIES,
    habits,
    now = () => Date.now(),
  } = {}) {
    this.models = models;
    this.settings = settings;
    this.hostCall = hostCall;
    this.usageDirectory = dataDir ? join(dataDir, 'usage') : undefined;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.completionTimeoutMs = completionTimeoutMs;
    this.ttlMs = ttlMs;
    this.persistTtlMs = persistTtlMs;
    this.maxCache = maxCache;
    this.replyPrefetchDelayMs = replyPrefetchDelayMs;
    this.now = now;
    this.cache = new Map();
    this.inFlight = new Map();
    this.prefetching = new Map();
    this.prefetchTimers = new Map();
    this.completionCache = new Map();
    this.completionInFlight = new Map();
    // The latest answer per Bot survives a Host restart: reopening a chat shows it at once.
    this.persisted = dataDir ? new JsonStore(join(dataDir, 'suggestions-cache.json'), { version: 1, agents: {} }) : null;
    // What the user sends to each Bot and how they react to suggestions (suggestion-habits.mjs).
    this.habits = habits ?? new SuggestionHabits({ dataDir, hostCall, now });
    this.profileWaitMs = profileWaitMs;
    this.busyRetryMs = busyRetryMs;
    this.maxBusyRetries = maxBusyRetries;
  }

  async load() {
    await this.habits.load?.();
    if (!this.persisted) return this;
    try {
      await this.persisted.load();
      if (!this.persisted.value.agents || typeof this.persisted.value.agents !== 'object') this.persisted.value.agents = {};
    } catch (error) {
      console.warn(`[suggestions] cache file ignored: ${error?.message ?? error}`);
      this.persisted.value = { version: 1, agents: {} };
    }
    return this;
  }

  close() {
    for (const timer of this.prefetchTimers.values()) clearTimeout(timer);
    this.prefetchTimers.clear();
  }

  #getCached(key, agentId) {
    const entry = this.cache.get(key);
    if (entry) {
      if (this.now() - entry.at >= this.ttlMs) {
        this.cache.delete(key);
      } else {
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry;
      }
    }
    const stored = agentId ? this.persisted?.value?.agents?.[agentId] : null;
    if (stored && stored.key === key && Array.isArray(stored.aiSuggestions) && this.now() - stored.at < this.persistTtlMs) {
      const warm = { aiSuggestions: stored.aiSuggestions.filter(item => typeof item === 'string').slice(0, MAX_MODEL_ITEMS),
        source: 'model', lang: stored.lang, at: stored.at };
      this.cache.set(key, warm);
      return warm;
    }
    return null;
  }

  #setCached(key, value, agentId) {
    // The per-Bot disk copy is the answer of the chat itself, not of a pending quote.
    if (key.includes('|quote=')) agentId = '';
    this.cache.delete(key);
    this.cache.set(key, { ...value, at: this.now() });
    while (this.cache.size > this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    if (!agentId || !this.persisted?.value) return;
    const at = this.now();
    this.persisted.mutate(state => {
      state.agents ??= {};
      delete state.agents[agentId];
      state.agents[agentId] = { key, aiSuggestions: value.aiSuggestions, lang: value.lang, at };
      const ids = Object.keys(state.agents);
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PERSISTED_AGENTS))) delete state.agents[id];
    }).catch(error => console.warn(`[suggestions] cache write failed: ${error?.message ?? error}`));
  }

  /**
   * Recent messages of the conversation. With a Bot ID only the Host's own transcript of that
   * Bot is used: messages a client scraped from its screen may still belong to the previous Bot
   * right after a switch. Returns null when that transcript cannot be read.
   */
  async #loadRecentMessages(agentId, providedMessages, onEntries) {
    if (agentId && typeof this.hostCall === 'function') {
      try {
        const tail = await this.hostCall('getAgentTranscriptTail', { id: agentId, limit: 12 });
        const entries = Array.isArray(tail?.entries) ? tail.entries
          : Array.isArray(tail?.transcript?.entries) ? tail.transcript.entries
          : Array.isArray(tail) ? tail : [];
        onEntries?.(entries);
        return extractRecentMessages(entries);
      } catch (error) {
        console.warn(`[suggestions] getAgentTranscriptTail failed for ${agentId}: ${error?.message ?? error}`);
        return null;
      }
    }
    if (!agentId && Array.isArray(providedMessages) && providedMessages.length > 0) {
      return extractRecentMessages(providedMessages);
    }
    return [];
  }

  /**
   * Whether the Bot runs a turn right now (the Host roster's isRunning). A roster that cannot be
   * read does not block suggestions: the transcript's in-progress entries and the client's own
   * Stop button / working badge still apply.
   */
  async #agentRunning(agentId) {
    if (!agentId || typeof this.hostCall !== 'function') return false;
    try {
      const rows = await this.hostCall('listAgents', {});
      const list = Array.isArray(rows) ? rows : Array.isArray(rows?.agents) ? rows.agents : [];
      return list.some(row => row?.id === agentId && row.isRunning === true);
    } catch {
      return false;
    }
  }

  /**
   * Starts generating in the background (entering a chat, a Bot's new reply) so the next
   * request is answered from the cache. Concurrent prefetches of one Bot share one run.
   */
  prefetch({ agentId = '', locale = '' } = {}) {
    if (!agentId || !AGENT_ID_RE.test(agentId)) return false;
    const cfg = this.settings?.current?.() ?? { enabled: true, aiEnabled: true };
    if (!cfg.enabled || !cfg.aiEnabled) return false;
    if (this.prefetching.has(agentId)) return true;
    // Still working (the reply was followed by a tool call): wait for the end of the turn, then
    // generate once. Nothing is generated while the turn runs.
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const result = await this.generate({ agentId, locale, foreground: false });
        if (result?.source !== 'busy' || attempt >= this.maxBusyRetries) return result;
        await new Promise(resolve => { const timer = setTimeout(resolve, this.busyRetryMs); timer.unref?.(); });
      }
    };
    const task = run()
      .catch(error => console.warn(`[suggestions] prefetch failed for ${agentId}: ${error?.message ?? error}`))
      .finally(() => { if (this.prefetching.get(agentId) === task) this.prefetching.delete(agentId); });
    this.prefetching.set(agentId, task);
    return true;
  }

  /** A Bot finished a turn (Host notification 'message' / 'completed'): prepare its suggestions. */
  onAgentNotification(item) {
    if (!item || !['message', 'completed'].includes(item.type)) return false;
    const agentId = typeof item.agentId === 'string' ? item.agentId : '';
    if (!AGENT_ID_RE.test(agentId)) return false;
    clearTimeout(this.prefetchTimers.get(agentId));
    const timer = setTimeout(() => {
      this.prefetchTimers.delete(agentId);
      this.prefetch({ agentId });
    }, this.replyPrefetchDelayMs);
    timer.unref?.();
    this.prefetchTimers.set(agentId, timer);
    return true;
  }

  /** The habit profile of a Bot, or null; a slow first build continues in the background. */
  async #habitProfile(agentId, cfg) {
    if (!agentId || cfg.learningEnabled === false || !this.habits) return null;
    const task = this.habits.profile(agentId);
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), this.profileWaitMs); timer.unref?.(); });
    try {
      return await Promise.race([task, timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async generate({ agentId = '', lastEntryId = '', locale = '', recentMessages, quotes: rawQuotes, force = false, foreground = true } = {}) {
    const quotes = normalizeQuotes(rawQuotes);
    const cfg = this.settings?.current?.() ?? { enabled: true, aiEnabled: true, quickPhrases: [] };
    const initialLang = detectSuggestionLanguage(locale, []);
    const learning = cfg.learningEnabled !== false;
    const localCompletion = cfg.localCompletionEnabled !== false;

    // Master switch off: return empty immediately without touching transcript or model.
    if (!cfg.enabled) {
      return buildPayload({
        enabled: false,
        aiEnabled: cfg.aiEnabled,
        quickPhrases: [],
        aiSuggestions: [],
        source: 'disabled',
        cached: false,
        lang: initialLang,
        agentId,
        learningEnabled: learning,
        localCompletionEnabled: localCompletion,
      });
    }

    const profileTask = this.#habitProfile(agentId, cfg);
    let profile = null;
    let recentUserTexts = [];
    const feedback = learning && agentId ? this.habits?.feedbackOf?.(agentId) ?? {} : {};
    const payload = (fields, { modelItems = null, lang: outLang = fields.lang } = {}) => {
      const ranked = modelItems
        ? filterAndRankSuggestions(modelItems, { lang: outLang, profile, feedback: learning ? feedback : {}, recentUserTexts, max: MAX_SUGGESTIONS })
        : fields.aiSuggestions ?? [];
      const habitItems = learning
        ? habitSuggestions(profile, feedback, { exclude: [...ranked, ...cfg.quickPhrases.map(item => item.text)], max: MAX_SUGGESTIONS })
        : [];
      const candidates = localCompletion
        ? [...cfg.quickPhrases.map(item => item.text), ...(learning ? frequentMessages(profile, { min: 2, limit: MAX_COMPLETION_CANDIDATES }).map(item => item.text) : [])]
          .filter(text => !isAssistantOfferPhrase(text))
        : [];
      const out = buildPayload({
        enabled: true, aiEnabled: true, quickPhrases: cfg.quickPhrases, cached: false, agentId,
        learningEnabled: learning, localCompletionEnabled: localCompletion,
        completionCandidates: [...new Set(candidates)].slice(0, MAX_COMPLETION_CANDIDATES),
        habitItems, ...fields, aiSuggestions: ranked,
      });
      if (foreground && learning && agentId) {
        void this.habits?.noteShown?.(agentId, [...out.aiSuggestions, ...out.frequentSuggestions]);
      }
      return out;
    };

    // AI suggestions switch off: the user's quick phrases (and own frequent messages) only.
    if (!cfg.aiEnabled) {
      profile = await profileTask;
      return payload({ aiEnabled: false, aiSuggestions: [], source: 'phrases-only', lang: initialLang });
    }

    // Only an idle Bot gets suggestions: a running turn (a streamed reply, a tool call after the
    // reply on screen) gets nothing — not generated, not cached, not counted as shown.
    let inProgress = false;
    const [history, running] = await Promise.all([
      this.#loadRecentMessages(agentId, recentMessages, entries => { inProgress = entries.some(entryInProgress); }),
      this.#agentRunning(agentId),
    ]);
    if (running || inProgress) {
      return buildPayload({ enabled: true, aiEnabled: true, quickPhrases: cfg.quickPhrases, aiSuggestions: [], source: 'busy',
        cached: false, lang: initialLang, agentId, learningEnabled: learning, localCompletionEnabled: localCompletion });
    }
    profile = await profileTask;
    if (history === null) return payload({ aiSuggestions: [], source: 'model-error', lang: initialLang });
    const lang = detectSuggestionLanguage(locale, history);
    recentUserTexts = [...(profile?.recent ?? []), ...history.filter(item => item.role === 'user').map(item => item.text)].slice(-8);

    // Empty chat: no LLM call and no hardcoded presets — the user's own phrases only.
    if (history.length === 0) return payload({ aiSuggestions: [], source: 'empty', lang });

    const route = await this.#resolveRoute();
    if (!route) return payload({ aiSuggestions: [], source: 'model-unavailable', lang });

    // The Host's own transcript decides which message the answer belongs to; a client's
    // lastEntryId only matters when there is no Bot ID to read it from.
    const historyId = historySignature(history, agentId ? '' : lastEntryId);
    const habitsTag = learning && profile?.total ? `h${profile.total}` : 'h0';
    // Adding or removing a quote is another state of the conversation: another answer.
    const quoteTag = quotes.length ? `|quote=${createHash('sha256').update(JSON.stringify(quotes)).digest('hex').slice(0, 12)}` : '';
    const cacheKey = `${agentId || '_'}:${historyId}:${lang}:${route.profileId}:${route.model}:${route.effort}:${habitsTag}${quoteTag}`;
    if (!force) {
      const hit = this.#getCached(cacheKey, agentId);
      if (hit) return payload({ source: hit.source, cached: true, lang, historyId }, { modelItems: hit.aiSuggestions });
      const existing = this.inFlight.get(cacheKey);
      if (existing) {
        const result = await existing;
        return payload({ source: result.source, cached: true, lang: result.lang, historyId }, { modelItems: result.aiSuggestions });
      }
    }

    const context = {
      profileSummary: learning ? profilePromptSummary(profile, lang) : '',
      recentUserTexts,
      quotes,
    };
    const task = this.#generateFromModel(route, history, lang, cacheKey, agentId, context);
    this.inFlight.set(cacheKey, task);
    try {
      const outcome = await task;
      return payload({ source: outcome.source, lang: outcome.lang, historyId }, { modelItems: outcome.aiSuggestions });
    } finally {
      if (this.inFlight.get(cacheKey) === task) this.inFlight.delete(cacheKey);
    }
  }

  /** Client feedback (a tapped suggestion, a dismissed strip). */
  async feedback({ agentId = '', action = '', text = '', shown = [] } = {}) {
    const cfg = this.settings?.current?.() ?? {};
    if (!agentId || !AGENT_ID_RE.test(agentId) || cfg.learningEnabled === false) return { recorded: false };
    if (!['tap', 'dismiss'].includes(action)) return { recorded: false };
    const clean = list => (Array.isArray(list) ? list : [])
      .filter(item => typeof item === 'string').map(item => item.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS)).filter(Boolean).slice(0, 8);
    await this.habits.record(agentId, { action, text: typeof text === 'string' ? text.trim().slice(0, MAX_PHRASE_CHARS) : '', shown: clean(shown) });
    return { recorded: true };
  }

  /** 清空学习记录: profiles, reactions, and the answers that were built with them. */
  async clearHabits() {
    await this.habits.clear();
    this.cache.clear();
    if (this.persisted?.value) {
      await this.persisted.mutate(state => { state.agents = {}; }).catch(() => {});
    }
    return { cleared: true, ...this.habits.summary() };
  }

  habitsSummary() {
    const cfg = this.settings?.current?.() ?? {};
    return { learningEnabled: cfg.learningEnabled !== false, ...this.habits.summary() };
  }

  async #resolveRoute() {
    let routing = null;
    try {
      const current = await this.models?.currentOrEmpty?.();
      routing = current?.routing ?? null;
    } catch {
      routing = null;
    }
    if (!routing || !isConfiguredModelRouting(routing)) return null;
    try {
      return optimizeRouteForLatency(modelRouteForScenario(routing, 'suggestions', { direct: true }));
    } catch {
      return null;
    }
  }

  /** Streams one short model answer; aborts after timeoutMs or when `signal` aborts. */
  async #streamText(route, messages, { timeoutMs, maxTokens, kind, label, signal, agentId }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label} request timed out`)), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(signal.reason ?? new Error(`${label} request cancelled`));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const session = createModelSession({
        ...route,
        fetchImpl: this.fetchImpl ?? globalThis.fetch,
        selectRequest: async ({ signal: inner } = {}) => {
          inner?.throwIfAborted();
          return { ...route, requestOptions: reasoningOptions(route.model, route.effort), fallbacks: [] };
        },
        onUsage: async usage => {
          if (!this.usageDirectory) return;
          await recordUsage(this.usageDirectory, { ...usage, kind, ...(agentId ? { agentId } : {}) }).catch(() => {});
        },
      });
      const stream = session
        .getExecutor(messages)
        .stream({ signal: controller.signal }, label, [], { maxTokens });
      let output = '';
      for await (const part of stream.fullStream) {
        if (part?.type === 'text-delta') {
          const chunk = part.textDelta ?? part.text ?? part.delta ?? '';
          if (typeof chunk === 'string') output += chunk;
        }
      }
      await stream.response.catch(() => {});
      controller.signal.throwIfAborted();
      return output;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async #generateFromModel(route, history, lang, cacheKey, agentId, context = {}) {
    try {
      const output = await this.#streamText(route, buildSuggestionMessages(history, lang, context), {
        timeoutMs: this.timeoutMs, maxTokens: SUGGESTION_MAX_TOKENS, kind: 'suggestions', label: 'composer-suggestions', agentId,
      });
      const parsed = parseSuggestionResponse(output);
      if (parsed.length === 0) {
        // "Nothing specific fits" is an answer too: keep it, so the chat is not asked again.
        if (isEmptySuggestionAnswer(output)) {
          const entry = { aiSuggestions: [], source: 'model', lang };
          this.#setCached(cacheKey, entry, agentId);
          return entry;
        }
        console.warn(`[suggestions] empty or unparseable model response (${route.model})`);
        return { aiSuggestions: [], source: 'model-error', lang };
      }
      const entry = { aiSuggestions: parsed, source: 'model', lang };
      this.#setCached(cacheKey, entry, agentId);
      return entry;
    } catch (error) {
      console.warn(`[suggestions] model call failed (${route.model}): ${error?.message ?? error}`);
      return { aiSuggestions: [], source: 'model-error', lang };
    }
  }

  #completionCached(key) {
    const entry = this.completionCache.get(key);
    if (!entry) return null;
    if (this.now() - entry.at >= this.ttlMs) {
      this.completionCache.delete(key);
      return null;
    }
    this.completionCache.delete(key);
    this.completionCache.set(key, entry);
    return entry;
  }

  #setCompletionCached(key, completion) {
    this.completionCache.delete(key);
    this.completionCache.set(key, { completion, at: this.now() });
    while (this.completionCache.size > this.maxCache) {
      const oldest = this.completionCache.keys().next().value;
      if (oldest === undefined) break;
      this.completionCache.delete(oldest);
    }
  }

  /**
   * Inline completion for the composer: the predicted rest of `text` (suffix only).
   * Never calls the model when completion is off, the draft is shorter than 2 characters,
   * or the chat has no history. Failures are silent ({ completion: '' }) and never cached.
   * `signal` cancels the model call (the client went away or sent a newer request).
   */
  async complete({ agentId = '', lastEntryId = '', locale = '', text = '', recentMessages, signal } = {}) {
    const cfg = this.settings?.current?.() ?? { completionEnabled: true };
    const draft = typeof text === 'string' ? text.slice(-COMPLETION_MAX_INPUT_CHARS) : '';
    const result = (completion, source, extra = {}) => ({
      enabled: cfg.completionEnabled !== false,
      text: draft,
      completion,
      source,
      cached: false,
      ...extra,
    });
    if (cfg.completionEnabled === false) return result('', 'disabled');
    if (countChars(draft.trim()) < COMPLETION_MIN_CHARS) return result('', 'too-short');
    if (!completionDraftAllowed(draft)) return result('', 'not-applicable');

    const history = await this.#loadRecentMessages(agentId, recentMessages);
    if (history === null) return result('', 'model-error');
    if (history.length === 0) return result('', 'empty');
    signal?.throwIfAborted?.();
    const lang = detectSuggestionLanguage(locale, [...history, { text: draft }]);
    const route = await this.#resolveRoute();
    if (!route) return result('', 'model-unavailable');

    const sig = historySignature(history, agentId ? '' : lastEntryId);
    const draftHash = createHash('sha256').update(draft).digest('hex').slice(0, 24);
    const cacheKey = `${agentId || '_'}:${sig}:${lang}:${route.profileId}:${route.model}:${route.effort}:${draftHash}`;
    const hit = this.#completionCached(cacheKey);
    if (hit) return result(hit.completion, 'model', { cached: true, lang });

    let task = this.completionInFlight.get(cacheKey);
    const shared = Boolean(task);
    if (!task) {
      task = (async () => {
        const output = await this.#streamText(route, buildCompletionMessages(history, draft.slice(-COMPLETION_PROMPT_CHARS), lang), {
          timeoutMs: this.completionTimeoutMs,
          maxTokens: COMPLETION_MAX_TOKENS,
          kind: 'suggestions',
          label: 'composer-completion',
          signal,
          agentId,
        });
        const parsed = voiceSafeCompletion(draft, parseCompletionResponse(output, draft));
        const completion = parsed && completionFitsDraft(draft, parsed) ? parsed : '';
        this.#setCompletionCached(cacheKey, completion);
        return completion;
      })();
      this.completionInFlight.set(cacheKey, task);
      task.finally(() => {
        if (this.completionInFlight.get(cacheKey) === task) this.completionInFlight.delete(cacheKey);
      }).catch(() => {});
    }
    try {
      const completion = await task;
      return result(completion, 'model', { cached: shared, lang });
    } catch (error) {
      if (signal?.aborted) return result('', 'cancelled', { lang });
      console.warn(`[suggestions] completion failed (${route.model}): ${error?.message ?? error}`);
      return result('', 'model-error', { lang });
    }
  }
}
