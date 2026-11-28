// Issue #14: a turn sends a progress line with SendToUser, runs tools, then writes its real
// conclusion as plain assistant text. The conclusion must reach the transcript (and the
// closing-send nudge must fire) instead of leaving the stale progress line as the last reply.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installLocalHarnessBridge } from '../runtime/local-harness-bridge.mjs';
import {
  CLOSING_SEND_NUDGE_PROMPT,
  MAX_CLOSING_SEND_NUDGES,
  trailingUndeliveredAssistantText,
  wrapCreateTurnSettle,
  wrapTurnRuntime,
} from '../runtime/turn-continuity.mjs';

const BOT = '487ddb8b-a062-4bc0-b9b6-814f301db95f';

const toolCall = (toolName, toolCallId, args = {}) => ({ type: 'tool-call', toolName, toolCallId, args });
const toolResult = (toolName, toolCallId) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolName, toolCallId, result: 'ok' }],
});

class FakeDb {
  constructor(entries = []) { this.entries = [...entries]; }
  getTranscriptEntries() { return [...this.entries]; }
  getTranscriptEntryIds() { return new Set(this.entries.map(e => e.id)); }
  appendTranscriptEntry(e) { this.entries.push(e); }
  updateTranscriptEntry(id, fn) { this.entries = this.entries.map(e => (e.id === id ? fn(e) : e)); }
  writeKv() {}
}

// Minimal stand-in for the kernel's createTurnSettle: counts SendToUser deliveries and
// accumulates streamed assistant text for the whole turn, like the 2bb5e41 turn-settle.
function fakeKernelCreateTurnSettle() {
  let text = '';
  let sentMessageCount = 0;
  return {
    collectors: {
      collectText: (delta) => { text += delta; },
      collectSendMessage: () => { sentMessageCount += 1; },
    },
    async settleCompletedTurn() {},
    buildResult: (flags) => ({ text, sentMessageCount, reacted: false, aborted: Boolean(flags.aborted) }),
  };
}

const createTurnSettle = wrapCreateTurnSettle(fakeKernelCreateTurnSettle);

/**
 * Fake runner that plays a scripted turn. Each step is one of
 *   { send: 'text' }  -> SendToUser tool call, delivered to the transcript
 *   { tool: 'Name' }  -> substantive tool call
 *   { text: '...' }   -> plain assistant text (no tool call)
 */
function scriptedRunner(db, script) {
  return {
    run: async (prompt, options = {}) => {
      const messages = [{ role: 'user', content: prompt }];
      const host = { isSubagentRunner: false, latestPromptMessages: () => messages };
      const settle = createTurnSettle(host, {});
      let n = 0;
      for (const step of script) {
        n += 1;
        if (step.send !== undefined) {
          messages.push({ role: 'assistant', content: [toolCall('SendToUser', `send-${n}`, { content: step.send })] });
          messages.push(toolResult('SendToUser', `send-${n}`));
          db.appendTranscriptEntry({
            kind: 'send-message', id: `s-run-${db.entries.length}`,
            message: { type: 'text', content: step.send }, timestampMs: Date.now(),
          });
          settle.collectors.collectSendMessage();
        } else if (step.tool !== undefined) {
          messages.push({ role: 'assistant', content: [toolCall(step.tool, `tool-${n}`)] });
          messages.push(toolResult(step.tool, `tool-${n}`));
        } else if (step.text !== undefined) {
          messages.push({ role: 'assistant', content: [{ type: 'text', text: step.text }] });
          settle.collectors.collectText(step.text);
        }
      }
      await settle.settleCompletedTurn({ hidden: options.hidden === true, trimmedPrompt: prompt });
      return settle.buildResult({ aborted: false });
    },
  };
}

function bridgeWithRunner(script) {
  class MockSendPipeline {}
  installLocalHarnessBridge({
    getHostFlowRecoveryBindings: () => ({ SendPipeline: MockSendPipeline }),
    getHostExecutionRecoveryBindings: () => ({}),
    getHostSessionRecoveryBindings: () => ({}),
    getHostKernelRecoveryBindings: () => ({}),
    getPromptToolsRecoveryBindings: () => ({}),
  }, {});
  const db = new FakeDb([]);
  const runner = scriptedRunner(db, script);
  const sp = new MockSendPipeline();
  sp.nextTurnEpoch = () => 1;
  sp.tm = {
    sessions: {
      ensureActionTarget: async () => {},
      isAgentGone: () => false,
      isServerHostedAgent: () => false,
      resolveBackgroundSession: async (id) => ({ id, db }),
    },
    sessionStore: { markSessionActivity() {} },
    roster: { emit() {}, emitAgentUpdate: async () => {} },
    ensureRunnerRegistry: () => ({ getRunner: () => runner }),
  };
  return { sp, db };
}

const sentTexts = db => db.entries.filter(e => e.kind === 'send-message').map(e => e.message?.content);

test('issue #14: plain-text final answer after a progress SendToUser and a tool call is persisted as a send-message', async () => {
  const { sp, db } = bridgeWithRunner([
    { send: '收到，我去查一下部署状态。' },
    { tool: 'BoxShell' },
    { text: '部署已完成：3 个服务全部健康，版本 1.4.2。' },
  ]);
  const result = await sp.sendPrompt('看看部署好了没', { agentId: BOT, awaitTurn: true });
  assert.equal(result.sentMessageCount, 1, 'the progress line was the only SendToUser');
  assert.deepEqual(sentTexts(db), [
    '收到，我去查一下部署状态。',
    '部署已完成：3 个服务全部健康，版本 1.4.2。',
  ], 'the conclusion must not be dropped just because an earlier progress line was sent');
});

