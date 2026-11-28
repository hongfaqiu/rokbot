// T-59 part 2: change the chat model route from the conversation (docs/model-switch-from-chat.md).
// Gate 1 (code): only a visible, client-sent user turn naming the models can propose a change.
// Gate 2 (code): only the user's submit of the Host's one-time confirmation card applies it.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Models } from '../server/models.mjs';
import { loadModelConfig } from '../runtime/config.mjs';
import { createInference } from '../runtime/host-extensions.mjs';
import { createCurrentModelTool, createServedModelTracker } from '../runtime/current-model.mjs';
import {
  MODEL_CHANGE_AUDIT_FILE, createLiveModelRouting, createModelChangeController, createProposeModelChangeTool,
  createTurnProvenance, describeRouteSummary, installModelChangeConfirmation, turnRefusal, userTypedTextForRun,
} from '../runtime/model-change.mjs';

const KEY_1 = 'sk-live-alpha-0123456789abcdef';
const KEY_2 = 'sk-live-anthropic-fedcba9876543210';
const URL_1 = 'https://alpha.example/v1';
const URL_2 = 'https://anthropic-gw.example/v1';
const AGENT = 'bot_one';

const routingInput = () => ({
  version: 1,
  providers: [
    { id: 'p1', name: 'Alpha Cloud', apiFormat: 'openai', baseUrl: URL_1, apiKey: KEY_1 },
    { id: 'p2', name: 'Claude Gateway', apiFormat: 'openai', baseUrl: URL_2, apiKey: KEY_2 },
  ],
  profiles: [
    { id: 'alpha', name: 'Alpha', providerId: 'p1', model: 'gpt-alpha', efforts: ['low', 'high'], contextWindowTokens: 64_000 },
    { id: 'beta', name: 'Beta', providerId: 'p2', model: 'claude-beta', efforts: [], contextWindowTokens: 64_000 },
    { id: 'opus', name: 'Opus', providerId: 'p2', model: 'claude-opus-x', efforts: [], contextWindowTokens: 64_000 },
    { id: 'gamma', name: 'Gamma', providerId: 'p1', model: 'gpt-gamma', efforts: [], contextWindowTokens: 64_000 },
  ],
  defaultRoute: { profileId: 'alpha', effort: 'default', fallbacks: [{ profileId: 'opus', effort: 'default' }] },
  botRoutes: {},
});

class HarnessError extends Error {}
const library = {
  PrivacyMode: { NO_STORAGE: 'no-storage' }, ConnectError: HarnessError, ActionRequiredError: HarnessError,
  NonRetriableError: HarnessError, Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
};

const userTurn = (typedText) => ({ hidden: false, requestSource: 'turn', inAutomationRun: false, group: false, typedText });

async function setup(t, { channel = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rokbot-model-change-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const modelFile = join(dataDir, 'model.env');
  await new Models(dataDir, { filename: modelFile }).save(routingInput());
  const config = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: modelFile, ROKBOT_DATA_DIR: dataDir } });
  const liveRouting = createLiveModelRouting(config);
  const controller = createModelChangeController({
    dataDir, liveRouting, openModels: () => new Models(dataDir, { filename: modelFile }),
  });
  // Fake transcript + kernel UserFormResponses: what reaches the original handlers is recorded.
  const entries = [];
  const kernelCalls = [];
  const posted = [];
  const tm = channel ? {
    userFormResponses: {
      async submitUserForm(args) { kernelCalls.push(['submit', args]); },
      async dismissUserForm(args) { kernelCalls.push(['dismiss', args]); },
    },
  } : {};
  const installed = installModelChangeConfirmation(tm, controller, {
    locate: async (agentId, entryId) => {
      const entry = entries.find(item => item.id === entryId && item.agentId === agentId);
      return entry ? { session: { id: agentId }, entry } : null;
    },
    settle: async ({ entry }, resolution, message) => { entry.formResolution = resolution; posted.push(message); },
  });
  const provenance = createTurnProvenance();
  const tool = createProposeModelChangeTool({}, {
    controller, provenance, agentId: AGENT,
    postCard: async (formRequest, nonce) => {
      entries.push({ id: `send-${entries.length + 1}`, agentId: AGENT, kind: 'send-message',
        message: { type: 'user-form', formRequest }, formRequestId: nonce });
    },
  });
  const call = async (prov, args) => provenance.run(prov, () => runTool(tool, args));
  const cards = () => entries.filter(entry => entry.message?.type === 'user-form');
  const submit = (entry, values = { confirm: 'true' }, agentId = AGENT) =>
    tm.userFormResponses.submitUserForm({ entryId: entry.id, agentId, values, platform: 'desktop' });
  const stored = async () => (await new Models(dataDir, { filename: modelFile }).current()).routing;
  return { dataDir, modelFile, config, liveRouting, controller, tm, installed, entries, kernelCalls, posted, call, cards, submit, stored };
}

