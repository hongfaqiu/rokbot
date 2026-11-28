// When the Host generates input suggestions (fix/suggest-scenes): only for an idle Bot, once more
// after the turn ends, again when the composer's quotes change (quotes are context, not the user's
// words), and inline completion only where it can fit the draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SuggestionsService,
  SuggestionsSettings,
  buildSuggestionMessages,
  completionDraftAllowed,
  completionFitsDraft,
  entryInProgress,
  extractRecentMessages,
  normalizeQuotes,
} from '../server/suggestions.mjs';
import { Models } from '../server/models.mjs';

const sse = text => new Response(
  `data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-suggest', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

const MODELS = {
  version: 1,
  providers: [{ id: 'cheap', name: 'Cheap', apiFormat: 'openai', baseUrl: 'https://cheap.example/v1', apiKey: 'test-key-not-real' }],
  profiles: [{ id: 'mini', name: 'Mini', providerId: 'cheap', model: 'gpt-suggest', efforts: ['none'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 }],
  defaultRoute: { profileId: 'mini', effort: 'none', fallbacks: [] },
  botRoutes: {},
  scenarioRoutes: { suggestions: { profileId: 'mini', effort: 'none' } },
  migrateLegacyRouting: true,
};

async function fixture(t, { answer = ['看下 upload.spec 的报错', '先修 lint'], completion = '', ...options } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-sug-scenes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = new Models(dir);
  await models.save(MODELS);
  const settings = await new SuggestionsSettings(dir).load();
  const state = {
    running: false,
    entries: [
      { id: 'u1', kind: 'message', role: 'user', content: '跑一下 e2e' },
      { id: 'a1', kind: 'send-message', message: { type: 'text', content: 'e2e 挂了 2 个：upload.spec 和 lint。' } },
    ],
  };
  const calls = [];
  const service = new SuggestionsService({
    models, settings, dataDir: dir, replyPrefetchDelayMs: 5, busyRetryMs: 20, ...options,
    hostCall: async method => {
      if (method === 'listAgents') return [{ id: 'rokbot', isRunning: state.running }, { id: 'other', isRunning: false }];
      return { entries: state.entries };
    },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body);
      return sse(body.max_tokens <= 48 ? completion : JSON.stringify(answer));
    },
  });
  await service.load();
  t.after(() => service.close());
  return { service, state, calls };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const promptOf = call => call.messages.map(message => message.content).join('\n');

test('a running turn gets no suggestions: no model call, nothing cached, the idle Bot gets them', async t => {
  const { service, state, calls } = await fixture(t);
  state.running = true;
  const busy = await service.generate({ agentId: 'rokbot', locale: 'zh-CN' });
  assert.equal(busy.source, 'busy');
  assert.deepEqual(busy.aiSuggestions, []);
  assert.equal(calls.length, 0, 'nothing generated while the turn runs');

  // A streamed reply / running tool call in the transcript is a running turn too.
  state.running = false;
  state.entries.push({ id: 'a2', kind: 'message', role: 'assistant', content: '正在修', isStreaming: true });
  assert.equal((await service.generate({ agentId: 'rokbot', locale: 'zh-CN' })).source, 'busy');
  assert.equal(calls.length, 0);

  // The turn ended: generated now, and not answered from anything made during the turn.
  state.entries.pop();
  const idle = await service.generate({ agentId: 'rokbot', locale: 'zh-CN' });
  assert.equal(idle.source, 'model');
  assert.equal(idle.cached, false);
  assert.deepEqual(idle.aiSuggestions, ['看下 upload.spec 的报错', '先修 lint']);
  assert.equal(calls.length, 1);
});

test('a reply notification in the middle of a turn waits for the end of the turn, then generates once', async t => {
  const { service, state, calls } = await fixture(t);
  state.running = true;
  assert.equal(service.onAgentNotification({ type: 'message', agentId: 'rokbot' }), true);
  await wait(120);
  assert.equal(calls.length, 0, 'the Bot keeps working after its message: nothing generated');
  state.entries.push({ id: 'a2', kind: 'send-message', message: { type: 'text', content: 'upload.spec 修好了，lint 还剩 1 个。' } });
  state.running = false;
  await wait(120);
  assert.equal(calls.length, 1, 'generated once after the turn');
  assert.match(promptOf(calls[0]), /lint 还剩 1 个/, 'from the state at the end of the turn');
  const focus = await service.generate({ agentId: 'rokbot', locale: 'zh-CN' });
  assert.equal(focus.cached, true, 'the focused composer gets the prepared answer');
  assert.equal(calls.length, 1);
});

test('adding or removing a quote is a new state: generated again from the quote, which is not the user\'s words', async t => {
  const { service, calls } = await fixture(t);
  const plain = await service.generate({ agentId: 'rokbot', locale: 'zh-CN' });
  assert.equal(plain.source, 'model');
  const quote = [{ text: 'upload.spec 超时 30s' }];
  const quoted = await service.generate({ agentId: 'rokbot', locale: 'zh-CN', quotes: quote });
  assert.equal(quoted.cached, false, 'a quote added: generated again');
  assert.equal(calls.length, 2);
  const prompt = promptOf(calls[1]);
  assert.match(prompt, /用户正在引用并回复下面的内容[^\n]*不是用户说过的话[^\n]*\n- upload\.spec 超时 30s/);
  // The quote is not listed as something the user sent.
  const sentSection = /用户最近发过（不要重复）：\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? '';
  assert.doesNotMatch(sentSection, /超时 30s/);
  assert.doesNotMatch(promptOf(calls[0]), /引用/);
  // Same quote again: cached. Quote removed: the plain answer again (cached), no extra call.
  assert.equal((await service.generate({ agentId: 'rokbot', locale: 'zh-CN', quotes: quote })).cached, true);
  assert.equal((await service.generate({ agentId: 'rokbot', locale: 'zh-CN' })).cached, true);
  assert.equal(calls.length, 2);
  // Another quote: another state.
  await service.generate({ agentId: 'rokbot', locale: 'zh-CN', quotes: [{ text: 'lint: no-unused-vars' }] });
  assert.equal(calls.length, 3);

  assert.deepEqual(normalizeQuotes([' a  b ', { text: '' }, { id: 'bad id!', text: 'c' }, 'a b', 'd', 'e']), [{ text: 'a b' }, { text: 'c' }, { text: 'd' }]);
  assert.deepEqual(normalizeQuotes('x'), []);
  const english = buildSuggestionMessages([{ role: 'assistant', text: 'Done.' }], 'en', { quotes: [{ text: 'Done.' }] })[1].content;
  assert.match(english, /quoted text, not something the user said/);
});

test('a quoted reply prefix in a user message is not counted as the user\'s own words', () => {
  const messages = extractRecentMessages([
    { id: 'u1', kind: 'message', role: 'user', content: '[In reply to a1: "e2e 挂了 2 个"] 先修第一个' },
    { id: 'a1', kind: 'send-message', message: { type: 'text', content: '[In reply to x: "y"] 不是用户' } },
  ]);
  assert.deepEqual(messages.map(item => item.text), ['先修第一个', '[In reply to x: "y"] 不是用户']);
  assert.equal(entryInProgress({ isStreaming: true }), true);
  assert.equal(entryInProgress({ kind: 'tool-call', status: 'running' }), true);
  assert.equal(entryInProgress({ kind: 'tool-call', status: 'completed' }), false);
});

test('completion: never for /commands, code or a second line, and not when the model rewrites the draft', async t => {
  assert.equal(completionDraftAllowed('帮我看下'), true);
  assert.equal(completionDraftAllowed('/model gpt'), false);
  assert.equal(completionDraftAllowed('  /help'), false);
  assert.equal(completionDraftAllowed('```js\nconst a'), false);
  assert.equal(completionDraftAllowed('run `npm te'), false);
  assert.equal(completionDraftAllowed('run `npm test` an'), true);
  assert.equal(completionDraftAllowed('第一行\n第二'), false);
  assert.equal(completionFitsDraft('帮我看下', '日志'), true);
  assert.equal(completionFitsDraft('帮我看下', '帮你看下日志'), false);
  assert.equal(completionFitsDraft('帮我看下', '日志里的报错'), true);
  assert.equal(completionFitsDraft('run the', ' tests again'), true);
  assert.equal(completionFitsDraft('deplo', 'Run tests'), false);
  assert.equal(completionFitsDraft('deploy', ' to staging'), true);

  const { service, calls } = await fixture(t, { completion: '帮你看下日志' });
  for (const text of ['/model gpt', '```\nconst a', '第一行\n第二']) {
    const out = await service.complete({ agentId: 'rokbot', locale: 'zh-CN', text });
    assert.equal(out.completion, '');
    assert.equal(out.source, 'not-applicable');
  }
  assert.equal(calls.length, 0, 'no model call for a draft that is never completed');
  const misfit = await service.complete({ agentId: 'rokbot', locale: 'zh-CN', text: '帮我看下' });
  assert.equal(calls.length, 1);
  assert.equal(misfit.completion, '', 'the model repeated the draft: not shown');
});
