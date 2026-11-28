// Composer assist for the Web client and the desktop apps (macOS, Windows, Linux).
// One implementation, two loaders:
//   - desktop: `require('./composer-assist.cjs')` from the preload (suggestions-composer.cjs),
//     with an IPC-backed `request`;
//   - Web: packaged as client/desktop/composer-assist.js and imported for its side effect by
//     bridge.js (it then lives on globalThis.RokBotComposerAssist), with the gateway's `request`.
// It provides:
//   - the suggestion strip above the composer (quick phrases first, AI replies after, click to send,
//     only while the composer is focused) with a shimmer skeleton while AI replies are generated;
//   - inline completion: the predicted rest of the draft as ghost text after the caret
//     (Tab or ArrowRight at the end accepts), debounced, cancellable and cached;
//   - the first-level "Input suggestions" settings entry (toggles + quick phrases).
// The state logic (createLoadingMachine, createCompletionController) has no DOM dependency.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.RokBotComposerAssist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const svg = (body, { size = 13, width = 2 } = {}) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    phrase: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>'),
    sparkle: svg('<path d="M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.5l-1.9-5.4L5 10.2l5.1-1.9L12 3z"/>'
      + '<path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/>', { width: 1.9 }),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    up: svg('<path d="M18 15l-6-6-6 6"/>'),
    down: svg('<path d="M6 9l6 6 6-6"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
    check: svg('<path d="M20 6L9 17l-5-5"/>', { width: 2.2 }),
    plus: svg('<path d="M12 5v14M5 12h14"/>', { size: 14, width: 2.2 }),
    // First-level settings entry: a chat bubble with a spark, drawn like the official 15px nav icons.
    nav: svg('<path d="M20 12.5a7.5 7.5 0 0 1-11.06 6.6L4 20.5l1.4-4.5A7.5 7.5 0 1 1 20 12.5z"/>'
      + '<path d="M12.5 8.6l.75 1.95 1.95.75-1.95.75-.75 1.95-.75-1.95-1.95-.75 1.95-.75z"/>', { size: 15, width: 1.7 }),
  };

  const MAX_CLIENT_CACHE = 60;
  const FOCUS_FETCH_DEBOUNCE_MS = 100;
  const DEFAULT_TIMEOUT_MS = 10_000;
  const MAX_AI_SUGGESTIONS = 3;
  /** Strip show / hide / change: fade + 3px rise (matches .rokbot-suggestions--enter in workspace.css). */
  const BAR_FADE_MS = 170;
  // After the chat on screen changes (another Bot, a new reply), the answer is prepared in the
  // background so focusing the composer shows it at once.
  const PREFETCH_DEBOUNCE_MS = 350;
  const COMPLETION_TIMEOUT_MS = 9_000;
  const COMPLETION_DEBOUNCE_MS = 350;
  const COMPLETION_MIN_CHARS = 2;
  const SETTINGS_SYNC_TTL_MS = 15_000;
  const SKELETON_WIDTHS = [86, 118, 72];
  // A turn is over only after the screen stayed quiet this long with no Stop button / working
  // badge: between two tool calls of one turn the Stop button can disappear for a moment.
  const IDLE_SETTLE_MS = 1_200;
  // Two generations for one Bot are at least this far apart (a quote added and removed at once).
  const REGENERATE_MIN_INTERVAL_MS = 4_000;
  // What the user just sent (a tapped suggestion) is not suggested again for a while.
  const RECENT_SENT_TTL_MS = 10 * 60_000;
  const MAX_QUOTES = 3;
  const MAX_QUOTE_CHARS = 500;

  // ---- small helpers ------------------------------------------------------------------------

  function isZhLocale(lang) {
    const value = lang ?? (globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '');
    return String(value).toLowerCase().startsWith('zh');
  }
  const t = (zh, zhText, enText) => (zh ? zhText : enText);
  const countChars = text => [...String(text ?? '')].length;

  function normalizeSettings(raw) {
    return {
      enabled: raw?.enabled !== false,
      aiEnabled: raw?.aiEnabled !== false,
      completionEnabled: raw?.completionEnabled !== false,
      learningEnabled: raw?.learningEnabled !== false,
      localCompletionEnabled: raw?.localCompletionEnabled !== false,
      quickPhrases: Array.isArray(raw?.quickPhrases)
        ? raw.quickPhrases
          .map(item => ({ id: String(item?.id ?? ''), text: String(item?.text ?? '').trim() }))
          .filter(item => item.text.length > 0)
        : [],
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    };
  }

  // ---- the user's voice (same rule as host/server/suggestion-voice.mjs) ------------------------
  // Suggestions are what the USER sends to the Bot. Learned habits, local completion candidates and
  // model output never contain the Bot offering help (「要不要我一起查一下这个问题」, "Would you like
  // me to…"), and only messages the user themself sent are ever learned.
  const ASSISTANT_OFFER_PREFIXES = Object.freeze([
    '要不要我', '需不需要我', '需要我', '我可以帮你', '我可以为你', '我来帮你', '我帮你', '让我来',
    'would you like me', 'shall i', 'do you want me', 'let me', 'i can help you', "i'll help you", 'i will help you',
  ]);
  const OFFER_EXCEPTIONS = Object.freeze(['let me know']);
  const LEADING_NOISE = /^[\s"'“”‘’`「」『』（）()【】\[\]<>《》.,，。、!！?？:：;；~～…\-—*_#>]+/u;
  const voiceKey = text => String(text ?? '').normalize('NFKC').replace(/[’‘]/g, "'").replace(LEADING_NOISE, '').replace(/\s+/g, ' ').toLowerCase();

  function isAssistantOfferPhrase(text) {
    const key = voiceKey(text);
    if (!key || OFFER_EXCEPTIONS.some(prefix => key.startsWith(prefix))) return false;
    return ASSISTANT_OFFER_PREFIXES.some(prefix => key.startsWith(prefix)
      && (!/[a-z]$/.test(prefix) || !/^[a-z]/.test(key.slice(prefix.length))));
  }

  const SELF_NAMES = new Set(['self', 'me', 'user', 'human', '我']);
  const NON_SELF_SOURCES = new Set(['agent', 'bot', 'assistant', 'system', 'tool', 'automation', 'routine', 'webhook', 'schedule', 'scheduler', 'federation', 'notification']);
  const someoneElse = value => {
    if (value === undefined || value === null || value === '') return false;
    if (typeof value === 'string') return !SELF_NAMES.has(value.toLowerCase());
    if (typeof value === 'object') {
      const kind = String(value.kind ?? value.type ?? value.role ?? '').toLowerCase();
      return kind ? !SELF_NAMES.has(kind) : Boolean(value.id || value.agentId || value.name);
    }
    return Boolean(value);
  };

  /** A message the user themself sent (never assistant / bot / system / tool, nor another Bot's "user" turn). */
  function isSelfUserEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const role = typeof entry.role === 'string' ? entry.role.toLowerCase() : '';
    const kind = String(entry.kind ?? entry.type ?? '').toLowerCase();
    if (role ? role !== 'user' : !['user', 'user-message', 'prompt', 'user_message'].includes(kind)) return false;
    if (entry.fromAgent || entry.fromAgentId || entry.senderAgentId || entry.agentSender) return false;
    if (someoneElse(entry.sender) || someoneElse(entry.author) || someoneElse(entry.from)) return false;
    const source = String(entry.source ?? entry.origin ?? '').toLowerCase();
    if (source && NON_SELF_SOURCES.has(source)) return false;
    return !(entry.synthetic === true || entry.isSystem === true || entry.automated === true);
  }

  /** '' when the continuation turns the draft into the Bot's offer; a draft the user typed that way stays theirs. */
  function voiceSafeCompletion(draft, completion) {
    if (!completion) return '';
    const typed = String(draft ?? '');
    if (isAssistantOfferPhrase(typed)) return completion;
    return isAssistantOfferPhrase(typed + completion) ? '' : completion;
  }

  /** Quick phrases, the model's items, then the user's own frequent messages (habits) to fill. */
  function mergeSuggestionItems(quickPhrases = [], aiSuggestions = [], frequentSuggestions = []) {
    const items = [];
    const seen = new Set();
    for (const raw of Array.isArray(quickPhrases) ? quickPhrases : []) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ type: 'phrase', id: typeof raw === 'object' && raw?.id ? String(raw.id) : '', text });
    }
    for (const raw of Array.isArray(aiSuggestions) ? aiSuggestions : []) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      if (!text || isAssistantOfferPhrase(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ type: 'ai', text });
    }
    let room = MAX_AI_SUGGESTIONS - items.filter(item => item.type === 'ai').length;
    for (const raw of Array.isArray(frequentSuggestions) ? frequentSuggestions : []) {
      if (room <= 0) break;
      const text = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      if (!text || isAssistantOfferPhrase(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ type: 'frequent', text });
      room--;
    }
    return items;
  }

  const normalizeMatchKey = text => String(text ?? '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

  /**
   * Local completion while typing (no network): quick phrases and the messages the user often
   * sends to this Bot that complete the draft. Prefix, then substring, then characters in order;
   * never the draft itself. Same ranking as the Host's matchCompletions.
   */
  function matchCompletions(draft, pool = [], max = 3) {
    const q = normalizeMatchKey(draft);
    if (!q || !Array.isArray(pool) || max <= 0) return [];
    const prefix = [];
    const substring = [];
    const fuzzy = [];
    const seen = new Set();
    for (const raw of pool) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      const key = normalizeMatchKey(text);
      if (!key || key === q || key.length <= q.length || seen.has(key) || isAssistantOfferPhrase(text)) continue;
      seen.add(key);
      if (key.startsWith(q)) prefix.push(text);
      else if (key.includes(q)) substring.push(text);
      else if ([...q].length >= 2) {
        let at = 0;
        let ok = true;
        for (const ch of q) {
          if (ch === ' ') continue;
          const found = key.indexOf(ch, at);
          if (found < 0) { ok = false; break; }
          at = found + ch.length;
        }
        if (ok) fuzzy.push(text);
      }
    }
    return [...prefix, ...substring, ...fuzzy].slice(0, max);
  }

  function prefersReducedMotion(win = globalThis.window) {
    try { return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
  }

  // ---- loading state machine ----------------------------------------------------------------
  // idle -> loading -> ready | failed. Every begin() returns a token; results carrying an older
  // token are ignored, so a slow answer for a previous conversation never replaces a newer one.
  function createLoadingMachine({ onChange } = {}) {
    let phase = 'idle';
    let token = 0;
    let items = [];
    const emit = () => { try { onChange?.({ phase, token, items }); } catch {} };
    return {
      get phase() { return phase; },
      get token() { return token; },
      get items() { return items; },
      begin() {
        token += 1;
        phase = 'loading';
        items = [];
        emit();
        return token;
      },
      succeed(forToken, nextItems) {
        if (forToken !== token || phase !== 'loading') return false;
        items = Array.isArray(nextItems) ? nextItems.slice() : [];
        phase = 'ready';
        emit();
        return true;
      },
      fail(forToken) {
        if (forToken !== token || phase !== 'loading') return false;
        items = [];
        phase = 'failed';
        emit();
        return true;
      },
      /** Drops whatever is in flight (new conversation, blur, setting off). */
      reset() {
        token += 1;
        items = [];
        if (phase !== 'idle') {
          phase = 'idle';
          emit();
        }
      },
      isCurrent(forToken) { return forToken === token; },
    };
  }

  // ---- inline completion controller -----------------------------------------------------------
  // update() is called on every input change with the draft and the composer's state; the
  // controller decides whether to keep, drop, or (debounced) fetch a completion. `request`
  // receives ({ text, ...payload }, signal) and resolves to the /local/suggestions/complete body.
  function createCompletionController({
    request,
    debounceMs = COMPLETION_DEBOUNCE_MS,
    minChars = COMPLETION_MIN_CHARS,
    maxCache = 64,
    timeoutMs = COMPLETION_TIMEOUT_MS,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelSchedule = id => clearTimeout(id),
    onChange,
    onSettings,
  } = {}) {
    const cache = new Map();
    let ghost = '';
    let active = null;           // { context, base, full }
    let timer = null;
    let inflight = null;         // { seq, controller, timer }
    let seq = 0;
    let latest = null;           // the last update() input
    let acceptedFull = null;     // the draft right after accept(): no immediate re-request
    let dismissedText = null;    // Escape: no completion again until the draft changes
    const stats = { requests: 0, cancelled: 0, cacheHits: 0 };

    const setGhost = next => {
      const value = typeof next === 'string' ? next : '';
      if (value === ghost) return;
      ghost = value;
      try { onChange?.(ghost); } catch {}
    };
    const cacheKey = (context, text) => `${context}\u0000${text}`;
    const remember = (key, completion) => {
      cache.delete(key);
      cache.set(key, completion);
      while (cache.size > maxCache) cache.delete(cache.keys().next().value);
    };
    const abortInflight = () => {
      if (!inflight) return;
      try { inflight.controller?.abort(); } catch {}
      if (inflight.timer) clearTimeout(inflight.timer);
      inflight = null;
      stats.cancelled += 1;
    };
    const cancelPending = () => {
      if (timer !== null) { cancelSchedule(timer); timer = null; }
      abortInflight();
    };

    async function fire(input) {
      const mySeq = ++seq;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const killer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
      inflight = { seq: mySeq, controller, timer: killer, text: input.text, context: input.context };
      stats.requests += 1;
      let res = null;
      try {
        res = await request({ ...(input.payload ?? {}), text: input.text }, controller?.signal);
      } catch {
        res = null;
      } finally {
        if (killer) clearTimeout(killer);
        if (inflight?.seq === mySeq) inflight = null;
      }
      if (mySeq !== seq) return;              // a newer request replaced this one
      if (res && typeof res.enabled === 'boolean' && !res.enabled) {
        try { onSettings?.({ completionEnabled: false }); } catch {}
      }
      const raw = voiceSafeCompletion(input.text, typeof res?.completion === 'string' ? res.completion.replace(/[\r\n]+/g, ' ') : '');
      // A suffix that does not continue the draft (the model rewrote the sentence) is not shown.
      const completion = raw && completionFitsDraft(input.text, raw) ? raw : '';
      if (res?.source === 'model') remember(cacheKey(input.context, input.text), completion);
      // The draft moved on while waiting: only show the answer if it still applies.
      if (!latest || latest.context !== input.context || latest.text !== input.text) return;
      if (!completion) { setGhost(''); return; }
      active = { context: input.context, base: input.text, full: input.text + completion };
      setGhost(completion);
    }

    function update(input = {}) {
      const text = typeof input.text === 'string' ? input.text : '';
      const context = String(input.context ?? '');
      const previous = latest;
      latest = { text, context, payload: input.payload };
      // input.allowed: completionAllowed() of the composer (selection, /command, code, multi-line, sent).
      const gated = !input.enabled || input.composing || !input.hasHistory || input.caretAtEnd === false
        || input.allowed === false || countChars(text.trim()) < minChars;
      if (gated) {
        cancelPending();
        // Keep the prediction across a composition so it can come back if the user keeps typing it.
        if (!input.composing) active = null;
        setGhost('');
        return ghost;
      }
      if (dismissedText !== null) {
        if (text === dismissedText) { cancelPending(); setGhost(''); return ghost; }
        dismissedText = null;
      }
      // Same draft again (keyup after input, caret moves): let the pending request finish.
      if (previous && previous.text === text && previous.context === context
          && (timer !== null || (inflight && inflight.text === text && inflight.context === context))) {
        return ghost;
      }
      if (acceptedFull !== null) {
        if (text === acceptedFull) { cancelPending(); setGhost(''); return ghost; }
        acceptedFull = null;
      }
      // Typing along the prediction: keep the rest of it without asking again.
      if (active && active.context === context && text.length >= active.base.length
          && text.length < active.full.length && active.full.startsWith(text)) {
        cancelPending();
        setGhost(active.full.slice(text.length));
        return ghost;
      }
      active = null;
      setGhost('');
      const key = cacheKey(context, text);
      if (cache.has(key)) {
        cancelPending();
        stats.cacheHits += 1;
        const completion = cache.get(key);
        cache.delete(key);
        cache.set(key, completion);
        if (completion) {
          active = { context, base: text, full: text + completion };
          setGhost(completion);
        }
        return ghost;
      }
      cancelPending();
      const snapshot = { text, context, payload: input.payload };
      timer = schedule(() => { timer = null; void fire(snapshot); }, debounceMs);
      return ghost;
    }

    return {
      update,
      get ghost() { return ghost; },
      get stats() { return { ...stats, cacheSize: cache.size, pending: timer !== null, inflight: Boolean(inflight) }; },
      /** Returns the suffix to insert (or '') and forgets it. */
      accept() {
        const suffix = ghost;
        if (!suffix || !active) return '';
        acceptedFull = active.full;
        active = null;
        cancelPending();
        setGhost('');
        return suffix;
      },
      clear() {
        cancelPending();
        active = null;
        latest = null;
        setGhost('');
      },
      /** Escape: hide the completion and do not offer one again for this exact draft. */
      dismiss() {
        dismissedText = latest ? latest.text : null;
        cancelPending();
        active = null;
        setGhost('');
      },
      dispose() {
        cancelPending();
        cache.clear();
        active = null;
        latest = null;
        ghost = '';
      },
    };
  }

  // ---- when the strip is generated (no DOM) ----------------------------------------------------
  // The strip answers one state of the conversation: the Bot, its last message and the quotes in
  // the composer. It is generated only once the Bot is really idle (no Stop button, no working
  // badge, the transcript quiet for settleMs), never while a reply streams or a tool runs.

  /** Pending reply quotes of the composer -> a stable key ('' when there are none). */
  function quoteKeyOf(quotes) {
    const list = Array.isArray(quotes) ? quotes : [];
    return list.map(item => `${item?.id ?? ''}|${String(item?.text ?? '').replace(/\s+/g, ' ').trim()}`)
      .filter(entry => entry !== '|').join('\u001e');
  }

  function suggestionStateKey({ agentId = '', signature = '', quoteKey = '', lang = '' } = {}) {
    return `${agentId}:${signature}:${lang}${quoteKey ? `:q${quoteKey}` : ''}`;
  }

  /**
   * observe({ agentId, signature, busy }) after every change of the screen. Returns
   * { idle, waitMs }: idle is true once the Bot is not working and its transcript has not changed
   * for settleMs; otherwise waitMs tells when to look again (0 while busy: wait for the next change).
   * Opening another Bot's chat is not a turn ending: that chat is idle at once unless it is busy.
   */
  function createTurnGate({ settleMs = IDLE_SETTLE_MS, now = () => Date.now() } = {}) {
    let last = null;          // { agentId, signature, busy }
    let changedAt = -Infinity;
    return {
      observe({ agentId = '', signature = '', busy = false } = {}) {
        const t = now();
        if (!last || last.agentId !== agentId) changedAt = busy ? t : -Infinity;
        else if (busy || last.busy !== Boolean(busy) || last.signature !== signature) changedAt = t;
        last = { agentId, signature, busy: Boolean(busy) };
        if (busy) return { idle: false, waitMs: 0 };
        const elapsed = t - changedAt;
        return elapsed >= settleMs ? { idle: true, waitMs: 0 } : { idle: false, waitMs: Math.max(1, settleMs - elapsed) };
      },
      /** The Host answered "busy": the turn is still running whatever the screen shows. */
      markBusy() { changedAt = now(); if (last) last = { ...last, busy: false }; },
      get busy() { return Boolean(last?.busy); },
    };
  }

  /**
   * One generation per conversation state, and for one Bot at most one per minIntervalMs.
   * check(agentId, key) -> { allowed, waitMs }; record(agentId, key) after asking the Host.
   */
  function createGenerationLimiter({ minIntervalMs = REGENERATE_MIN_INTERVAL_MS, now = () => Date.now(), maxKeys = MAX_CLIENT_CACHE } = {}) {
    const done = new Set();
    const lastAt = new Map();
    return {
      check(agentId, key) {
        if (done.has(key)) return { allowed: false, waitMs: 0 };
        const previous = lastAt.get(agentId);
        const wait = previous === undefined ? 0 : minIntervalMs - (now() - previous);
        return wait > 0 ? { allowed: false, waitMs: wait } : { allowed: true, waitMs: 0 };
      },
      record(agentId, key) {
        done.delete(key);
        done.add(key);
        while (done.size > maxKeys) done.delete(done.values().next().value);
        lastAt.set(agentId, now());
      },
      /** A failed / busy answer may be asked again for the same state. */
      forget(key) { done.delete(key); },
      clear() { done.clear(); lastAt.clear(); },
    };
  }

  /** Texts the user sent a moment ago: never suggested again within ttlMs. */
  function createRecentSent({ ttlMs = RECENT_SENT_TTL_MS, now = () => Date.now(), max = 40 } = {}) {
    const items = new Map();
    const prune = () => {
      const t = now();
      for (const [key, at] of items) if (t - at >= ttlMs) items.delete(key);
      while (items.size > max) items.delete(items.keys().next().value);
    };
    return {
      add(text) { const key = normalizeMatchKey(text); if (!key) return; items.delete(key); items.set(key, now()); prune(); },
      has(text) { prune(); return items.has(normalizeMatchKey(text)); },
      filter(list) { prune(); return (Array.isArray(list) ? list : []).filter(text => !items.has(normalizeMatchKey(text))); },
    };
  }

  // ---- when a completion may show (no DOM) -------------------------------------------------------

  /** Inside a ``` fence that is not closed yet, or an open `inline code` span. */
  function inCodeBlock(text) {
    const value = String(text ?? '');
    const fences = value.match(/(^|\n)\s*(```|~~~)/g)?.length ?? 0;
    if (fences % 2 === 1) return true;
    const outsideFences = value.replace(/(```|~~~)[\s\S]*?(```|~~~)/g, '');
    const ticks = outsideFences.match(/`/g)?.length ?? 0;
    return ticks % 2 === 1;
  }

  /**
   * Whether inline completion (ghost text and the local match chips) may be offered for `text`.
   * Only at the end of a one-line draft with a collapsed caret, outside an IME composition, not a
   * /command, not inside code, and not a message the user already sent (recalled into the composer).
   * Returns { ok, reason }.
   */
  function completionAllowed({ text = '', caretAtEnd: atEnd = true, selectionCollapsed = true, composing = false,
    codeContext = false, sentTexts = [] } = {}) {
    const draft = String(text ?? '');
    if (composing) return { ok: false, reason: 'composing' };
    if (!selectionCollapsed) return { ok: false, reason: 'selection' };
    if (atEnd === false) return { ok: false, reason: 'caret' };
    if (/\n/.test(draft.replace(/\n+$/, ''))) return { ok: false, reason: 'multiline' };
    if (/^\s*\//.test(draft)) return { ok: false, reason: 'slash' };
    if (codeContext || inCodeBlock(draft)) return { ok: false, reason: 'code' };
    const key = normalizeMatchKey(draft);
    if (key && (Array.isArray(sentTexts) ? sentTexts : []).some(sent => normalizeMatchKey(sent) === key)) {
      return { ok: false, reason: 'sent' };
    }
    return { ok: true, reason: '' };
  }

  const startsWithUpper = text => /^[A-Z]/.test(text);

  /**
   * Whether a predicted suffix fits what was typed. A model that rewrites the sentence instead of
   * continuing it repeats the draft's opening ("帮我看下" + "帮你看下日志") or starts a new word in
   * the middle of one ("deplo" + "Run tests"): such a suffix is not shown.
   */
  function completionFitsDraft(draft, completion) {
    const typed = String(draft ?? '').replace(/\u200b/g, '');
    const suffix = String(completion ?? '');
    if (!suffix.trim() || /[\r\n]/.test(suffix)) return false;
    if (restatesDraft(typed, suffix)) return false;
    if (/[A-Za-z]$/.test(typed) && startsWithUpper(suffix)) return false;
    return true;
  }

  /**
   * The suffix opens like the draft and reuses most of its characters: a rewrite of the sentence
   * ("帮我看下" -> "帮你看下日志"), not its continuation. Same rule as the Host's completionFitsDraft.
   */
  function restatesDraft(draft, suffix) {
    const typed = [...normalizeMatchKey(draft).replace(/\s/g, '')];
    if (typed.length < 2) return false;
    const head = [...normalizeMatchKey(suffix).replace(/\s/g, '')].slice(0, typed.length);
    if (head.length < 2 || head[0] !== typed[0]) return false;
    const pool = new Set(typed);
    return head.filter(ch => pool.has(ch)).length / head.length >= 0.75;
  }

  /** Local match chips: the phrase has to start with (or contain) the draft, not just share its letters. */
  function matchFitsDraft(draft, text) {
    const q = normalizeMatchKey(draft);
    const key = normalizeMatchKey(text);
    return Boolean(q) && key !== q && key.includes(q);
  }

  // ---- composer DOM helpers ------------------------------------------------------------------

  function extractComposerText(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return String(input.value ?? '').replace(/​/g, '').trim();
    }
    return String(input.textContent ?? '').replace(/​/g, '').trim();
  }

  /** The draft as typed (not trimmed at the end, so "word " still predicts the next word). */
  function composerDraft(input) {
    if (!input) return '';
    let raw;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') raw = String(input.value ?? '');
    else raw = String((typeof input.innerText === 'string' ? input.innerText : input.textContent) ?? '');
    return raw.replace(/​/g, '').replace(/ /g, ' ').replace(/\n+$/, '').replace(/^\s+/, '');
  }

  function insertSuggestionText(input, text, doc = globalThis.document) {
    if (!input || typeof text !== 'string' || !text) return false;
    try { input.focus?.(); } catch {}
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA'
        ? globalThis.HTMLTextAreaElement?.prototype
        : globalThis.HTMLInputElement?.prototype;
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent?.(new Event('input', { bubbles: true }));
      return true;
    }
    try {
      const selection = doc?.getSelection?.();
      if (selection && typeof doc?.createRange === 'function') {
        const range = doc.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (typeof doc?.execCommand === 'function' && doc.execCommand('insertText', false, text)) {
        return true;
      }
    } catch {}
    try {
      if (typeof InputEvent === 'function') {
        input.dispatchEvent?.(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      }
    } catch {}
    if (extractComposerText(input) !== text) input.textContent = text;
    input.dispatchEvent?.(new Event('input', { bubbles: true }));
    return true;
  }

  /** Inserts `suffix` at the end of the draft (the caret is there when a completion shows). */
  function appendComposerText(input, suffix, doc = globalThis.document) {
    if (!input || typeof suffix !== 'string' || !suffix) return false;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const next = String(input.value ?? '') + suffix;
      const proto = input.tagName === 'TEXTAREA' ? globalThis.HTMLTextAreaElement?.prototype : globalThis.HTMLInputElement?.prototype;
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      if (setter) setter.call(input, next); else input.value = next;
      try { input.setSelectionRange?.(next.length, next.length); } catch {}
      input.dispatchEvent?.(new Event('input', { bubbles: true }));
      return true;
    }
    try { input.focus?.(); } catch {}
    try {
      const selection = doc?.getSelection?.();
      if (selection && typeof doc?.createRange === 'function') {
        const range = doc.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (typeof doc?.execCommand === 'function' && doc.execCommand('insertText', false, suffix)) return true;
    } catch {}
    try {
      if (typeof InputEvent === 'function') {
        const ev = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: suffix });
        input.dispatchEvent?.(ev);
        if (ev.defaultPrevented) return true;
      }
    } catch {}
    input.textContent = `${input.textContent ?? ''}${suffix}`;
    input.dispatchEvent?.(new Event('input', { bubbles: true }));
    return true;
  }

  function findSendButton(form) {
    if (!form || typeof form.querySelectorAll !== 'function') return null;
    for (const btn of form.querySelectorAll('button.sand-prompt-send, button[type="submit"], button[aria-label]')) {
      if (btn.disabled || btn.getAttribute?.('aria-disabled') === 'true') continue;
      const label = String(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
      const isSendLabel = label.includes('send') || label.includes('发送') || label.includes('傳送');
      const isSubmit = btn.type === 'submit' || btn.getAttribute?.('type') === 'submit';
      if (isSendLabel || isSubmit) {
        if (label.includes('stop') || label.includes('停止') || label.includes('voice') || label.includes('语音') || label.includes('mic')) continue;
        return btn;
      }
    }
    return null;
  }

  function sendSuggestionText(form, input, text, doc = globalThis.document, { schedule = fn => setTimeout(fn, 24) } = {}) {
    if (!insertSuggestionText(input, text, doc)) return false;
    const trySubmit = (attempt = 0) => {
      const btn = findSendButton(form);
      if (btn) { btn.click(); return true; }
      if (attempt < 4 && typeof schedule === 'function') { schedule(() => trySubmit(attempt + 1)); return false; }
      try { if (typeof form?.requestSubmit === 'function') { form.requestSubmit(); return true; } } catch {}
      try {
        if (typeof KeyboardEvent === 'function') {
          input.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          return true;
        }
      } catch {}
      return false;
    };
    if (typeof schedule === 'function') schedule(() => trySubmit(0));
    else trySubmit(0);
    return true;
  }

  const findComposerInput = form => form?.querySelector('[contenteditable="true"], textarea, input[type="text"]') ?? null;

  // The Bot on screen: what the official renderer reported (setViewingAgent) or a link opened wins
  // over the sidebar, which can lag behind or be hidden (phone layout).
  function currentAgentId(doc, getViewingAgentId) {
    const tracked = typeof getViewingAgentId === 'function' ? getViewingAgentId() : '';
    if (typeof tracked === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(tracked)) return tracked;
    for (const sel of [
      '.sand-agents-sidebar .sand-agent-item[aria-current="page"]',
      '.sand-agents-sidebar .sand-agent-item[data-active="true"]',
      '.sand-agents-sidebar .sand-agent-item[aria-selected="true"]',
      '.sand-agents-sidebar .sand-agent-item[aria-pressed="true"]',
    ]) {
      const id = doc.querySelector(sel)?.dataset?.agentId;
      if (id) return id;
    }
    return '';
  }

  /**
   * Whether an answer may be shown: it was requested for the chat still on screen (same key and
   * Bot), it is the latest request, and the Host says it belongs to that Bot.
   */
  function acceptSuggestionResponse({ requestedKey, currentKey, requestedAgentId, currentAgentId: agentNow,
    requestSeq, latestSeq, response }) {
    if (requestedKey !== currentKey || requestedAgentId !== agentNow) return false;
    if (Number.isFinite(latestSeq) && requestSeq !== latestSeq) return false;
    if (response && typeof response.agentId === 'string' && response.agentId !== requestedAgentId) return false;
    return true;
  }

  // The official composer shows a pending reply as .sand-prompt-reply-pill (a .sand-reply-quote
  // with the quoted text in .sand-reply-quote__body); a sent message that replied shows the same
  // .sand-reply-quote above its text.
  const QUOTE_PILL_SELECTOR = '.sand-prompt-reply-pill, .sand-reply-quote-pill';
  const QUOTE_IN_MESSAGE_SELECTOR = '.sand-reply-quote, .sand-reply-quote-pill, .sand-prompt-reply-pill';

  /** The quotes waiting in the composer: [{ id, text }] (what the next message replies to). */
  function readComposerQuotes(doc, form = doc?.querySelector?.('.sand-prompt-form')) {
    const scope = form?.parentElement ?? form ?? null;
    if (!scope || typeof scope.querySelectorAll !== 'function') return [];
    const out = [];
    const seen = new Set();
    for (const pill of scope.querySelectorAll(QUOTE_PILL_SELECTOR)) {
      if (pill.closest?.('.rokbot-suggestions')) continue;
      const body = pill.querySelector?.('.sand-reply-quote__body') ?? pill;
      const text = String(body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_CHARS);
      const id = String(pill.getAttribute?.('data-reply-to-id') || pill.getAttribute?.('data-entry-id') || '').slice(0, 128);
      const key = `${id}|${text}`;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...(id ? { id } : {}), text });
      if (out.length >= MAX_QUOTES) break;
    }
    return out;
  }

  /** Text of a message without the quote it replied to: a quote is never the user's own words. */
  function messageTextWithoutQuote(el) {
    if (!el) return '';
    if (typeof el.querySelector === 'function' && el.querySelector(QUOTE_IN_MESSAGE_SELECTOR) && typeof el.cloneNode === 'function') {
      const copy = el.cloneNode(true);
      for (const node of copy.querySelectorAll(QUOTE_IN_MESSAGE_SELECTOR)) node.remove();
      return String(copy.textContent ?? '');
    }
    return String(el.textContent ?? '');
  }

  /** The sidebar row of this Bot shows the working badge (a tool call, a background step). */
  function agentWorking(doc, agentId) {
    if (!agentId || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) return false;
    try {
      return Boolean(doc.querySelector(`.sand-agents-sidebar .sand-agent-item[data-agent-id="${agentId}"] .sand-kit-working-badge`));
    } catch { return false; }
  }

  function selectionCollapsed(input, doc) {
    if (!input) return true;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.selectionStart === input.selectionEnd;
    try {
      const sel = doc.getSelection?.();
      return !sel || sel.rangeCount === 0 || sel.isCollapsed !== false;
    } catch { return true; }
  }

  /** The caret is inside a code block / inline code of a rich composer. */
  function caretInCode(input, doc) {
    if (!input || input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return false;
    try {
      const sel = doc.getSelection?.();
      if (!sel || sel.rangeCount === 0) return false;
      let node = sel.getRangeAt(0).endContainer;
      if (node && node.nodeType !== 1) node = node.parentElement;
      const code = node?.closest?.('pre, code, [data-code-block]');
      return Boolean(code && input.contains(code));
    } catch { return false; }
  }

  function extractVisibleMessages(doc) {
    const transcript = doc.querySelector('.sand-virtual-transcript');
    if (!transcript) return [];
    const anchors = [...transcript.querySelectorAll('.sand-message-action-anchor[data-role], [data-role="user"], [data-role="assistant"]')];
    const out = [];
    for (const el of anchors.slice(-6)) {
      const rawRole = String(el.getAttribute('data-role') || '').toLowerCase();
      const role = rawRole === 'user' ? 'user' : (['assistant', 'agent', 'bot'].includes(rawRole) ? 'assistant' : '');
      if (!role) continue;
      const text = (role === 'user' ? messageTextWithoutQuote(el) : (el.textContent || '')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({ id: el.getAttribute('data-entry-id') || el.getAttribute('data-message-id') || '', role, text: text.slice(0, 500) });
    }
    return out;
  }

  // streaming: a turn of the Bot on screen is running — a reply streams (Stop button in the
  // composer) or the Bot works without one on screen (the working badge on its sidebar row).
  function inspectTranscript(doc, agentId = '') {
    const transcript = doc.querySelector('.sand-virtual-transcript');
    const stopBtn = doc.querySelector('.sand-prompt-form button[aria-label*="Stop" i], .sand-prompt-form button[aria-label*="停止"]');
    const streaming = Boolean(stopBtn) || agentWorking(doc, agentId);
    if (!transcript) return { hasHistory: false, signature: 'empty', lastEntryId: '', streaming, recentMessages: [] };
    const items = [...transcript.querySelectorAll('[data-entry-id], [data-message-id], .sand-transcript-row, article, [role="article"]')];
    if (items.length === 0) {
      const raw = (transcript.textContent || '').trim();
      if (!raw) return { hasHistory: false, signature: 'empty', lastEntryId: '', streaming, recentMessages: [] };
      return { hasHistory: true, signature: `txt:${raw.length}:${raw.slice(-48)}`, lastEntryId: '', streaming, recentMessages: extractVisibleMessages(doc) };
    }
    const last = items[items.length - 1];
    const entryId = last.getAttribute('data-entry-id') || last.getAttribute('data-message-id') || '';
    const tailText = (last.textContent || '').replace(/\s+/g, ' ').trim().slice(-64);
    return { hasHistory: true, signature: `${items.length}:${entryId || tailText}`, lastEntryId: entryId, streaming, recentMessages: extractVisibleMessages(doc) };
  }

  /** If the conversation is scrolled to its end, returns a function that scrolls it back there. */
  function transcriptBottomPin(doc) {
    let node = doc.querySelector('.sand-virtual-transcript');
    while (node && node !== doc.body) {
      const style = doc.defaultView?.getComputedStyle?.(node);
      if (style && /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) break;
      node = node.parentElement;
    }
    if (!node || node === doc.body) return null;
    const scroller = node;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 48) return null;
    return () => { scroller.scrollTop = scroller.scrollHeight; };
  }

  function isInputFocused(input, doc) {
    const active = doc?.activeElement;
    return Boolean(input && active && (active === input || (typeof input.contains === 'function' && input.contains(active))));
  }

  /** Collapsed selection at the very end of the composer's text. */
  function caretAtEnd(input, doc) {
    if (!input) return false;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const len = String(input.value ?? '').length;
      return input.selectionStart === len && input.selectionEnd === len;
    }
    try {
      const sel = doc.getSelection?.();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
      const range = sel.getRangeAt(0);
      if (!input.contains(range.endContainer)) return false;
      const tail = doc.createRange();
      tail.selectNodeContents(input);
      tail.setStart(range.endContainer, range.endOffset);
      return tail.toString().replace(/[​\s]/g, '') === '';
    } catch {
      return false;
    }
  }

  /** Viewport rectangle of the caret (falls back to the end of the input's content box). */
  function caretRect(input, doc) {
    try {
      const sel = doc.getSelection?.();
      if (sel && sel.rangeCount > 0 && input.contains(sel.getRangeAt(0).endContainer)) {
        const range = sel.getRangeAt(0).cloneRange();
        range.collapse(false);
        let rect = range.getClientRects?.()[0] || range.getBoundingClientRect?.();
        if (!rect || (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0)) {
          const node = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
          const box = node?.getBoundingClientRect?.();
          if (box) rect = { left: box.left, top: box.top, height: box.height, right: box.left };
        }
        if (rect) return { left: rect.left, top: rect.top, height: rect.height || 18 };
      }
    } catch {}
    return null;
  }

  // A mention/command menu of the editor owns Tab and the arrows while it is open.
  function editorMenuOpen(doc) {
    const nodes = doc.querySelectorAll('[role="listbox"], [role="menu"], .sand-prompt-menu, [data-floating-ui-portal] [role="option"]');
    for (const node of nodes) {
      if (node.closest?.('.rokbot-suggestions')) continue;
      if (node.getClientRects?.().length) return true;
    }
    return false;
  }

  // ---- composer strip + ghost text ------------------------------------------------------------

  function installComposerSuggestions({
    request,
    locale = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    getViewingAgentId,
    installSettings = true,
    document: doc = globalThis.document,
    window: win = globalThis.window,
  } = {}) {
    if (!doc || typeof request !== 'function') return () => {};
    const zhNow = () => isZhLocale(doc.documentElement.lang || locale);
    const motion = () => !prefersReducedMotion(win);

    const aiCache = new Map();
    // Same keys: the user's frequent messages for that chat; per Bot: the local completion pool.
    const frequentCache = new Map();
    const candidatesByAgent = new Map();
    let barSignature = '';
    let barLeavingTimer = 0;
    let settingsState = normalizeSettings({});
    let settingsSyncedAt = 0;
    let settingsInFlight = null;
    let bar = null;
    let currentKey = '';
    let dismissedKey = '';
    let failedKey = '';          // a failed request is not retried until the conversation changes
    let activeAiSuggestions = [];
    let debounceTimer = 0;
    let observedInput = null;
    let observedForm = null;
    let composerFocused = false;
    let suppressUntilRefocus = false;
    let composing = false;
    let settingsUi = null;
    let revealOnNextRender = false;
    let leavingTimer = 0;
    // Turn state: nothing is generated or refreshed while the Bot works (createTurnGate).
    const turnGate = createTurnGate();
    const generations = createGenerationLimiter();
    const recentSent = createRecentSent();
    let busyNow = false;
    let settleTimer = 0;
    let currentQuotes = [];
    const busyRetries = new Map();

    const loading = createLoadingMachine({
      onChange: ({ phase }) => {
        if (phase === 'ready') revealOnNextRender = true;
        if (phase === 'failed') fadeOutSkeleton();
        else renderBar();
      },
    });

    const setCachedAi = (key, items) => {
      aiCache.delete(key);
      aiCache.set(key, items);
      while (aiCache.size > MAX_CLIENT_CACHE) aiCache.delete(aiCache.keys().next().value);
    };

    const syncSettings = async (force = false) => {
      if (!force && settingsSyncedAt && Date.now() - settingsSyncedAt < SETTINGS_SYNC_TTL_MS) return settingsState;
      if (settingsInFlight) return settingsInFlight;
      settingsInFlight = (async () => {
        try {
          settingsState = normalizeSettings(await request('/local/suggestions/settings', null, undefined, 'GET'));
          settingsSyncedAt = Date.now();
          settingsUi?.updateState(settingsState);
        } catch {}
        return settingsState;
      })().finally(() => { settingsInFlight = null; });
      return settingsInFlight;
    };

    const ensureBar = () => {
      if (bar) return bar;
      bar = doc.createElement('div');
      bar.className = 'rokbot-suggestions';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', t(zhNow(), '输入建议', 'Suggested replies'));
      bar.hidden = true;
      // Keep the composer focused when a pill or the close button is pressed.
      bar.addEventListener('mousedown', ev => { ev.preventDefault(); });
      return bar;
    };

    const computeVisibleItems = () => {
      if (!settingsState.enabled) return [];
      // While the Bot works only the user's own quick phrases show: no AI items of the previous
      // state, no placeholders, nothing that changes with every streamed row.
      if (busyNow) return mergeSuggestionItems(settingsState.quickPhrases, [], []);
      const frequent = settingsState.learningEnabled ? recentSent.filter(frequentCache.get(currentKey) ?? []) : [];
      return mergeSuggestionItems(settingsState.quickPhrases, settingsState.aiEnabled ? recentSent.filter(activeAiSuggestions) : [], frequent);
    };

    /** completionAllowed() for the composer as it is now. */
    const completionGate = (input, draft) => {
      const state = inspectTranscript(doc, currentAgentId(doc, getViewingAgentId));
      const sentTexts = (state.recentMessages ?? []).filter(item => item.role === 'user').map(item => item.text);
      const verdict = completionAllowed({
        text: draft,
        caretAtEnd: caretAtEnd(input, doc),
        selectionCollapsed: selectionCollapsed(input, doc),
        composing,
        codeContext: caretInCode(input, doc),
        sentTexts,
      });
      if (verdict.ok && recentSent.has(draft)) return { ok: false, reason: 'sent' };
      return verdict;
    };

    const localMatchItems = (draft, input) => {
      if (!settingsState.enabled || !settingsState.localCompletionEnabled || completion.ghost) return [];
      if (!completionGate(input, composerDraft(input) || draft).ok) return [];
      const agentId = currentAgentId(doc, getViewingAgentId);
      const pool = [...settingsState.quickPhrases.map(item => item.text), ...(candidatesByAgent.get(agentId) ?? [])];
      return matchCompletions(draft, pool, 3).filter(text => matchFitsDraft(draft, text)).map(text => ({ type: 'match', text }));
    };

    // Tap / dismiss -> the Host's habit learning (best effort, never blocks the UI).
    const sendFeedback = (action, text, items) => {
      if (!settingsState.learningEnabled) return;
      const agentId = currentAgentId(doc, getViewingAgentId);
      if (!agentId) return;
      const shown = items.filter(item => item.type === 'ai' || item.type === 'frequent').map(item => item.text);
      if (action === 'dismiss' && !shown.length) return;
      try {
        void Promise.resolve(request('/local/suggestions/feedback', { agentId, action, text, shown }, undefined, 'POST')).catch(() => {});
      } catch {}
    };

    // Hide with a short fade + 3px drop (instant with reduced motion); a show in between cancels it.
    const hideBarAnimated = el => {
      if (el.hidden) return;
      if (!motion()) { el.hidden = true; el.classList.remove('rokbot-suggestions--leaving'); barSignature = ''; return; }
      if (el.classList.contains('rokbot-suggestions--leaving')) return;
      el.classList.remove('rokbot-suggestions--enter', 'rokbot-suggestions--swap');
      el.classList.add('rokbot-suggestions--leaving');
      clearTimeout(barLeavingTimer);
      barLeavingTimer = setTimeout(() => {
        if (!el.classList.contains('rokbot-suggestions--leaving')) return;
        el.classList.remove('rokbot-suggestions--leaving');
        el.hidden = true;
        barSignature = '';
      }, BAR_FADE_MS);
    };

    function skeletonList(count = 3) {
      const wrap = doc.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const pill = doc.createElement('span');
        pill.className = 'rokbot-suggestions__skeleton';
        pill.style.width = `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}px`;
        pill.style.setProperty('--rokbot-skeleton-delay', `${i * 120}ms`);
        pill.setAttribute('aria-hidden', 'true');
        wrap.appendChild(pill);
      }
      return wrap;
    }

    function fadeOutSkeleton() {
      if (!bar) { renderBar(); return; }
      const pills = [...bar.querySelectorAll('.rokbot-suggestions__skeleton')];
      if (!pills.length || !motion()) { renderBar(); return; }
      for (const pill of pills) pill.classList.add('rokbot-suggestions__skeleton--leaving');
      clearTimeout(leavingTimer);
      leavingTimer = setTimeout(() => renderBar(), 200);
    }

    function renderBar() {
      const form = doc.querySelector('.sand-prompt-form');
      if (!form || !form.parentElement) { if (bar) bar.hidden = true; return; }
      const el = ensureBar();
      if (el.parentElement !== form.parentElement || el.nextElementSibling !== form) form.parentElement.insertBefore(el, form);
      const input = findComposerInput(form);
      attachComposerListeners(form, input);

      const focusedNow = !suppressUntilRefocus && (composerFocused || isInputFocused(input, doc));
      const draftText = extractComposerText(input);
      const hasDraft = draftText.length > 0;
      const matchMode = hasDraft && focusedNow;
      const items = matchMode ? localMatchItems(draftText, input) : computeVisibleItems();
      const showSkeleton = !matchMode && !busyNow && loading.phase === 'loading' && settingsState.enabled && settingsState.aiEnabled;
      if (!focusedNow || !settingsState.enabled || (!matchMode && dismissedKey === currentKey)
        || (matchMode && dismissedKey === `match:${draftText}`) || (items.length === 0 && !showSkeleton)) {
        hideBarAnimated(el);
        el.removeAttribute('aria-busy');
        return;
      }
      const signature = `${showSkeleton ? 'S' : ''}${items.map(item => `${item.type}=${item.text}`).join('\u001f')}`;
      const wasHidden = el.hidden || el.classList.contains('rokbot-suggestions--leaving');
      if (!wasHidden && signature === barSignature) return;   // nothing changed: no re-render, no motion
      const zh = zhNow();
      // The strip takes room above the composer: keep the last message in view when it appears.
      const pin = el.hidden ? transcriptBottomPin(doc) : null;
      el.setAttribute('aria-label', t(zh, '输入建议', 'Suggested replies'));
      if (showSkeleton) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
      clearTimeout(barLeavingTimer);
      el.classList.remove('rokbot-suggestions--leaving', 'rokbot-suggestions--enter', 'rokbot-suggestions--swap');
      if (motion()) {
        // Appear: fade in + 3px rise. Another set of items (not the skeleton -> chips reveal): soft swap.
        const swapped = !wasHidden && barSignature && !barSignature.startsWith('S') && !showSkeleton;
        if (wasHidden || swapped) {
          void el.offsetWidth;
          el.classList.add(wasHidden ? 'rokbot-suggestions--enter' : 'rokbot-suggestions--swap');
        }
      }
      barSignature = signature;
      el.hidden = false;
      el.textContent = '';
      clearTimeout(leavingTimer);

      const scroller = doc.createElement('div');
      scroller.className = 'rokbot-suggestions__list';
      const reveal = revealOnNextRender && motion();
      revealOnNextRender = false;
      let aiIndex = 0;
      for (const item of items) {
        const chip = doc.createElement('button');
        chip.type = 'button';
        chip.className = `rokbot-suggestions__chip rokbot-suggestions__chip--${item.type}`;
        chip.dataset.suggestionType = item.type;
        if (reveal && item.type === 'ai') {
          chip.classList.add('rokbot-suggestions__chip--enter');
          chip.style.setProperty('--rokbot-enter-delay', `${aiIndex++ * 45}ms`);
        }
        const iconSpan = doc.createElement('span');
        iconSpan.className = 'rokbot-suggestions__chip-icon';
        iconSpan.innerHTML = item.type === 'ai' ? ICONS.sparkle : ICONS.phrase;
        const labelSpan = doc.createElement('span');
        labelSpan.className = 'rokbot-suggestions__chip-text';
        labelSpan.textContent = item.text;
        chip.append(iconSpan, labelSpan);
        if (item.type === 'match') {
          chip.title = t(zh, '填入输入框', 'Fill the input');
          // Local completion: replace the draft, do not send.
          chip.addEventListener('click', () => {
            const liveForm = doc.querySelector('.sand-prompt-form');
            completion.clear();
            hideGhost();
            insertSuggestionText(findComposerInput(liveForm), item.text, doc);
            barSignature = '';
            el.hidden = true;
          });
          scroller.appendChild(chip);
          continue;
        }
        chip.addEventListener('click', () => {
          const liveForm = doc.querySelector('.sand-prompt-form');
          if (item.type !== 'phrase') sendFeedback('tap', item.text, items);
          recentSent.add(item.text);
          composerFocused = false;
          suppressUntilRefocus = true;
          el.hidden = true;
          barSignature = '';
          completion.clear();
          sendSuggestionText(liveForm, findComposerInput(liveForm), item.text, doc);
        });
        scroller.appendChild(chip);
      }
      if (showSkeleton) {
        const status = doc.createElement('span');
        status.className = 'rokbot-suggestions__status';
        status.setAttribute('role', 'status');
        status.textContent = t(zh, '正在生成建议', 'Generating suggestions');
        scroller.append(skeletonList(3), status);
      }
      el.appendChild(scroller);

      const dismiss = doc.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'rokbot-suggestions__dismiss';
      dismiss.setAttribute('aria-label', t(zh, '隐藏建议', 'Dismiss suggestions'));
      dismiss.innerHTML = ICONS.close;
      dismiss.addEventListener('click', () => {
        if (matchMode) { dismissedKey = `match:${draftText}`; renderBar(); return; }
        sendFeedback('dismiss', '', items);
        dismissedKey = currentKey;
        loading.reset();
        renderBar();
      });
      el.appendChild(dismiss);
      pin?.();
    }

    // One request per chat state, shared by the background prefetch and the focused composer.
    const pendingAi = new Map();
    const prefetchFailed = new Set();
    let requestSeq = 0;
    let foregroundSeq = 0;
    let prefetchTimer = 0;
    let recheckTimer = 0;
    // The Host still saw the turn running: look again later, a bounded number of times per state.
    const MAX_BUSY_RETRIES = 30;

    const recheckSoon = ms => {
      clearTimeout(recheckTimer);
      recheckTimer = setTimeout(() => triggerIfFocused(), Math.max(50, ms));
    };

    function requestAi(agentId, state, key, quotes = []) {
      const existing = pendingAi.get(key);
      if (existing) return existing;
      generations.record(agentId, key);
      const requestId = `s${Date.now().toString(36)}-${++requestSeq}`;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      const task = (async () => {
        try {
          const res = await request('/local/suggestions', {
            agentId,
            lastEntryId: state.lastEntryId || '',
            requestId,
            locale: doc.documentElement.lang || locale || globalThis.navigator?.language || '',
            // Without a Bot ID the screen is the only context; with one the Host reads that Bot's
            // own transcript (the screen may still show the previous Bot right after a switch).
            ...(!agentId && state.recentMessages?.length ? { recentMessages: state.recentMessages } : {}),
            // What the next message replies to: context for the answer, never the user's own words.
            ...(quotes.length ? { quotes } : {}),
          }, controller?.signal, 'POST');
          // An answer for another Bot (or another request) is never used, not even cached.
          if (res && typeof res.agentId === 'string' && res.agentId !== agentId) return { ok: false, res: null };
          if (res && typeof res.requestId === 'string' && res.requestId && res.requestId !== requestId) return { ok: false, res: null };
          // The Host found the Bot still working (a tool call after the reply on screen): nothing
          // was generated; this state is asked again once the turn is really over.
          if (res?.source === 'busy') return { ok: false, busy: true, items: [], res };
          if (res && typeof res.enabled === 'boolean') {
            settingsState = normalizeSettings({
              ...settingsState,
              enabled: res.enabled,
              aiEnabled: res.aiEnabled,
              quickPhrases: res.quickPhrases ?? settingsState.quickPhrases,
            });
            settingsSyncedAt = Date.now();
            settingsUi?.updateState(settingsState);
          }
          const items = Array.isArray(res?.aiSuggestions)
            ? res.aiSuggestions.filter(item => typeof item === 'string' && item.trim() && !isAssistantOfferPhrase(item)).slice(0, MAX_AI_SUGGESTIONS)
            : [];
          if (Array.isArray(res?.frequentSuggestions)) {
            frequentCache.delete(key);
            frequentCache.set(key, res.frequentSuggestions.filter(item => typeof item === 'string' && item.trim() && !isAssistantOfferPhrase(item)).slice(0, MAX_AI_SUGGESTIONS));
            while (frequentCache.size > MAX_CLIENT_CACHE) frequentCache.delete(frequentCache.keys().next().value);
          }
          if (Array.isArray(res?.completionCandidates)) {
            candidatesByAgent.set(agentId, res.completionCandidates.filter(item => typeof item === 'string' && item.trim() && !isAssistantOfferPhrase(item)).slice(0, 60));
          }
          if (res && (typeof res.learningEnabled === 'boolean' || typeof res.localCompletionEnabled === 'boolean')) {
            settingsState = normalizeSettings({ ...settingsState,
              learningEnabled: res.learningEnabled ?? settingsState.learningEnabled,
              localCompletionEnabled: res.localCompletionEnabled ?? settingsState.localCompletionEnabled });
          }
          const ok = res?.source === 'model' && items.length > 0;
          if (ok) setCachedAi(key, items);
          return { ok, items, res };
        } catch {
          return { ok: false, res: null };
        } finally {
          clearTimeout(timer);
          pendingAi.delete(key);
        }
      })();
      pendingAi.set(key, task);
      return task;
    }

    /** The Host said the Bot is still working: forget the attempt and look again after the turn. */
    function onHostBusy(key) {
      generations.forget(key);
      turnGate.markBusy();
      // Busy until the recheck: the strip keeps the quick phrases only, and the recheck counts as a
      // turn ending (it prepares the answer again even while the composer is not focused).
      busyNow = true;
      renderBar();
      const count = (busyRetries.get(key) ?? 0) + 1;
      busyRetries.delete(key);
      busyRetries.set(key, count);
      while (busyRetries.size > MAX_CLIENT_CACHE) busyRetries.delete(busyRetries.keys().next().value);
      if (count <= MAX_BUSY_RETRIES) recheckSoon(IDLE_SETTLE_MS + REGENERATE_MIN_INTERVAL_MS);
    }

    /** Whether this state may be generated now: { wanted, waitMs } (waitMs: the per-Bot interval). */
    function generationWanted(agentId, state, key) {
      if (busyNow || !settingsState.enabled || !settingsState.aiEnabled || !state.hasHistory) return { wanted: false, waitMs: 0 };
      if (aiCache.has(key) || pendingAi.has(key) || (busyRetries.get(key) ?? 0) > MAX_BUSY_RETRIES) return { wanted: false, waitMs: 0 };
      const verdict = generations.check(agentId, key);
      return { wanted: verdict.allowed, waitMs: verdict.waitMs };
    }

    /** The composer's chat state as it is now. */
    function snapshot() {
      const form = doc.querySelector('.sand-prompt-form');
      const agentId = currentAgentId(doc, getViewingAgentId);
      const state = inspectTranscript(doc, agentId);
      const quotes = readComposerQuotes(doc, form);
      const key = suggestionStateKey({ agentId, signature: state.signature, quoteKey: quoteKeyOf(quotes), lang: zhNow() ? 'zh' : 'en' });
      return { form, agentId, state, quotes, key };
    }

    // Prepares the answer of an idle state in the background (the turn ended, a quote changed,
    // another chat opened) so focusing the composer shows it at once. Never while the Bot works.
    function schedulePrefetch() {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => {
        if (busyNow || !settingsSyncedAt) return;
        const { agentId, state, quotes, key } = snapshot();
        if (key !== currentKey || state.streaming || prefetchFailed.has(key)) return;
        const want = generationWanted(agentId, state, key);
        if (!want.wanted) { if (want.waitMs > 0) recheckSoon(want.waitMs); return; }
        void requestAi(agentId, state, key, quotes).then(result => {
          if (result.busy) { onHostBusy(key); return; }
          if (!result.ok) {
            generations.forget(key);
            prefetchFailed.add(key);
            if (prefetchFailed.size > MAX_CLIENT_CACHE) prefetchFailed.delete(prefetchFailed.values().next().value);
          }
          // Prepared while the composer was already focused: show it now.
          if (result.ok && key === currentKey && !busyNow && composerFocused && loading.phase !== 'loading') {
            activeAiSuggestions = result.items;
            revealOnNextRender = true;
            renderBar();
          }
        });
      }, PREFETCH_DEBOUNCE_MS);
    }

    async function fetchSuggestions(agentId, state, key, quotes = []) {
      const cfg = await syncSettings(false);
      if (!composerFocused || key !== currentKey || busyNow) return;
      if (!cfg.enabled || !cfg.aiEnabled || !state.hasHistory) { activeAiSuggestions = []; loading.reset(); renderBar(); return; }
      const cached = aiCache.get(key);
      if (cached) { activeAiSuggestions = cached; loading.reset(); renderBar(); return; }
      if (loading.phase === 'loading') return;
      const token = loading.begin();
      const seq = ++foregroundSeq;
      const result = await requestAi(agentId, state, key, quotes);
      if (!loading.isCurrent(token)) return;
      const accepted = acceptSuggestionResponse({
        requestedKey: key, currentKey, requestedAgentId: agentId, currentAgentId: currentAgentId(doc, getViewingAgentId),
        requestSeq: seq, latestSeq: foregroundSeq, response: result.res,
      });
      if (!accepted) { loading.reset(); renderBar(); return; }
      if (result.busy) { loading.reset(); onHostBusy(key); renderBar(); return; }
      if (result.ok) {
        activeAiSuggestions = result.items;
        loading.succeed(token, result.items);
      } else {
        // Nothing usable: the placeholders fade away silently; quick phrases stay.
        activeAiSuggestions = [];
        failedKey = key;
        generations.forget(key);
        loading.fail(token);
      }
    }

    function triggerIfFocused() {
      const form = doc.querySelector('.sand-prompt-form');
      if (!form) { if (bar) bar.hidden = true; hideGhost(); return; }
      const input = findComposerInput(form);
      attachComposerListeners(form, input);
      const { agentId, state, quotes, key: nextKey } = snapshot();
      const turn = turnGate.observe({ agentId, signature: state.signature, busy: state.streaming });
      const wasBusy = busyNow;
      busyNow = !turn.idle;
      clearTimeout(settleTimer);
      const keyChanged = nextKey !== currentKey;
      if (keyChanged) {
        // Another Bot, a new message, a quote added or removed: the old answer is gone at once.
        currentKey = nextKey;
        currentQuotes = quotes;
        activeAiSuggestions = aiCache.get(nextKey) ?? [];
        failedKey = '';
        loading.reset();
      }
      if (busyNow) {
        // The Bot is working (streaming, a tool call, the screen not quiet yet): no generation, no
        // prefetch, no refresh. Look again once the screen has been quiet for the settle time.
        clearTimeout(debounceTimer);
        clearTimeout(prefetchTimer);
        if (loading.phase === 'loading') loading.reset();
        if (turn.waitMs > 0) settleTimer = setTimeout(triggerIfFocused, turn.waitMs);
        renderBar();
        return;
      }
      // Idle: the turn ended (generated once more), a quote changed, or another chat opened.
      if (keyChanged || wasBusy) schedulePrefetch();
      // Prepared in the background (prefetch) since the chat was opened.
      const prepared = aiCache.get(currentKey);
      if (prepared && activeAiSuggestions !== prepared && loading.phase !== 'loading') activeAiSuggestions = prepared;
      const focusedNow = !suppressUntilRefocus && (composerFocused || isInputFocused(input, doc));
      // One round only while the composer is focused and empty.
      if (!focusedNow || extractComposerText(input).length > 0 || dismissedKey === currentKey) { renderBar(); return; }
      renderBar();
      clearTimeout(debounceTimer);
      const key = currentKey;
      const keyQuotes = currentQuotes;
      const wanted = () => {
        if (key !== currentKey || busyNow || failedKey === key || loading.phase === 'loading') return false;
        if (pendingAi.has(key)) return true;   // a prefetch is on its way: show the placeholders and join it
        const want = generationWanted(agentId, state, key);
        if (!want.wanted && want.waitMs > 0) recheckSoon(want.waitMs);
        return want.wanted;
      };
      if (!settingsSyncedAt) {
        void syncSettings(true).then(() => {
          if (!composerFocused) return;
          renderBar();
          if (wanted()) void fetchSuggestions(agentId, state, key, keyQuotes);
        });
        return;
      }
      if (!wanted()) return;
      if (pendingAi.has(key)) { void fetchSuggestions(agentId, state, key, keyQuotes); return; }
      debounceTimer = setTimeout(() => { if (composerFocused) void fetchSuggestions(agentId, state, key, keyQuotes); }, FOCUS_FETCH_DEBOUNCE_MS);
    }

    // -- ghost text -------------------------------------------------------------------------------
    let ghostEl = null;
    let ghostClickArmed = false;
    const completion = createCompletionController({
      request: (payload, signal) => request('/local/suggestions/complete', payload, signal, 'POST'),
      onChange: () => positionGhost(),
      onSettings: patch => { settingsState = normalizeSettings({ ...settingsState, ...patch }); settingsUi?.updateState(settingsState); },
    });

    function ensureGhost() {
      if (ghostEl && ghostEl.isConnected) return ghostEl;
      ghostEl = doc.createElement('span');
      ghostEl.className = 'rokbot-ghost';
      ghostEl.setAttribute('aria-hidden', 'true');
      ghostEl.hidden = true;
      const hint = doc.createElement('span');
      hint.className = 'rokbot-ghost__text';
      const key = doc.createElement('kbd');
      key.className = 'rokbot-ghost__key';
      key.textContent = 'Tab';
      ghostEl.append(hint, key);
      // Clicking the ghost text accepts it; mousedown must not move the caret first.
      ghostEl.addEventListener('mousedown', ev => { ev.preventDefault(); ghostClickArmed = true; });
      ghostEl.addEventListener('click', ev => { ev.preventDefault(); if (ghostClickArmed) acceptGhost(); ghostClickArmed = false; });
      (doc.body || doc.documentElement).appendChild(ghostEl);
      return ghostEl;
    }

    function hideGhost() {
      if (ghostEl) ghostEl.hidden = true;
      observedInput?.removeAttribute?.('data-rokbot-ghost');
    }

    function positionGhost() {
      const suffix = completion.ghost;
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      if (!suffix || !input || composing || !isInputFocused(input, doc) || !caretAtEnd(input, doc)) { hideGhost(); return; }
      const rect = caretRect(input, doc);
      const box = input.getBoundingClientRect?.();
      if (!rect || !box) { hideGhost(); return; }
      const el = ensureGhost();
      const style = win?.getComputedStyle?.(input);
      if (style) {
        el.style.fontFamily = style.fontFamily;
        el.style.fontSize = style.fontSize;
        el.style.fontWeight = style.fontWeight;
        el.style.letterSpacing = style.letterSpacing;
      }
      el.firstChild.textContent = suffix;
      const lineHeight = Math.max(rect.height, 16);
      el.style.left = `${Math.round(rect.left + 1)}px`;
      el.style.top = `${Math.round(rect.top)}px`;
      el.style.height = `${Math.round(lineHeight)}px`;
      el.style.lineHeight = `${Math.round(lineHeight)}px`;
      el.style.maxWidth = `${Math.max(40, Math.round(box.right - rect.left - 8))}px`;
      el.hidden = false;
      input.setAttribute('data-rokbot-ghost', '1');
    }

    function acceptGhost() {
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      const suffix = completion.accept();
      hideGhost();
      if (!suffix || !input) return false;
      appendComposerText(input, suffix, doc);
      return true;
    }

    function updateCompletion() {
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      if (!input) { completion.clear(); hideGhost(); return; }
      const focused = isInputFocused(input, doc);
      const agentId = currentAgentId(doc, getViewingAgentId);
      const state = inspectTranscript(doc, agentId);
      const draft = composerDraft(input);
      completion.update({
        text: draft,
        caretAtEnd: caretAtEnd(input, doc),
        composing,
        // Caret at the end of a one-line draft, empty selection, no /command, not in code, not a sent message.
        allowed: completionGate(input, draft).ok,
        enabled: focused && settingsState.completionEnabled && !state.streaming,
        hasHistory: state.hasHistory,
        context: `${agentId}:${state.signature}`,
        payload: {
          agentId,
          lastEntryId: state.lastEntryId || '',
          locale: doc.documentElement.lang || locale || globalThis.navigator?.language || '',
          ...(state.recentMessages?.length ? { recentMessages: state.recentMessages } : {}),
        },
      });
      positionGhost();
    }

    const onKeyDown = ev => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (!completion.ghost || !ghostEl || ghostEl.hidden) return;
      const input = observedInput;
      if (ev.key === 'Escape') { completion.dismiss(); hideGhost(); return; }
      const plain = !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey;
      const accepts = plain && (ev.key === 'Tab' || (ev.key === 'ArrowRight' && caretAtEnd(input, doc)));
      if (!accepts || editorMenuOpen(doc)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      acceptGhost();
    };
    const onCompositionStart = () => { composing = true; updateCompletion(); };
    const onCompositionEnd = () => { composing = false; setTimeout(updateCompletion, 0); };
    const onSelectionChange = () => { if (completion.ghost) positionGhost(); };

    const onInputFocus = ev => {
      if (suppressUntilRefocus && ev?.isTrusted === false) return;
      suppressUntilRefocus = false;
      composerFocused = true;
      triggerIfFocused();
      updateCompletion();
    };
    const onInputPointerDown = () => {
      if (!suppressUntilRefocus) return;
      suppressUntilRefocus = false;
      composerFocused = true;
      triggerIfFocused();
    };
    const onInputBlur = ev => {
      const nextTarget = ev?.relatedTarget;
      if (nextTarget && bar && bar.contains(nextTarget)) return;
      composerFocused = false;
      suppressUntilRefocus = false;
      clearTimeout(debounceTimer);
      completion.clear();
      hideGhost();
      renderBar();
    };
    const onInputChange = ev => {
      if (ev?.type === 'input' && typeof ev.isComposing === 'boolean') composing = ev.isComposing;
      renderBar();
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      if (!suppressUntilRefocus && composerFocused && extractComposerText(input).length === 0) triggerIfFocused();
      updateCompletion();
    };

    function attachComposerListeners(form, input) {
      if (form && form !== observedForm) {
        observedForm = form;
        form.addEventListener('focusin', onInputFocus);
        form.addEventListener('focusout', onInputBlur);
      }
      if (input && input !== observedInput) {
        observedInput = input;
        composing = false;
        input.addEventListener('focus', onInputFocus);
        input.addEventListener('blur', onInputBlur);
        input.addEventListener('pointerdown', onInputPointerDown);
        input.addEventListener('input', onInputChange);
        input.addEventListener('keyup', ev => { if (!['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(ev.key)) onInputChange(ev); });
        input.addEventListener('keydown', onKeyDown, true);
        input.addEventListener('compositionstart', onCompositionStart);
        input.addEventListener('compositionend', onCompositionEnd);
      }
    }

    doc.addEventListener('selectionchange', onSelectionChange);
    win?.addEventListener?.('resize', onSelectionChange);
    win?.addEventListener?.('scroll', onSelectionChange, true);

    if (installSettings) {
      settingsUi = installSuggestionsSettingsPage({
        request,
        locale,
        document: doc,
        getState: () => settingsState,
        onHabitsCleared: () => { frequentCache.clear(); candidatesByAgent.clear(); aiCache.clear(); renderBar(); },
        onStateChange: next => {
          settingsState = normalizeSettings(next);
          settingsSyncedAt = Date.now();
          if (!settingsState.enabled || !settingsState.aiEnabled) { activeAiSuggestions = []; loading.reset(); }
          if (!settingsState.completionEnabled) { completion.clear(); hideGhost(); }
          renderBar();
          if (composerFocused && settingsState.enabled && settingsState.aiEnabled) triggerIfFocused();
        },
      });
    }

    // Prime settings (a tiny GET, no model call) so phrases show immediately on first focus.
    void syncSettings(true).then(() => schedulePrefetch());

    const observer = new MutationObserver(mutations => {
      if (mutations.every(m => m.target instanceof Element && (m.target.closest('.rokbot-suggestions') || m.target.closest('.rokbot-ghost') || m.target.closest('[data-rokbot-suggestions-page]') || m.target.closest('[data-rokbot-suggestions-nav]')))) return;
      triggerIfFocused();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current', 'data-active', 'aria-selected'] });
    triggerIfFocused();

    return () => {
      clearTimeout(debounceTimer);
      clearTimeout(leavingTimer);
      clearTimeout(barLeavingTimer);
      clearTimeout(prefetchTimer);
      clearTimeout(settleTimer);
      clearTimeout(recheckTimer);
      observer.disconnect();
      completion.dispose();
      doc.removeEventListener('selectionchange', onSelectionChange);
      win?.removeEventListener?.('resize', onSelectionChange);
      win?.removeEventListener?.('scroll', onSelectionChange, true);
      settingsUi?.destroy();
      bar?.remove();
      ghostEl?.remove();
    };
  }

  // ---- first-level settings entry ---------------------------------------------------------------
  // The official settings dialog: .sand-settings-layout > nav.sand-settings-nav > button.sand-settings-nav__item
  // (aria-current="page" + data-active on the selected one) and section.sand-settings-panel
  // (close button, pane header, .sand-settings-panel__body). The entry is one more nav button with the
  // official classes; while it is selected the official header and body are hidden and the page shows.

  function installSuggestionsSettingsPage({ request, locale = '', getState, onStateChange, onHabitsCleared, document: doc = globalThis.document } = {}) {
    if (!doc || typeof request !== 'function') return { updateState() {}, destroy() {} };
    let state = normalizeSettings(getState?.() ?? {});
    let loadingSettings = false;
    let loadedOnce = false;
    let editingId = null;
    let editingValue = '';
    let statusError = '';
    let statusNote = '';
    let clearArmed = false;
    let open = false;
    let page = null;
    let navButton = null;
    let swapped = null;        // { el, className, ariaCurrent, dataActive, iconClass } of the official selected item
    let look = {};             // class names of the official pane, section, section title row and card
    const zh = () => isZhLocale(doc.documentElement.lang || locale);

    const applyState = next => {
      state = normalizeSettings(next);
      onStateChange?.(state);
      renderPage();
    };

    const syncFromHost = async () => {
      if (loadingSettings) return;
      loadingSettings = true;
      try {
        const res = await request('/local/suggestions/settings', null, undefined, 'GET');
        loadedOnce = true;
        statusError = '';
        applyState(res);
      } catch (err) {
        statusError = err?.message || t(zh(), '无法读取输入建议设置', 'Could not load suggestion settings');
        renderPage();
      } finally {
        loadingSettings = false;
      }
    };

    const save = async (patch, fallback) => {
      statusError = '';
      try { applyState(await request('/local/suggestions/settings', patch, undefined, 'PUT')); }
      catch (err) { statusError = err?.message || fallback; renderPage(); }
    };

    const phraseCall = async (path, body, method, fallback) => {
      statusError = '';
      try {
        const res = await request(path, body, undefined, method);
        applyState({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
        return true;
      } catch (err) {
        statusError = err?.message || fallback;
        renderPage();
        return false;
      }
    };

    function switchRow(id, labelText, descText, checked, disabled, onToggle) {
      const row = doc.createElement('div');
      row.className = 'rokbot-sug-settings__row';
      if (disabled) row.classList.add('rokbot-sug-settings__row--disabled');
      const copy = doc.createElement('div');
      copy.className = 'rokbot-sug-settings__copy';
      const title = doc.createElement('div');
      title.className = 'rokbot-sug-settings__label';
      title.textContent = labelText;
      const desc = doc.createElement('div');
      desc.className = 'rokbot-sug-settings__desc';
      desc.textContent = descText;
      copy.append(title, desc);
      const sw = doc.createElement('button');
      sw.type = 'button';
      sw.id = id;
      sw.className = 'rokbot-sug-settings__switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', labelText);
      sw.setAttribute('aria-checked', String(Boolean(checked)));
      sw.disabled = Boolean(disabled);
      const thumb = doc.createElement('span');
      thumb.className = 'rokbot-sug-settings__switch-thumb';
      sw.appendChild(thumb);
      sw.addEventListener('click', () => { if (!disabled) void onToggle(); });
      row.append(copy, sw);
      return row;
    }

    function iconButton(className, label, icon, onClick, disabled = false) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `rokbot-sug-settings__icon-btn${className ? ` ${className}` : ''}`;
      btn.disabled = disabled;
      btn.setAttribute('aria-label', label);
      btn.innerHTML = icon;
      if (onClick) btn.addEventListener('click', onClick);
      return btn;
    }

    function phraseList(isZh) {
      const list = doc.createElement('ul');
      list.className = 'rokbot-sug-settings__list';
      if (state.quickPhrases.length === 0) {
        const empty = doc.createElement('li');
        empty.className = 'rokbot-sug-settings__empty';
        empty.textContent = t(isZh, '暂未添加常用语', 'No quick phrases yet');
        list.appendChild(empty);
        return list;
      }
      state.quickPhrases.forEach((phrase, idx) => {
        const li = doc.createElement('li');
        li.className = 'rokbot-sug-settings__item';
        li.dataset.phraseId = phrase.id;
        if (editingId === phrase.id) {
          const form = doc.createElement('form');
          form.className = 'rokbot-sug-settings__edit-form';
          const input = doc.createElement('input');
          input.type = 'text';
          input.className = 'rokbot-sug-settings__input';
          input.maxLength = 120;
          input.value = editingValue;
          input.setAttribute('aria-label', t(isZh, '编辑常用语', 'Edit quick phrase'));
          input.addEventListener('input', () => { editingValue = input.value; });
          const saveBtn = doc.createElement('button');
          saveBtn.type = 'submit';
          saveBtn.className = 'rokbot-sug-settings__icon-btn rokbot-sug-settings__icon-btn--primary';
          saveBtn.setAttribute('aria-label', t(isZh, '保存', 'Save'));
          saveBtn.innerHTML = ICONS.check;
          const cancelBtn = iconButton('', t(isZh, '取消', 'Cancel'), ICONS.close, () => { editingId = null; editingValue = ''; renderPage(); });
          form.append(input, saveBtn, cancelBtn);
          form.addEventListener('submit', async ev => {
            ev.preventDefault();
            const text = input.value.replace(/\s+/g, ' ').trim();
            if (!text) return;
            if (await phraseCall(`/local/suggestions/phrases/${encodeURIComponent(phrase.id)}`, { text }, 'PUT', t(isZh, '保存失败', 'Could not update phrase'))) {
              editingId = null;
              editingValue = '';
              renderPage();
            }
          });
          li.appendChild(form);
          setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);
        } else {
          const iconSpan = doc.createElement('span');
          iconSpan.className = 'rokbot-sug-settings__item-icon';
          iconSpan.innerHTML = ICONS.phrase;
          const textSpan = doc.createElement('span');
          textSpan.className = 'rokbot-sug-settings__item-text';
          textSpan.textContent = phrase.text;
          const actions = doc.createElement('div');
          actions.className = 'rokbot-sug-settings__item-actions';
          const move = delta => {
            const target = idx + delta;
            if (target < 0 || target >= state.quickPhrases.length) return;
            const ids = state.quickPhrases.map(item => item.id);
            [ids[idx], ids[target]] = [ids[target], ids[idx]];
            void phraseCall('/local/suggestions/phrases/reorder', { ids }, 'PUT', t(isZh, '排序失败', 'Could not reorder phrases'));
          };
          actions.append(
            iconButton('', t(isZh, '上移', 'Move up'), ICONS.up, () => move(-1), idx === 0),
            iconButton('', t(isZh, '下移', 'Move down'), ICONS.down, () => move(1), idx === state.quickPhrases.length - 1),
            iconButton('', t(isZh, '编辑', 'Edit'), ICONS.edit, () => { editingId = phrase.id; editingValue = phrase.text; renderPage(); }),
            iconButton('rokbot-sug-settings__icon-btn--danger', t(isZh, '删除', 'Delete'), ICONS.trash, () => {
              void phraseCall(`/local/suggestions/phrases/${encodeURIComponent(phrase.id)}`, null, 'DELETE', t(isZh, '删除失败', 'Could not delete phrase'));
            }),
          );
          li.append(iconSpan, textSpan, actions);
        }
        list.appendChild(li);
      });
      return list;
    }

    function renderPage() {
      if (!page || !page.isConnected) return;
      const isZh = zh();
      const body = page.querySelector('[data-rokbot-suggestions-body]');
      const heading = page.querySelector('[data-rokbot-suggestions-title]');
      if (heading) heading.textContent = t(isZh, '输入建议', 'Input suggestions');
      if (!body) return;
      body.textContent = '';

      const section = (title, ...children) => {
        const wrap = doc.createElement('section');
        wrap.className = `${look.section ?? ''} rokbot-sug-settings__section`.trim();
        let h;
        if (look.title) {
          // The official section title row, with our text in its text element.
          h = look.title.cloneNode(true);
          h.querySelectorAll('button, input, select, a, svg').forEach(el => el.remove());
          const leaves = [...h.querySelectorAll('*')].filter(el => el.children.length === 0 && el.textContent.trim());
          if (leaves.length) {
            leaves[0].textContent = title;
            leaves.slice(1).forEach(el => el.remove());
          } else {
            h.textContent = title;
          }
          h.classList.add('rokbot-sug-settings__title-row');
        } else {
          h = doc.createElement('h3');
          h.className = 'rokbot-sug-settings__heading';
          h.textContent = title;
        }
        const card = doc.createElement('div');
        card.className = 'rokbot-sug-settings__card';
        if (look.card) card.classList.add('rokbot-sug-settings__card--official', ...look.card.split(/\s+/).filter(Boolean));
        card.append(...children);
        wrap.append(h, card);
        return wrap;
      };

      body.appendChild(section(
        t(isZh, '建议与补全', 'Suggestions and completion'),
        switchRow('rokbot-setting-suggestions-enabled', t(isZh, '输入建议', 'Input suggestions'),
          t(isZh, '输入框聚焦时显示常用语与快捷建议，点击直接发送', 'Show quick phrases and smart replies on focus; click to send'),
          state.enabled, false, () => save({ enabled: !state.enabled }, t(isZh, '保存失败', 'Could not save setting'))),
        switchRow('rokbot-setting-suggestions-ai-enabled', t(isZh, 'AI 生成建议', 'AI-generated suggestions'),
          t(isZh, '根据当前对话上下文由模型自动生成回复建议', 'Generate contextual reply suggestions from conversation history'),
          state.aiEnabled, !state.enabled, () => save({ aiEnabled: !state.aiEnabled }, t(isZh, '保存失败', 'Could not save setting'))),
        switchRow('rokbot-setting-completion-enabled', t(isZh, '输入补全', 'Inline completion'),
          t(isZh, '打字时以灰色文字预测后半句，按 Tab 或右方向键接受', 'Predict the rest of your sentence as gray text; press Tab or Right Arrow to accept'),
          state.completionEnabled, false, () => save({ completionEnabled: !state.completionEnabled }, t(isZh, '保存失败', 'Could not save setting'))),
      ));

      // Habits: learned on the Host from this user's own messages and picks.
      const clearRow = doc.createElement('div');
      clearRow.className = 'rokbot-sug-settings__row rokbot-sug-settings__row--action';
      const clearCopy = doc.createElement('div');
      clearCopy.className = 'rokbot-sug-settings__copy';
      const clearTitle = doc.createElement('div');
      clearTitle.className = 'rokbot-sug-settings__label';
      clearTitle.textContent = t(isZh, '清空学习记录', 'Clear learned habits');
      const clearDesc = doc.createElement('div');
      clearDesc.className = 'rokbot-sug-settings__desc';
      clearDesc.textContent = statusNote || t(isZh, '删除 Host 上为每个 Bot 学到的常用说法和点选记录，常用语不受影响',
        'Delete the habits and picks learned for every Bot on your Host; quick phrases are kept');
      clearCopy.append(clearTitle, clearDesc);
      const clearBtn = doc.createElement('button');
      clearBtn.type = 'button';
      clearBtn.id = 'rokbot-setting-suggestions-clear-habits';
      clearBtn.className = 'rokbot-sug-settings__add-btn rokbot-sug-settings__danger-btn';
      clearBtn.textContent = clearArmed ? t(isZh, '确认清空', 'Confirm') : t(isZh, '清空', 'Clear');
      clearBtn.addEventListener('click', async () => {
        if (!clearArmed) { clearArmed = true; statusNote = ''; renderPage(); return; }
        clearArmed = false;
        clearBtn.disabled = true;
        try {
          await request('/local/suggestions/habits', null, undefined, 'DELETE');
          statusNote = t(isZh, '已清空学习记录', 'Learned habits cleared');
          onHabitsCleared?.();
        } catch (err) {
          statusError = err?.message || t(isZh, '清空失败', 'Could not clear');
        }
        renderPage();
      });
      clearRow.append(clearCopy, clearBtn);
      body.appendChild(section(
        t(isZh, '个性化', 'Personalization'),
        switchRow('rokbot-setting-suggestions-learning', t(isZh, '根据习惯学习', 'Learn from my habits'),
          t(isZh, '参考你常发的话和点选记录，让建议更像你会说的话；仅保存在你的 Host 上',
            'Use the messages you often send and the suggestions you pick; stored only on your Host'),
          state.learningEnabled, !state.enabled, () => save({ learningEnabled: !state.learningEnabled }, t(isZh, '保存失败', 'Could not save setting'))),
        switchRow('rokbot-setting-suggestions-local-completion', t(isZh, '本地补全', 'Local completion'),
          t(isZh, '输入时匹配常用语和你常发的话，点击填入输入框（不发送）',
            'While typing, match quick phrases and your frequent messages; click to fill the input (not sent)'),
          state.localCompletionEnabled, !state.enabled, () => save({ localCompletionEnabled: !state.localCompletionEnabled }, t(isZh, '保存失败', 'Could not save setting'))),
        clearRow,
      ));

      const phrases = doc.createElement('div');
      phrases.className = 'rokbot-sug-settings__phrases';
      const head = doc.createElement('div');
      head.className = 'rokbot-sug-settings__desc';
      head.textContent = t(isZh, '常用语显示在 AI 建议之前，在所有设备间同步。空会话仅显示常用语。',
        'Shown before AI suggestions and synced across devices. Empty chats only show quick phrases.');
      const addForm = doc.createElement('form');
      addForm.className = 'rokbot-sug-settings__add';
      const addInput = doc.createElement('input');
      addInput.type = 'text';
      addInput.className = 'rokbot-sug-settings__input';
      addInput.maxLength = 120;
      addInput.setAttribute('aria-label', t(isZh, '新增常用语', 'New quick phrase'));
      addInput.placeholder = t(isZh, '添加常用语，例如：继续、总结一下', 'Add a quick phrase, e.g. Continue, Summarize');
      const addBtn = doc.createElement('button');
      addBtn.type = 'submit';
      addBtn.className = 'rokbot-sug-settings__add-btn';
      addBtn.innerHTML = `${ICONS.plus}<span>${t(isZh, '添加', 'Add')}</span>`;
      addForm.append(addInput, addBtn);
      addForm.addEventListener('submit', async ev => {
        ev.preventDefault();
        const text = addInput.value.replace(/\s+/g, ' ').trim();
        if (!text) return;
        addBtn.disabled = true;
        try {
          if (await phraseCall('/local/suggestions/phrases', { text }, 'POST', t(isZh, '添加失败', 'Could not add phrase'))) addInput.value = '';
        } finally { addBtn.disabled = false; }
      });
      phrases.append(head, addForm);
      if (statusError) {
        const errEl = doc.createElement('p');
        errEl.className = 'rokbot-sug-settings__error';
        errEl.setAttribute('role', 'alert');
        errEl.textContent = statusError;
        phrases.appendChild(errEl);
      }
      phrases.appendChild(phraseList(isZh));
      body.appendChild(section(t(isZh, '自定义常用语', 'Quick phrases'), phrases));
    }

    const navItems = nav => [...nav.querySelectorAll(':scope > .sand-settings-nav__item')].filter(el => el !== navButton);
    const isOfficialActive = el => el.getAttribute('aria-current') === 'page' || el.getAttribute('data-active') === 'true';

    function buildNavButton(nav) {
      const items = navItems(nav);
      const template = items.find(el => !isOfficialActive(el)) ?? items[0];
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = template?.className || 'sand-settings-nav__item';
      btn.setAttribute('data-rokbot-suggestions-nav', '1');
      const icon = doc.createElement('span');
      icon.className = 'rokbot-sug-nav__icon';
      icon.innerHTML = ICONS.nav;
      const templateIcon = template?.querySelector('svg');
      if (templateIcon?.getAttribute('class')) icon.firstChild.setAttribute('class', templateIcon.getAttribute('class'));
      const label = doc.createElement('span');
      label.textContent = t(zh(), '输入建议', 'Input suggestions');
      btn.append(icon.firstChild, label);
      btn.addEventListener('click', () => openPage());
      return btn;
    }

    function placeNavButton(nav) {
      const items = navItems(nav);
      if (!items.length) return;
      // Right after General (the first entry), like the other app-wide preferences.
      const general = items.find(el => /^(general|通用|常规)$/i.test((el.textContent || '').trim())) ?? items[0];
      if (navButton.previousElementSibling !== general) general.after(navButton);
    }

    function openPage() {
      const layout = navButton?.closest('.sand-settings-layout');
      const panel = layout?.querySelector('.sand-settings-panel');
      if (!layout || !panel) return;
      open = true;
      const nav = navButton.parentElement;
      const official = navItems(nav).find(isOfficialActive);
      if (official && !swapped) {
        swapped = {
          el: official,
          className: official.className,
          ariaCurrent: official.getAttribute('aria-current'),
          dataActive: official.getAttribute('data-active'),
        };
        const inactive = navItems(nav).find(el => el !== official && !isOfficialActive(el));
        navButton.className = official.className;
        if (inactive) official.className = inactive.className;
        official.removeAttribute('aria-current');
        official.removeAttribute('data-active');
        const activeIcon = official.querySelector('svg')?.getAttribute('class');
        const inactiveIcon = inactive?.querySelector('svg')?.getAttribute('class');
        const ownIcon = navButton.querySelector('svg');
        if (ownIcon && activeIcon) ownIcon.setAttribute('class', activeIcon);
        if (inactiveIcon) official.querySelector('svg')?.setAttribute('class', inactiveIcon);
        swapped.activeIcon = activeIcon;
      }
      navButton.setAttribute('aria-current', 'page');
      navButton.setAttribute('data-active', 'true');
      mountPage(panel);
      if (!loadedOnce) void syncFromHost();
    }

    function closePage() {
      if (!open) return;
      open = false;
      if (swapped?.el?.isConnected) {
        const nav = navButton?.parentElement;
        const inactive = nav ? navItems(nav).find(el => el !== swapped.el && !isOfficialActive(el)) : null;
        swapped.el.className = swapped.className;
        if (swapped.ariaCurrent !== null) swapped.el.setAttribute('aria-current', swapped.ariaCurrent);
        if (swapped.dataActive !== null) swapped.el.setAttribute('data-active', swapped.dataActive);
        if (swapped.activeIcon) swapped.el.querySelector('svg')?.setAttribute('class', swapped.activeIcon);
        if (navButton && inactive) {
          navButton.className = inactive.className;
          const inactiveIcon = inactive.querySelector('svg')?.getAttribute('class');
          if (inactiveIcon) navButton.querySelector('svg')?.setAttribute('class', inactiveIcon);
        }
      }
      swapped = null;
      navButton?.removeAttribute('aria-current');
      navButton?.removeAttribute('data-active');
      page?.closest('.sand-settings-panel')?.classList.remove('rokbot-sug-page-open');
      page?.remove();
      page = null;
    }

    function mountPage(panel) {
      panel.classList.add('rokbot-sug-page-open');
      if (page && page.isConnected && page.parentElement === panel) { renderPage(); return; }
      page?.remove();
      page = doc.createElement('div');
      page.className = 'rokbot-sug-page';
      page.setAttribute('data-rokbot-suggestions-page', '1');
      page.setAttribute('role', 'region');
      // Reuse the official header and body containers so spacing and type match the other panes.
      const officialHeader = panel.querySelector(':scope > .sand-settings-pane-header, :scope > header, :scope > div:has(> h2)');
      const officialBody = panel.querySelector(':scope > .sand-settings-panel__body');
      const officialPane = officialBody?.querySelector('.sand-settings-pane');
      const officialSection = officialPane?.querySelector('section');
      look = {
        pane: officialPane?.getAttribute('class') ?? '',
        section: officialSection?.getAttribute('class') ?? '',
        title: officialSection?.children.length >= 2 ? officialSection.children[0] : null,
        card: officialSection?.children.length >= 2 ? officialSection.children[1].getAttribute('class') : '',
      };
      let header;
      if (officialHeader) {
        header = officialHeader.cloneNode(true);
        header.querySelectorAll('button, input, select, a').forEach(el => el.remove());
        header.removeAttribute('id');
        const h2 = header.querySelector('h2') ?? header;
        h2.removeAttribute('id');
        h2.setAttribute('data-rokbot-suggestions-title', '1');
        h2.textContent = '';
      } else {
        header = doc.createElement('div');
        header.className = 'rokbot-sug-page__header';
        const h2 = doc.createElement('h2');
        h2.setAttribute('data-rokbot-suggestions-title', '1');
        header.appendChild(h2);
      }
      header.classList.add('rokbot-sug-page__header');
      const body = doc.createElement('div');
      body.className = officialBody?.className || 'sand-settings-panel__body';
      body.classList.add('rokbot-sug-page__body');
      const pane = doc.createElement('div');
      pane.className = `${look.pane || 'sand-settings-pane'} rokbot-sug-settings`;
      pane.setAttribute('data-rokbot-suggestions-body', '1');
      body.appendChild(pane);
      page.append(header, body);
      const close = panel.firstElementChild;
      if (close && close.tagName === 'BUTTON') close.after(page); else panel.prepend(page);
      page.setAttribute('aria-label', t(zh(), '输入建议', 'Input suggestions'));
      renderPage();
    }

    function ensureMounted() {
      const nav = doc.querySelector('.sand-settings-layout .sand-settings-nav');
      if (!nav) {
        open = false;
        swapped = null;
        page = null;
        navButton = null;
        return;
      }
      if (!navButton || !navButton.isConnected || navButton.parentElement !== nav) {
        navButton?.remove();
        navButton = buildNavButton(nav);
      }
      placeNavButton(nav);
      if (open) {
        const panel = nav.closest('.sand-settings-layout')?.querySelector('.sand-settings-panel');
        if (panel && (!page || !page.isConnected)) mountPage(panel);
        // React re-rendered the official selected item: keep it looking unselected while the page is open.
        if (swapped?.el?.isConnected && isOfficialActive(swapped.el)) {
          swapped.el.removeAttribute('aria-current');
          swapped.el.removeAttribute('data-active');
        }
      }
    }

    // Any official entry closes the page (capture: before React handles the click).
    const onNavClick = ev => {
      const item = ev.target?.closest?.('.sand-settings-nav__item');
      if (!item || item === navButton || item.closest('[data-rokbot-suggestions-nav]')) return;
      closePage();
    };
    doc.addEventListener('click', onNavClick, true);

    const observer = new MutationObserver(mutations => {
      if (mutations.every(m => m.target instanceof Element && (m.target.closest('[data-rokbot-suggestions-page]') || m.target.closest('[data-rokbot-suggestions-nav]')))) return;
      ensureMounted();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    ensureMounted();

    return {
      updateState(next) { state = normalizeSettings(next); renderPage(); },
      open: openPage,
      close: closePage,
      get isOpen() { return open; },
      destroy() {
        observer.disconnect();
        doc.removeEventListener('click', onNavClick, true);
        closePage();
        navButton?.remove();
      },
    };
  }

  return {
    ICONS,
    COMPLETION_DEBOUNCE_MS,
    COMPLETION_MIN_CHARS,
    isZhLocale,
    countChars,
    normalizeSettings,
    mergeSuggestionItems,
    matchCompletions,
    ASSISTANT_OFFER_PREFIXES,
    isAssistantOfferPhrase,
    isSelfUserEntry,
    voiceSafeCompletion,
    BAR_FADE_MS,
    prefersReducedMotion,
    createLoadingMachine,
    createCompletionController,
    IDLE_SETTLE_MS,
    REGENERATE_MIN_INTERVAL_MS,
    createTurnGate,
    createGenerationLimiter,
    createRecentSent,
    quoteKeyOf,
    suggestionStateKey,
    readComposerQuotes,
    messageTextWithoutQuote,
    inCodeBlock,
    completionAllowed,
    completionFitsDraft,
    matchFitsDraft,
    extractComposerText,
    composerDraft,
    insertSuggestionText,
    appendComposerText,
    sendSuggestionText,
    caretAtEnd,
    inspectTranscript,
    currentAgentId,
    acceptSuggestionResponse,
    installComposerSuggestions,
    installSuggestionsSettingsPage,
  };
});