async function runTool(tool, args) {
  const stream = (async function* () { yield JSON.stringify(args ?? {}); })();
  const payload = await tool.execute({}, null, stream, {});
  const items = payload?.result?.value?.content ?? [];
  return items.map(item => item?.content?.value?.text ?? '').join('\n');
}

const routeOf = routing => ({
  primary: routing.defaultRoute.profileId,
  fallbacks: routing.defaultRoute.fallbacks.map(item => item.profileId),
});

function assertNoSecrets(text, label) {
  for (const secret of [KEY_1, KEY_2, 'sk-live', URL_1, URL_2, 'alpha.example', 'anthropic-gw.example', 'http']) {
    assert.equal(String(text).includes(secret), false, `${label} leaked ${secret}: ${text}`);
  }
}

test('model change: non-user-originated triggers are refused and post no card', async t => {
  const s = await setup(t);
  const typed = '把主模型换成 claude-beta';
  const refusedRuns = [
    ['no run context', undefined],
    ['hidden wake', { ...userTurn(typed), hidden: true }],
    ['automation', { ...userTurn(typed), requestSource: 'automation' }],
    ['agent message', { ...userTurn(typed), requestSource: 'agent' }],
    ['event', { ...userTurn(typed), requestSource: 'event' }],
    ['form receipt', { ...userTurn(typed), requestSource: 'user-form' }],
    ['group turn', { ...userTurn(typed), group: true }],
    ['automation run', { ...userTurn(typed), inAutomationRun: true }],
    ['host-internal sendPrompt (no client nonce)', userTurn(null)],
  ];
  for (const [label, prov] of refusedRuns) {
    const text = prov ? await s.call(prov, { primary: 'claude-beta' }) : await runTool(
      createProposeModelChangeTool({}, { controller: s.controller, provenance: createTurnProvenance(), agentId: AGENT, postCard: async () => assert.fail('card') }),
      { primary: 'claude-beta' });
    assert.match(text, /^Refused, nothing changed/, label);
  }
  // A model name injected from a web page / tool result that the user never typed is refused.
  const injected = await s.call(userTurn('帮我看看这个网页说了什么'), { primary: 'claude-beta' });
  assert.match(injected, /^Refused, nothing changed: The user's own message must name "claude-beta"/);
  assert.equal(s.cards().length, 0);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'alpha', fallbacks: ['opus'] });

  // The typed text is taken only from a client-sent user message that is this run's prompt.
  const entries = [{ kind: 'message', role: 'user', content: '换成 claude-beta', clientNonce: 'n-1' }];
  assert.equal(userTypedTextForRun(entries, '换成 claude-beta'), '换成 claude-beta');
  assert.equal(userTypedTextForRun([{ ...entries[0], clientNonce: undefined }], '换成 claude-beta'), null);
  assert.equal(userTypedTextForRun(entries, 'Removed skill "x".'), null);
  assert.equal(turnRefusal(userTurn('x')), undefined);
});

test('model change: a user turn without confirmation changes nothing', async t => {
  const s = await setup(t);
  const before = await readFile(s.modelFile, 'utf8');
  const text = await s.call(userTurn('把主模型换成 claude-beta'), { primary: 'claude-beta' });
  assert.match(text, /confirmation card is shown/);
  assert.equal(s.cards().length, 1);
  const [card] = s.cards();
  assert.match(card.message.formRequest.instruction, /gpt-alpha → claude-beta/);
  assert.equal(text.includes(card.formRequestId), false, 'the nonce never reaches the model');
  // Proposal alone, an unticked box, a dismissal: none of them touch the config.
  assert.equal(await readFile(s.modelFile, 'utf8'), before);
  assert.equal(s.liveRouting.routing().defaultRoute.profileId, 'alpha');
  await s.submit(card, { confirm: '' });
  assert.equal(await readFile(s.modelFile, 'utf8'), before);
  assert.equal(card.formResolution, 'dismissed');

  await s.call(userTurn('把主模型换成 claude-beta'), { primary: 'claude-beta' });
  const second = s.cards()[1];
  await s.tm.userFormResponses.dismissUserForm({ entryId: second.id, agentId: AGENT, mode: 'dismissed' });
  assert.equal(await readFile(s.modelFile, 'utf8'), before);
  assert.equal(second.formResolution, 'dismissed');

  // A submit from another Bot's session, or of an ordinary RequestUserForm card, does not apply it.
  await s.call(userTurn('把主模型换成 claude-beta'), { primary: 'claude-beta' });
  const third = s.cards()[2];
  third.agentId = 'bot_other';
  await s.submit(third, { confirm: 'true' }, 'bot_other');
  assert.equal(await readFile(s.modelFile, 'utf8'), before);
  s.entries.push({ id: 'send-x', agentId: AGENT, kind: 'send-message', message: { type: 'user-form', formRequest: {} }, formRequestId: 'kernel-random' });
  await s.submit(s.entries.at(-1));
  assert.deepEqual(s.kernelCalls.map(([kind]) => kind), ['submit'], 'other cards still go to the kernel');
  assert.equal(await readFile(s.modelFile, 'utf8'), before);
  assert.deepEqual(routeOf(s.liveRouting.routing()), { primary: 'alpha', fallbacks: ['opus'] });
});

