// When the composer assist (mac/clients/desktop/composer-assist.cjs, Web + desktop) generates the
// suggestion strip and offers inline completion (fix/suggest-scenes):
//   (a) only once the Bot is idle — nothing while a reply streams or a tool runs, once more after;
//   (b) a quote added to / removed from the composer is a new state (generated again from it);
//   (c) completion only at the end of a one-line draft: not during IME composition, with a
//       selection, a /command, inside code, or when the suggestion does not fit the typed prefix;
//   (d) one round while focused and empty, no repeats shortly after.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const assist = require('../../mac/clients/desktop/composer-assist.cjs');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

// A small model of the strip's trigger: what installComposerSuggestions does on every screen change.
function stripModel({ settleMs = 1_200, minIntervalMs = 4_000 } = {}) {
  const c = clock();
  const gate = assist.createTurnGate({ settleMs, now: c.now });
  const limiter = assist.createGenerationLimiter({ minIntervalMs, now: c.now });
  const generated = [];
  const observe = ({ agentId = 'rokbot', signature, busy = false, quotes = [] }) => {
    const turn = gate.observe({ agentId, signature, busy });
    if (!turn.idle) return { generated: false, waitMs: turn.waitMs };
    const key = assist.suggestionStateKey({ agentId, signature, quoteKey: assist.quoteKeyOf(quotes), lang: 'zh' });
    const verdict = limiter.check(agentId, key);
    if (!verdict.allowed) return { generated: false, waitMs: verdict.waitMs };
    limiter.record(agentId, key);
    generated.push(key);
    return { generated: true, key };
  };
  return { observe, generated, clock: c, gate };
}

test('(a) nothing is generated while the turn runs; once after it ends', () => {
  const m = stripModel();
  // The chat opens idle: generated at once.
  assert.equal(m.observe({ signature: '2:a1' }).generated, true);
  // The user sends; the reply streams and a tool call follows (rows keep changing).
  for (const signature of ['3:u2', '4:a2-stream', '4:a2-stream+', '5:tool-1', '6:a3-stream']) {
    m.clock.advance(400);
    const out = m.observe({ signature, busy: true });
    assert.equal(out.generated, false, `busy at ${signature}`);
    assert.equal(out.waitMs, 0);
  }
  // The Stop button disappears between two steps of the turn, then comes back: still nothing.
  m.clock.advance(300);
  const blink = m.observe({ signature: '6:a3' });
  assert.equal(blink.generated, false, 'the screen is not quiet yet');
  assert.ok(blink.waitMs > 0 && blink.waitMs <= 1_200);
  m.clock.advance(200);
  assert.equal(m.observe({ signature: '7:tool-2', busy: true }).generated, false);
  // The turn is over: quiet for the settle time, then generated exactly once.
  m.clock.advance(100);
  assert.equal(m.observe({ signature: '8:a4' }).generated, false);
  m.clock.advance(1_000);
  assert.equal(m.observe({ signature: '8:a4' }).generated, false, 'still settling');
  m.clock.advance(1_000);
  const done = m.observe({ signature: '8:a4' });
  assert.equal(done.generated, true);
  m.clock.advance(5_000);
  assert.equal(m.observe({ signature: '8:a4' }).generated, false, 'not again for the same state');
  assert.equal(m.generated.length, 2);
  assert.ok(m.generated.every(key => !/stream|tool/.test(key)));
});

test('(a) opening another, idle Bot is not a turn ending: no settle wait; a busy Bot waits', () => {
  const m = stripModel();
  assert.equal(m.observe({ agentId: 'rokbot', signature: '2:a1' }).generated, true);
  assert.equal(m.observe({ agentId: 'xhs', signature: '5:x4' }).generated, true);
  assert.equal(m.observe({ agentId: 'ops', signature: '1:o1', busy: true }).generated, false);
});

