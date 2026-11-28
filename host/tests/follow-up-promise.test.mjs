// Unit checks for the "I'll get back to you" follow-through (see follow-up-promise-wake-e2e.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  promisesLaterReport,
  schedulesFutureWork,
  UNBACKED_PROMISE_NUDGE_PROMPT,
  WAKE_PLAIN_TEXT_NUDGE_PROMPT,
} from '../runtime/follow-up-promise.mjs';
import { currentTurnToolNames, wrapCreateTurnSettle } from '../runtime/turn-continuity.mjs';
import { BackgroundRecovery } from '../runtime/background-recovery.mjs';

test('promisesLaterReport recognises English and Chinese promises of a later report', () => {
  for (const text of [
    "I'm running the build check now and will get back to you in a moment.",
    'Let me check that and get back to you shortly.',
    "On it. I'll report back once the export is done.",
    "I'll let you know as soon as the upload finishes.",
    'Once it is ready I will send you the results.',
    'Give me a minute.',
    'Hang tight, this takes a while.',
    'Let me check.',
    'Good question, let me look into it…',
    '我去跑一下，稍后告诉你结果。',
    '好的，完成后通知你。',
    '请稍等，我查一下。',
    '收到，我先查一下',
    '跑完之后我向你汇报。',
  ]) {
    assert.equal(promisesLaterReport(text), true, text);
  }
});

test('promisesLaterReport stays quiet on complete answers', () => {
  for (const text of [
    'The answer is 42.',
    'Done: the build passed and all 312 tests are green.',
    'Let me know if you need anything else.',
    "I'll tell you the answer: it is 42.",
    'I can tell you more later if you want.',
    'Tell me when you are back and we can continue.',
    'Let me check whether the file exists: it does, at /tmp/a.txt.',
    '答案是 42。',
    '完成后告诉我，我们再继续。',
    '已经全部处理好了。',
    '',
    undefined,
  ]) {
    assert.equal(promisesLaterReport(text), false, String(text));
  }
});

test('schedulesFutureWork spots routine and reminder tools', () => {
  assert.equal(schedulesFutureWork(['SendToUser', 'UpdateRoutine']), true);
  assert.equal(schedulesFutureWork(['CallDynamicTool', 'ScheduleWakeup']), true);
  assert.equal(schedulesFutureWork(['SendToUser', 'Shell', 'Read']), false);
  assert.equal(schedulesFutureWork(undefined), false);
});

test('the nudge prompts carry the instruction to stay quiet when nothing is owed', () => {
  assert.match(WAKE_PLAIN_TEXT_NUDGE_PROMPT, /SendToUser/);
  assert.match(WAKE_PLAIN_TEXT_NUDGE_PROMPT, /end your turn now with no text and no SendToUser/);
  assert.match(UNBACKED_PROMISE_NUDGE_PROMPT, /nothing is running that will wake you/);
  assert.match(UNBACKED_PROMISE_NUDGE_PROMPT, /end your turn now with no text and no SendToUser/);
});

const call = (toolName, toolCallId, input = {}) => ({ type: 'tool-call', toolName, toolCallId, input });

test('currentTurnToolNames lists this turn only, including dynamic tool names', () => {
  const messages = [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: [call('UpdateRoutine', 'old')] },
    { role: 'user', content: 'now' },
    { role: 'assistant', content: [call('CallDynamicTool', 'a', { namespace: 'cursor', toolName: 'Task' })] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'CallDynamicTool', toolCallId: 'a', result: 'ok' }] },
    { role: 'assistant', content: [call('SendToUser', 'b', { content: 'hi' })] },
  ];
  assert.deepEqual(currentTurnToolNames(messages), ['CallDynamicTool', 'Task', 'SendToUser']);
  assert.deepEqual(currentTurnToolNames([]), []);
});

test('turn settle reports trailing plain text and tool names for hidden turns too', async () => {
  const messages = [
    { role: 'user', content: '[A background task just completed] ...' },
    { role: 'assistant', content: [{ type: 'text', text: 'BUILD_RESULT: 3 tests failed.' }] },
  ];
  const createTurnSettle = wrapCreateTurnSettle(() => ({
    collectors: {},
    async settleCompletedTurn() {},
    buildResult: () => ({ text: 'BUILD_RESULT: 3 tests failed.', sentMessageCount: 0 }),
  }));
  const settle = createTurnSettle({ isSubagentRunner: false, latestPromptMessages: () => messages }, {});
  await settle.settleCompletedTurn({ hidden: true, trimmedPrompt: messages[0].content });
  const result = settle.buildResult({});
  assert.equal(result.trailingAssistantText, 'BUILD_RESULT: 3 tests failed.');
  assert.deepEqual(result.turnToolNames, []);
  assert.equal(result.endedOnUndeliveredWorkAfterSend, undefined, 'hidden turns keep the closing-send flags off');
});

test('BackgroundRecovery.hasPendingWork counts running and undelivered work, not turn markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rokbot-follow-up-'));
  try {
    const recovery = new BackgroundRecovery({ filePath: join(dir, 'wakes.json'), deliver: async () => 'delivered' });
    assert.equal(recovery.hasPendingWork('a1'), false);
    recovery.store.upsert({ agentId: 'a1', kind: 'turn', workId: 't1', status: 'running', markedAtMs: 1 }, { flush: false });
    assert.equal(recovery.hasPendingWork('a1'), false, 'an in-flight turn marker is not background work');
    recovery.store.upsert({ agentId: 'a1', kind: 'shell', workId: 's1', status: 'running', markedAtMs: 1 }, { flush: false });
    assert.equal(recovery.hasPendingWork('a1'), true);
    assert.equal(recovery.hasPendingWork('other'), false);
    recovery.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn settle flags tool work after the last send for hidden turns, not chatter after it', async () => {
  const build = (messages) => wrapCreateTurnSettle(() => ({
    collectors: {}, async settleCompletedTurn() {}, buildResult: () => ({ text: '', sentMessageCount: 1 }),
  }))({ isSubagentRunner: false, latestPromptMessages: () => messages }, {});
  const sendThen = (...rest) => [
    { role: 'user', content: '[A background task just completed] ...' },
    { role: 'assistant', content: [call('SendToUser', 's', { content: 'progress' })] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'SendToUser', toolCallId: 's', result: 'ok' }] },
    ...rest,
  ];
  const worked = build(sendThen(
    { role: 'assistant', content: [call('Shell', 'w')] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'Shell', toolCallId: 'w', result: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Result: 3 failed.' }] },
  ));
  await worked.settleCompletedTurn({ hidden: true });
  assert.equal(worked.buildResult({}).workAfterLastSend, true);
  const chatter = build(sendThen({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }));
  await chatter.settleCompletedTurn({ hidden: true });
  assert.equal(chatter.buildResult({}).workAfterLastSend, undefined);
});