test('model change: confirmed change applies and the next turn sees the new model via CurrentModel', async t => {
  const s = await setup(t);
  const requests = [];
  const inference = createInference(s.config, library, {}, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body.model);
      return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    },
  });
  const tracker = createServedModelTracker();
  const port = tracker.wrapInference(inference.port);
  const currentModel = createCurrentModelTool({}, tracker, { configured: () => describeRouteSummary(inference.liveModelRouting.summary(AGENT)) });
  const turn = async session => {
    const result = session.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'turn', []);
    await Array.fromAsync(result.fullStream);
    await result.response;
  };

  // The current turn's session is created before the change and keeps the old model.
  const currentTurn = port.createSession(() => {}, { agentId: AGENT });
  await s.call(userTurn('主模型换成 claude-beta'), { primary: 'claude-beta' });
  await s.submit(s.cards()[0]);
  assert.match(s.posted.at(-1), /已修改Host 默认对话模型：主模型 gpt-alpha → claude-beta/);
  assert.match(s.posted.at(-1), /从下一轮对话开始生效/);
  await turn(currentTurn);
  assert.deepEqual(requests, ['gpt-alpha'], 'the turn in progress keeps the old model');

  // Persisted through Models.save (the settings-page store) and live in this process.
  assert.deepEqual(routeOf(await s.stored()), { primary: 'beta', fallbacks: ['opus'] });
  assert.equal(inference.liveModelRouting.routing().defaultRoute.profileId, 'beta');
  const reload = JSON.parse(await readFile(join(s.dataDir, 'model-reload-request.json'), 'utf8'));
  assert.equal(typeof reload.revision, 'string', 'the existing idle-restart path is requested too');

  await turn(port.createSession(() => {}, { agentId: AGENT }));
  assert.deepEqual(requests, ['gpt-alpha', 'claude-beta'], 'the next turn uses the new model');
  const answer = await runTool(currentModel, {});
  assert.match(answer, /This turn is served by `claude-beta` \(Claude Gateway\)/);
  assert.match(answer, /Configured route .*primary `claude-beta` \(Claude Gateway\); fallbacks in order: `claude-opus-x`/);

  // The nonce is one-time: a replayed submit of the same card does nothing more.
  s.cards()[0].formResolution = null;
  await s.submit(s.cards()[0]);
  assert.equal(s.kernelCalls.length, 1, 'a spent card is no longer ours and goes to the kernel (which ignores it)');
});

test('model change: a settings-page change between proposal and confirmation is not overwritten', async t => {
  const s = await setup(t);
  await s.call(userTurn('主模型换成 claude-beta'), { primary: 'claude-beta' });
  await new Models(s.dataDir, { filename: s.modelFile }).save({ ...routingInput(),
    defaultRoute: { profileId: 'gamma', effort: 'default', fallbacks: [] } });
  await s.submit(s.cards()[0]);
  assert.match(s.posted.at(-1), /没有应用/);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'gamma', fallbacks: [] });
});

test('model change: rollback restores the previous route after one confirmation', async t => {
  const s = await setup(t);
  await s.call(userTurn('主模型换成 claude-beta，备用加上 gpt-gamma'), { primary: 'claude-beta', addFallbacks: ['gpt-gamma'] });
  await s.submit(s.cards()[0]);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'beta', fallbacks: ['opus', 'gamma'] });

  const text = await s.call(userTurn('回滚模型修改'), { action: 'rollback' });
  assert.match(text, /confirmation card is shown/);
  assert.match(s.cards()[1].message.formRequest.title, /回滚/);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'beta', fallbacks: ['opus', 'gamma'] }, 'not before confirming');
  await s.submit(s.cards()[1]);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'alpha', fallbacks: ['opus'] });
  assert.deepEqual(routeOf(s.liveRouting.routing()), { primary: 'alpha', fallbacks: ['opus'] });
  assert.match(s.posted.at(-1), /已回滚/);

  const audit = (await readFile(join(s.dataDir, MODEL_CHANGE_AUDIT_FILE), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(audit.map(entry => entry.action), ['change', 'rollback']);
  assert.deepEqual(audit[0].before.route, { profileId: 'alpha', effort: 'default', fallbacks: [{ profileId: 'opus', effort: 'default', order: 0 }] });
  assert.equal(audit[0].after.primary.model, 'claude-beta');
  assert.deepEqual(audit[1].after.route, audit[0].before.route);
});