test('(b) a quote added or removed is a new trigger; the quote is not the user\'s own words', () => {
  const m = stripModel();
  assert.equal(m.observe({ signature: '2:a1' }).generated, true);
  m.clock.advance(5_000);
  const added = m.observe({ signature: '2:a1', quotes: [{ text: 'e2e 挂了 2 个' }] });
  assert.equal(added.generated, true, 'quote added: generated again');
  assert.match(added.key, /e2e 挂了 2 个/);
  m.clock.advance(5_000);
  const another = m.observe({ signature: '2:a1', quotes: [{ text: 'e2e 挂了 2 个' }, { text: 'lint 报错' }] });
  assert.equal(another.generated, true, 'another quote added: generated again');
  m.clock.advance(5_000);
  const removed = m.observe({ signature: '2:a1', quotes: [{ text: 'e2e 挂了 2 个' }] });
  assert.equal(removed.generated, false, 'back to a state already generated: its answer is reused');
  // Quick add + remove: not two model calls in a row.
  const burst = m.observe({ signature: '2:a1', quotes: [{ text: '新引用' }] });
  assert.equal(burst.generated, true);
  const again = m.observe({ signature: '2:a1', quotes: [{ text: '再一个引用' }] });
  assert.equal(again.generated, false);
  assert.ok(again.waitMs > 0, 'it waits for the per-Bot interval');

  assert.equal(assist.quoteKeyOf([]), '');
  assert.notEqual(assist.quoteKeyOf([{ text: 'a' }]), assist.quoteKeyOf([{ text: 'b' }]));
  assert.equal(assist.quoteKeyOf([{ text: ' a  b ' }]), assist.quoteKeyOf([{ text: 'a b' }]));

  // A sent message that replied to something: only what the user typed is their text.
  const quoteNode = { remove() { this.removed = true; } };
  const copy = { textContent: '先修第一个', querySelectorAll: () => [quoteNode] };
  const message = { textContent: 'e2e 挂了 2 个先修第一个', querySelector: () => quoteNode, cloneNode: () => copy };
  assert.equal(assist.messageTextWithoutQuote(message), '先修第一个');
  assert.equal(quoteNode.removed, true);
  assert.equal(assist.messageTextWithoutQuote({ textContent: '普通消息', querySelector: () => null }), '普通消息');
});