test('issue #14: only the trailing plain-text step is persisted, not text from earlier steps', async () => {
  const { sp, db } = bridgeWithRunner([
    { text: 'Let me check first.' },
    { send: 'Checking now.' },
    { tool: 'BoxShell' },
    { text: 'All green.' },
  ]);
  await sp.sendPrompt('status?', { agentId: BOT, awaitTurn: true });
  assert.deepEqual(sentTexts(db), ['Checking now.', 'All green.']);
});

test('issue #14: trailing plain text already delivered by SendToUser in the same turn is not duplicated', async () => {
  const { sp, db } = bridgeWithRunner([
    { send: 'Checking now.' },
    { tool: 'BoxShell' },
    { send: 'Done: all three services are healthy.' },
    { text: '  Done: all three services are healthy.  ' },
  ]);
  await sp.sendPrompt('status?', { agentId: BOT, awaitTurn: true });
  assert.deepEqual(sentTexts(db), ['Checking now.', 'Done: all three services are healthy.']);
});

test('issue #14: turns ending on a tool call, and hidden turns, never get a fallback send-message', async () => {
  const toolEnd = bridgeWithRunner([{ send: 'Working on it.' }, { tool: 'BoxShell' }]);
  await toolEnd.sp.sendPrompt('go', { agentId: BOT, awaitTurn: true });
  assert.deepEqual(sentTexts(toolEnd.db), ['Working on it.']);

  const hidden = bridgeWithRunner([{ send: 'Working on it.' }, { tool: 'BoxShell' }, { text: 'Internal note.' }]);
  await hidden.sp.sendPrompt('go', { agentId: BOT, awaitTurn: true, hidden: true, appendUserMessage: false });
  assert.deepEqual(sentTexts(hidden.db), ['Working on it.']);
});

test('issue #14: pure-text turns without any SendToUser keep the original whole-text fallback', async () => {
  const { sp, db } = bridgeWithRunner([{ text: 'Just a plain answer.' }]);
  await sp.sendPrompt('hi', { agentId: BOT, awaitTurn: true });
  assert.deepEqual(sentTexts(db), ['Just a plain answer.']);
});

test('trailingUndeliveredAssistantText returns only the last plain-text step after deliveries', () => {
  const base = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [toolCall('SendToUser', 'a')] },
    toolResult('SendToUser', 'a'),
    { role: 'assistant', content: [toolCall('BoxShell', 'b')] },
    toolResult('BoxShell', 'b'),
  ];
  assert.equal(trailingUndeliveredAssistantText(base), '');
  assert.equal(trailingUndeliveredAssistantText([
    ...base,
    { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: ' final ' }] },
  ]), 'final');
  assert.equal(trailingUndeliveredAssistantText([...base, { role: 'assistant', content: 'string final' }]), 'string final');
  assert.equal(trailingUndeliveredAssistantText([
    ...base,
    { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    { role: 'user', content: '<system_reminder>Your response was not visible to the user. Plain assistant text is never shown</system_reminder>' },
  ]), 'final', 'injected visibility reminders after the text are ignored');
  assert.equal(trailingUndeliveredAssistantText([
    ...base,
    { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    { role: 'user', content: 'a brand new question' },
  ]), '', 'text from an earlier turn is never picked up');
});

test('issue #14: work after the last SendToUser flags the result and wrapTurnRuntime sends the hidden closing nudge', async () => {
  const db = new FakeDb([]);
  const runner = scriptedRunner(db, [
    { send: 'On it.' },
    { tool: 'BoxShell' },
    { text: 'Finished: build passed.' },
  ]);
  const firstResult = await runner.run('build it');
  assert.equal(firstResult.sentMessageCount, 1);
  assert.equal(firstResult.endedOnUndeliveredWorkAfterSend, true);
  assert.equal(firstResult.trailingAssistantText, 'Finished: build passed.');

  // The original kernel only nudges on endedOnSilentToolCalls; it ignores this shape.
  class FakeTurnRuntime {
    constructor(tm) { this.tm = tm; }
    async ensureUserReply(_runner, result) {
      return { result, deliveryOwed: false, streamOutputProduced: true };
    }
  }
  wrapTurnRuntime(FakeTurnRuntime, {});
  const runtime = new FakeTurnRuntime({ sendPipeline: { currentTurnEpoch: () => 3 } });

  const nudgeCalls = [];
  const settled = await runtime.ensureUserReply(
    { run: async (prompt, options) => { nudgeCalls.push({ prompt, options }); return { sentMessageCount: 1, reacted: false, aborted: false }; } },
    firstResult, { id: BOT }, 3,
  );
  assert.equal(nudgeCalls.length, 1);
  assert.equal(nudgeCalls[0].prompt, CLOSING_SEND_NUDGE_PROMPT);
  assert.equal(nudgeCalls[0].options.hidden, true);
  assert.equal(settled.result.sentMessageCount, 1);

  // Bounded by maxClosingSendNudges even if the model keeps working silently.
  let capCalls = 0;
  await runtime.ensureUserReply(
    { run: async () => { capCalls += 1; return { sentMessageCount: 0, reacted: false, aborted: false, endedOnSilentToolCalls: true }; } },
    firstResult, { id: BOT }, 3,
  );
  assert.equal(capCalls, MAX_CLOSING_SEND_NUDGES - 1);

  // A turn whose last SendToUser came after all tool work needs no nudge.
  const delivered = await scriptedRunner(new FakeDb(), [{ send: 'On it.' }, { tool: 'BoxShell' }, { send: 'Done.' }]).run('x');
  assert.equal(delivered.endedOnUndeliveredWorkAfterSend, undefined);
  let noNudge = 0;
  await runtime.ensureUserReply({ run: async () => { noNudge += 1; return {}; } }, delivered, { id: BOT }, 3);
  assert.equal(noNudge, 0);
});