test('model change: fallback chains can be added to, removed from and replaced', async t => {
  const s = await setup(t);
  await s.call(userTurn('去掉 opus 备用，加上 gpt-gamma 作为备用'), { removeFallbacks: ['opus'], addFallbacks: ['gpt-gamma'] });
  await s.submit(s.cards()[0]);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'alpha', fallbacks: ['gamma'] });

  await s.call(userTurn('备用链改成 claude-beta 然后 claude-opus-x'), { fallbacks: ['claude-beta', 'claude-opus-x'] });
  await s.submit(s.cards()[1]);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'alpha', fallbacks: ['beta', 'opus'] });

  await s.call(userTurn('不要 claude-beta 备用了'), { removeFallbacks: ['claude-beta'] });
  await s.submit(s.cards()[2]);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'alpha', fallbacks: ['opus'] });

  // Unknown models cannot be invented from chat; only configured profiles are choosable.
  const unknown = await s.call(userTurn('加上 gpt-unknown 备用'), { addFallbacks: ['gpt-unknown'] });
  assert.match(unknown, /^Refused, nothing changed: No configured model matches "gpt-unknown"/);
  const ambiguous = await s.call(userTurn('换成 claude'), { primary: 'claude' });
  assert.match(ambiguous, /matches several configured models/);
  assert.equal(s.cards().length, 3);
});

test('model change: no API key, base URL or token leaks into cards, results, messages, audit or CurrentModel', async t => {
  const s = await setup(t);
  const results = [];
  results.push(await s.call(userTurn('主模型换成 claude-beta 去掉 opus'), { primary: 'claude-beta', removeFallbacks: ['opus'] }));
  await s.submit(s.cards()[0]);
  results.push(await s.call(userTurn('回滚'), { action: 'rollback' }));
  await s.submit(s.cards()[1]);
  results.push(await s.call(userTurn('加上 nope-model'), { addFallbacks: ['nope-model'] }));
  for (const text of results) assertNoSecrets(text, 'tool result');
  for (const card of s.cards()) assertNoSecrets(JSON.stringify(card), 'card');
  for (const message of s.posted) assertNoSecrets(message, 'host message');
  assertNoSecrets(await readFile(join(s.dataDir, MODEL_CHANGE_AUDIT_FILE), 'utf8'), 'audit log');
  assertNoSecrets(JSON.stringify(s.liveRouting.summary(AGENT)), 'route summary');
  assertNoSecrets(describeRouteSummary(s.liveRouting.summary(AGENT)), 'CurrentModel route line');
});

test('model change: without the form-submit confirmation channel nothing can be proposed or applied', async t => {
  const s = await setup(t, { channel: false });
  assert.equal(s.installed, false);
  const before = await readFile(s.modelFile, 'utf8');
  const text = await s.call(userTurn('主模型换成 claude-beta'), { primary: 'claude-beta' });
  assert.match(text, /^Refused, nothing changed: The confirmation card channel is not available/);
  assert.equal(s.cards().length, 0);
  assert.equal(await readFile(s.modelFile, 'utf8'), before);
});

test('model change: an expired card does not apply', async t => {
  const s = await setup(t);
  let clock = 1_000;
  const controller = createModelChangeController({ dataDir: s.dataDir, liveRouting: s.liveRouting,
    openModels: () => new Models(s.dataDir, { filename: s.modelFile }), now: () => clock, ttlMs: 10 });
  controller.markConfirmationChannel(true);
  const plan = await controller.plan(AGENT, { primary: 'claude-beta' }, { typedText: 'claude-beta' });
  const { nonce } = controller.propose(plan);
  clock += 11;
  const outcome = await controller.resolve({ nonce, agentId: AGENT, values: { confirm: 'true' } });
  assert.equal(outcome.applied, undefined);
  assert.match(outcome.message, /过期/);
  assert.deepEqual(routeOf(await s.stored()), { primary: 'alpha', fallbacks: ['opus'] });
});