test('(b) the composer quotes are read from the official reply pill', () => {
  const pill = text => ({
    closest: () => null,
    getAttribute: () => null,
    querySelector: sel => (sel === '.sand-reply-quote__body' ? { textContent: text } : null),
  });
  const pills = [pill('  e2e 挂了\n2 个 '), pill('e2e 挂了 2 个'), pill('')];
  const form = { parentElement: { querySelectorAll: sel => (sel.includes('.sand-prompt-reply-pill') ? pills : []) } };
  assert.deepEqual(assist.readComposerQuotes({}, form), [{ text: 'e2e 挂了 2 个' }]);
  assert.deepEqual(assist.readComposerQuotes({}, null), []);
  const source = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/composer-assist.cjs'), 'utf8');
  assert.match(source, /QUOTE_PILL_SELECTOR = '\.sand-prompt-reply-pill/);
  // The request carries them; the transcript messages it scrapes leave them out.
  assert.match(source, /\.\.\.\(quotes\.length \? \{ quotes \} : \{\}\)/);
  assert.match(source, /role === 'user' \? messageTextWithoutQuote\(el\)/);
});

test('(c) IME composition: no completion', () => {
  assert.deepEqual(assist.completionAllowed({ text: '帮我pao', composing: true }), { ok: false, reason: 'composing' });
  // The controller asks nothing while composing.
  const timers = [];
  const controller = assist.createCompletionController({
    request: () => Promise.resolve({ completion: 'x', source: 'model' }),
    schedule: fn => { timers.push(fn); return timers.length; },
    cancelSchedule: () => {},
  });
  controller.update({ text: '帮我pao', composing: true, enabled: true, hasHistory: true, caretAtEnd: true, context: 'c' });
  assert.equal(timers.length, 0);
  assert.equal(controller.ghost, '');
});

test('(c) caret not at the end, a selection, or a second line: no completion', () => {
  assert.equal(assist.completionAllowed({ text: '帮我看下日志', caretAtEnd: false }).reason, 'caret');
  assert.equal(assist.completionAllowed({ text: '帮我看下日志', selectionCollapsed: false }).reason, 'selection');
  assert.equal(assist.completionAllowed({ text: '第一行\n第二行' }).reason, 'multiline');
  assert.equal(assist.completionAllowed({ text: '只有一行\n' }).ok, true, 'a trailing newline is still the first line');
  const timers = [];
  const controller = assist.createCompletionController({
    request: () => Promise.resolve({ completion: 'x', source: 'model' }),
    schedule: fn => { timers.push(fn); return timers.length; },
    cancelSchedule: () => {},
  });
  controller.update({ text: '帮我看下', caretAtEnd: false, enabled: true, hasHistory: true, context: 'c' });
  controller.update({ text: '帮我看下', caretAtEnd: true, allowed: false, enabled: true, hasHistory: true, context: 'c' });
  assert.equal(timers.length, 0, 'nothing is requested');
  controller.update({ text: '帮我看下', caretAtEnd: true, allowed: true, enabled: true, hasHistory: true, context: 'c' });
  assert.equal(timers.length, 1, 'at the end of the first line it is');
});

test('(c) a /command, code, or a message already sent: no completion', () => {
  assert.equal(assist.completionAllowed({ text: '/model' }).reason, 'slash');
  assert.equal(assist.completionAllowed({ text: '  /help me' }).reason, 'slash');
  assert.equal(assist.completionAllowed({ text: '```js\nconst a' }).reason, 'multiline');
  assert.equal(assist.completionAllowed({ text: '```js const a' }).reason, 'code');
  assert.equal(assist.completionAllowed({ text: 'run `npm te' }).reason, 'code');
  assert.equal(assist.completionAllowed({ text: 'run `npm test` an' }).ok, true);
  assert.equal(assist.completionAllowed({ text: '看看', codeContext: true }).reason, 'code');
  assert.equal(assist.completionAllowed({ text: '跑一下 e2e', sentTexts: ['跑一下  e2e'] }).reason, 'sent');
  assert.equal(assist.completionAllowed({ text: '跑一下 e2e 再', sentTexts: ['跑一下 e2e'] }).ok, true);
  assert.equal(assist.inCodeBlock('```\na\n```\nb'), false);
});

test('(c) a suggestion that does not fit the typed prefix is not shown', async () => {
  assert.equal(assist.completionFitsDraft('帮我看下', '日志里的报错'), true);
  assert.equal(assist.completionFitsDraft('帮我看下', '帮你看下日志'), false, 'a rewrite of the draft');
  assert.equal(assist.completionFitsDraft('deplo', 'Run tests'), false);
  assert.equal(assist.completionFitsDraft('deploy', ' to staging'), true);
  assert.equal(assist.completionFitsDraft('run the', ' tests again'), true);
  // Local match chips: the phrase must contain the draft, not just its letters in order.
  assert.equal(assist.matchFitsDraft('跑一', '跑一下全量测试'), true);
  assert.equal(assist.matchFitsDraft('跑测', '跑一下全量测试'), false);
  assert.equal(assist.matchFitsDraft('跑一下', '跑一下'), false);

  const timers = [];
  const controller = assist.createCompletionController({
    request: () => Promise.resolve({ completion: '帮你看下日志', source: 'model', enabled: true }),
    schedule: fn => { timers.push(fn); return timers.length; },
    cancelSchedule: () => {},
  });
  controller.update({ text: '帮我看下', caretAtEnd: true, enabled: true, hasHistory: true, context: 'c' });
  timers.shift()();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(controller.ghost, '', 'the misfit suffix is dropped');
});

test('(d) one round while focused and empty; a sent suggestion is not offered again soon', () => {
  const c = clock();
  const recent = assist.createRecentSent({ ttlMs: 60_000, now: c.now });
  recent.add('先修 lint');
  assert.deepEqual(recent.filter(['先修  lint', '看下 upload.spec']), ['看下 upload.spec']);
  c.advance(60_001);
  assert.deepEqual(recent.filter(['先修 lint']), ['先修 lint'], 'after a while it may come back');

  const source = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/composer-assist.cjs'), 'utf8');
  const trigger = source.slice(source.indexOf('function triggerIfFocused()'), source.indexOf('// -- ghost text'));
  // Busy: no generation, no prefetch, no refresh (only the quick phrases show).
  assert.match(trigger, /if \(busyNow\) \{[\s\S]*?clearTimeout\(prefetchTimer\);[\s\S]*?return;\n      \}/);
  assert.match(source, /if \(busyNow\) return mergeSuggestionItems\(settingsState\.quickPhrases, \[\], \[\]\);/);
  assert.match(source, /const showSkeleton = !matchMode && !busyNow &&/);
  // Focused and empty only; a tap sends at once and is remembered.
  assert.match(trigger, /if \(!focusedNow \|\| extractComposerText\(input\)\.length > 0 \|\| dismissedKey === currentKey\)/);
  assert.match(source, /recentSent\.add\(item\.text\);\n\s*composerFocused = false;[\s\S]*?sendSuggestionText\(liveForm/);
  // The suggest3/4 learning (tap / dismiss feedback, frequent messages) is still used.
  assert.match(source, /sendFeedback\('tap', item\.text, items\)/);
  assert.match(source, /frequentCache\.get\(currentKey\)/);
  // The Host's "busy" answer is not a failure: asked again after the turn.
  assert.match(source, /if \(res\?\.source === 'busy'\) return \{ ok: false, busy: true/);
  assert.match(source, /inspectTranscript\(doc, agentId\)/);
  assert.match(source, /\.sand-kit-working-badge/);
});
