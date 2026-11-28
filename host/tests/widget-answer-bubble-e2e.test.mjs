// showWidgetAnswerBubble (harness-settings.json) on the real 2bb5e41 kernel. Answering a choice card
// (SendToUser type "widget") calls the kernel's WidgetResponses.respondToWidget, which stamps the
// answer on the card and then sends "[Answering your question <id>: "<quote>"]\n<value>" as a user
// prompt. Default (true, or missing/invalid) keeps the upstream user bubble; false records the
// answer on the card and wakes the bot with the same full text, without adding a user message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { loadModelConfig } from '../runtime/config.mjs';
import { Models } from '../server/models.mjs';
import { HarnessSettings, defaultHarnessSettings, readHarnessSettings, validateHarnessSettings } from '../server/harness-settings.mjs';
import { createLocalCapabilities } from '../runtime/host-capabilities.mjs';
import { takeSilentWidgetAnswer, withSilentWidgetAnswer } from '../runtime/local-harness-bridge.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');
const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

test('showWidgetAnswerBubble defaults to true; a missing or invalid stored value reads as true; writes stay strict', async (t) => {
  assert.equal(defaultHarnessSettings.showWidgetAnswerBubble, true);
  assert.equal(readHarnessSettings({}).showWidgetAnswerBubble, true);
  assert.equal(readHarnessSettings(undefined).showWidgetAnswerBubble, true);
  for (const bad of ['no', 'false', 0, 1, null, {}, []]) {
    const read = readHarnessSettings({ showWidgetAnswerBubble: bad, dreaming: true });
    assert.equal(read.showWidgetAnswerBubble, true, `invalid ${JSON.stringify(bad)} falls back to shown`);
    assert.equal(read.dreaming, true, 'other settings are kept');
  }
  assert.equal(readHarnessSettings({ showWidgetAnswerBubble: false }).showWidgetAnswerBubble, false);
  assert.throws(() => validateHarnessSettings({ showWidgetAnswerBubble: 'no' }), /Invalid showWidgetAnswerBubble/);

  const dir = await mkdtemp(join(tmpdir(), 'rokbot-widget-bubble-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = await new HarnessSettings(dir).load();
  assert.equal(settings.current().showWidgetAnswerBubble, true, 'admin GET default');
  assert.equal((await settings.save({ ...settings.current(), showWidgetAnswerBubble: false })).showWidgetAnswerBubble, false);
  await assert.rejects(settings.save({ showWidgetAnswerBubble: 'hidden' }), /Invalid showWidgetAnswerBubble/);

  // The runtime reader the bridge uses: hot reload on refresh(), invalid -> shown, other keys intact.
  const capabilities = await createLocalCapabilities(dir);
  t.after(() => capabilities.close());
  assert.equal(capabilities.get().showWidgetAnswerBubble, false);
  await writeFile(join(dir, 'harness-settings.json'), JSON.stringify({ version: 1, settings: { showWidgetAnswerBubble: 'yes', teachTask: false } }));
  await capabilities.refresh();
  assert.equal(capabilities.get().showWidgetAnswerBubble, true);
  assert.equal(capabilities.get().teachTask, false);
});

test('the silent-answer flag matches only this card\'s noted prompt, once; the group branch\'s bare value never matches', async () => {
  assert.equal(takeSilentWidgetAnswer('[Answering your question c1: "Q"]\nRed'), false, 'outside a hidden answer');
  await withSilentWidgetAnswer('c1', async () => {
    assert.equal(takeSilentWidgetAnswer('Red'), false, 'group branch: bare value keeps the bubble');
    assert.equal(takeSilentWidgetAnswer('[Answering your question c2: "Q"]\nRed'), false, 'another card');
    assert.equal(takeSilentWidgetAnswer('[Answering your question c1: "Q"]\nRed'), true);
    assert.equal(takeSilentWidgetAnswer('[Answering your question c1: "Q"]\nRed'), false, 'consumed: later sends in the woken turn are not silenced');
  });
});

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
}

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.map((part) => part?.text ?? '').join('\n')
  : String(message?.content ?? ''));

async function waitFor(predicate, { timeoutMs = 30_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const COLOR_WIDGET = { prompt: 'Which color?', options: [{ label: 'Red', value: 'I pick red' }, { label: 'Blue', value: 'I pick blue' }] };
const STEP_WIDGET = {
  prompt: 'Trip',
  steps: [
    { prompt: 'Where?', options: [{ label: 'Paris' }, { label: 'Rome' }] },
    { prompt: 'When?', options: [{ label: 'May' }, { label: 'June' }] },
  ],
};

// Mock model (one model for every Bot; each Bot's description carries BOTTAG_<NAME>):
//   - after a tool result: "Done.";
//   - MAKE_SKILL <name> / REMOVE_SKILL <name>: UpdateSkill / RemoveBotResource (posts the Remove / Cancel card);
//   - PROPOSE: call ProposeModelChange (the refusal is the point);
//   - ASK_STEPS / ASK_COLOR (1:1) or GROUP_ASK_<NAME> (group): post a widget card;
//   - an answer ("[Answering your question" or a group line "I pick"): reply GOT_<value> (HOLD waits);
//   - anything else in a group: stay silent; in 1:1: reply OK.
async function harness(t, { harnessSettings } = {}) {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-widget-bubble-e2e-')));
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workSeed = join(stateDir, 'seed');
  await cp(configuredSeed, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));
  if (harnessSettings !== undefined) {
    await writeFile(join(stateDir, 'harness-settings.json'), JSON.stringify({ version: 1, settings: harnessSettings }));
  }
  const tokenFile = join(stateDir, 'internal-host-token');
  await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

  const sse = (res, delta, finish) => res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const toolCall = (res, name, args, id) => {
    sse(res, { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null);
    sse(res, {}, 'tool_calls');
    res.end('data: [DONE]\n\n');
  };
  const say = (res, text) => {
    sse(res, { role: 'assistant', content: text }, 'stop');
    res.end('data: [DONE]\n\n');
  };
  const requests = [];
  let release = () => {};
  const held = { promise: null };
  let calls = 0;
  const llm = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(req.url?.startsWith('/internal/') ? 200 : 404, { 'content-type': 'application/json' });
      res.end(req.url === '/internal/connectors/runtime'
        ? JSON.stringify({ revision: 0, config: { mcpServers: {} }, display: { servers: [] } }) : 'null');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls++;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.filter((m) => m?.role === 'system').map(textOf).join('\n');
    const reminderOnly = (m) => { const s = textOf(m).trimStart(); return s.startsWith('<system_reminder>') && !s.includes('<user_query>'); };
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user' && !reminderOnly(m));
    const results = messages.slice(messages.lastIndexOf(lastUser) + 1).filter((m) => m?.role === 'tool').map(textOf);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (system.includes('GROK_BOT_MEMORY_EXTRACTION')) { say(res, 'Done.'); return; }
    if (body.stream === false) { say(res, 'Done.'); return; }
    const bot = system.match(/BOTTAG_([A-Z]+)/)?.[1] ?? 'UNKNOWN';
    const text = textOf(lastUser);
    const inGroup = text.includes('[Group chat: ');
    const all = messages.map(textOf).join('\n');
    requests.push({ bot, text, inGroup, all, results });
    if (results.length > 0) {
      if (results.some((r) => /asks one question/.test(r))) return toolCall(res, 'SendToUser', { type: 'widget', widget: COLOR_WIDGET }, `call_${calls}`);
      return say(res, 'Done.');
    }
    // State tools may be direct or in the cursor namespace; call them whichever way this turn offers.
    const direct = new Set((body.tools ?? []).map((tool) => tool.function?.name));
    const callState = (name, args) => (direct.has(name)
      ? toolCall(res, name, args, `call_${calls}`)
      : toolCall(res, 'CallDynamicTool', { namespace: 'cursor', toolName: name, arguments: args }, `call_${calls}`));
    const skillToMake = text.match(/MAKE_SKILL (\S+)/)?.[1];
    if (skillToMake) return callState('UpdateSkill', { action: 'write', name: skillToMake, description: 'A test skill', body: '1. Test.' });
    const removeTarget = text.match(/REMOVE_SKILL (\S+)/)?.[1];
    if (removeTarget) return callState('RemoveBotResource', { kind: 'bot-skill', name: removeTarget });
    if (text.includes('PROPOSE')) return toolCall(res, 'ProposeModelChange', { primary: 'model-b' }, `call_${calls}`);
    const answered = text.match(/I pick (\w+)/)?.[1] ?? (text.includes('[Answering your question') ? 'steps' : undefined);
    if (answered && (!inGroup || text.includes('GROUP_') === false)) {
      if (text.includes('HOLD') && !text.includes('It was answering')) {
        await (held.promise ??= new Promise((r) => { release = r; }));
        res.end();
        return;
      }
      if (inGroup && bot !== 'ALPHA') return say(res, 'Nothing to add.');
      return toolCall(res, 'SendToUser', { type: 'text', content: `GOT_${answered.toUpperCase()}` }, `call_${calls}`);
    }
    if (inGroup) {
      if (text.includes(`GROUP_ASK_${bot}`)) return toolCall(res, 'SendToUser', { type: 'widget', widget: COLOR_WIDGET }, `call_${calls}`);
      return say(res, 'Nothing to add.');
    }
    if (text.includes('ASK_STEPS')) return toolCall(res, 'SendToUser', { type: 'widget', widget: STEP_WIDGET }, `call_${calls}`);
    if (text.includes('ASK_COLOR')) return toolCall(res, 'SendToUser', { type: 'widget', widget: COLOR_WIDGET }, `call_${calls}`);
    return say(res, 'OK');
  });
  const base = await listen(llm);
  t.after(() => new Promise((r) => { release(); llm.closeAllConnections?.(); llm.close(r); }));
  const exec = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if ((req.headers['content-type'] || '').includes('application/connect+proto')) {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.end(Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  const execBase = await listen(exec);
  t.after(() => new Promise((r) => { exec.closeAllConnections?.(); exec.close(r); }));

  const modelFile = join(stateDir, 'model.env');
  const env = {
    ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'), ROKBOT_STATE_DIR: stateDir, ROKBOT_DATA_DIR: stateDir,
    ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile, ROKBOT_NOTIFICATION_URL: base,
    ROKBOT_CONNECTORS_URL: `${base}/internal/connectors`, ROKBOT_SHARING_URL: `${base}/internal/sharing`,
    ROKBOT_EXECUTION_URL: execBase, ROKBOT_BOX_TOKEN: 'test-box-token', ROKBOT_MODEL_ENV: modelFile,
    ROKBOT_BACKGROUND_READY_POLL_MS: '50', ROKBOT_PENDING_WAKE_RETRY_MS: '50',
    SAND_DATA_ROOT: join(stateDir, 'host-data'), SAND_BACKEND_URL: 'http://127.0.0.1:9',
    SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_ANALYTICS: '1', SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1', SAND_BOX_MAX_WINDOWS: '1',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  delete process.env.ROKBOT_REMOTE_BOX_DESKTOP;
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await new Models(stateDir, { filename: modelFile }).save({
    version: 1,
    providers: [{ id: 'mock', name: 'Mock Provider', apiFormat: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-e2e-secret-key-0001' }],
    profiles: [
      { id: 'pa', name: 'Model A', providerId: 'mock', model: 'model-a', efforts: [], contextWindowTokens: 64_000 },
      { id: 'pb', name: 'Model B', providerId: 'mock', model: 'model-b', efforts: [], contextWindowTokens: 64_000 },
    ],
    defaultRoute: { profileId: 'pa', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });

  const library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
  await loadRecoveredHostCore(library, reliableDir);
  const hosts = [];
  t.after(async () => { for (const host of hosts) await host.dispose().catch(() => {}); });
  const startHost = async () => {
    const modelConfig = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: modelFile, ROKBOT_DATA_DIR: stateDir } });
    const host = new library.SandHost({
      environment: library.readSandHostEnvironment(process.env),
      startExtensions: createExtensionStarter(library, modelConfig),
    });
    await host.start();
    hosts.push(host);
    return host;
  };
  const setBubble = (value) => writeFile(join(stateDir, 'harness-settings.json'),
    JSON.stringify({ version: 1, settings: { ...defaultHarnessSettings, showWidgetAnswerBubble: value } }));
  return { startHost, requests, stateDir, setBubble, held, release: () => release(), modelFile };
}

const transcriptOf = async (api, id) => {
  const t = await api.getAgentTranscript({ id });
  return Array.isArray(t) ? t : (t?.entries ?? t?.transcript ?? []);
};
const userMessages = (entries) => entries.filter((e) => e?.kind === 'message' && e.role === 'user');
const widgetCards = (entries) => entries.filter((e) => e?.kind === 'send-message' && e.message?.type === 'widget');
const sentText = (entries, text) => entries.some((e) => e?.kind === 'send-message' && JSON.stringify(e.message ?? {}).includes(text));

/** Ask for a card in a 1:1 chat and return it. */
async function askCard(host, api, agentId, prompt, nonce) {
  await api.sendPrompt({ agentId, prompt, clientNonce: nonce });
  await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
  const cards = widgetCards(await transcriptOf(api, agentId)).filter((c) => c.respondedValue == null);
  assert.ok(cards.length > 0, `the bot posted a widget card for ${prompt}`);
  return cards.at(-1);
}

/** Spy on the run lifecycle the client's typing indicator follows (beginSessionRun -> emitAgentUpdate). */
function spyRuns(host, agentId) {
  const lifecycle = host.transcript.runLifecycle;
  const original = lifecycle.beginSessionRun;
  const seen = { begun: 0 };
  lifecycle.beginSessionRun = function (session, ...rest) {
    if (session?.id === agentId) seen.begun++;
    return original.call(this, session, ...rest);
  };
  return { seen, restore: () => { lifecycle.beginSessionRun = original; } };
}

async function answerOrdinaryCard(t, { harnessSettings, expectBubble }) {
  const h = await harness(t, { harnessSettings });
  const host = await h.startHost();
  const api = host.getApi();
  const agentId = (await api.createAgent({ name: 'Card Bot', description: 'BOTTAG_CARD' })).agent.id;
  await api.openAgent({ id: agentId });
  const card = await askCard(host, api, agentId, 'ASK_COLOR please', 'ask-1');
  const usersBefore = userMessages(await transcriptOf(api, agentId)).length;
  const before = h.requests.length;
  const spy = spyRuns(host, agentId);
  const result = await api.respondToWidget({ agentId, entryId: card.id, value: 'I pick red' });
  await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
  spy.restore();
  assert.equal(result?.accepted, true);

  const after = await transcriptOf(api, agentId);
  assert.equal(after.find((e) => e.id === card.id)?.respondedValue, 'I pick red', 'the card records the pick');
  const answerTurn = h.requests.slice(before).find((r) => r.text.includes('I pick red'));
  assert.ok(answerTurn, 'the bot received the answer');
  assert.ok(answerTurn.text.includes(`[Answering your question ${card.id}: "`), 'with the [Answering your question …] prefix');
  assert.ok(sentText(after, 'GOT_RED'), 'the turn continued and the bot replied');
  assert.ok(spy.seen.begun >= 1, 'the run lifecycle (typing indicator) started for the answer turn');
  const newUsers = userMessages(after).slice(usersBefore);
  if (expectBubble) {
    assert.equal(newUsers.length, 1, 'shown: one user bubble');
    assert.equal(newUsers[0].content, 'I pick red', 'shown: the bubble is the answer, without the prefix (as on main)');
  } else {
    assert.deepEqual(newUsers, [], 'hidden: no user message is persisted');
  }

  // The answer stays in the bot's context for the next turn.
  const next = h.requests.length;
  await api.sendPrompt({ agentId, prompt: 'and now?', clientNonce: 'ask-2' });
  await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
  assert.ok(h.requests.slice(next).some((r) => r.all.includes('I pick red')), 'the next turn still has the answer in history');
  return { h, host, api, agentId, card };
}

if (configuredSeed) {
  test('real 2bb5e41 host: default (no setting) keeps the answer bubble exactly as on main', async (t) => {
    await answerOrdinaryCard(t, { harnessSettings: undefined, expectBubble: true });
  });

  test('real 2bb5e41 host: showWidgetAnswerBubble=true keeps the answer bubble', async (t) => {
    await answerOrdinaryCard(t, { harnessSettings: { showWidgetAnswerBubble: true }, expectBubble: true });
  });

  test('real 2bb5e41 host: an invalid showWidgetAnswerBubble falls back to the bubble', async (t) => {
    await answerOrdinaryCard(t, { harnessSettings: { showWidgetAnswerBubble: 'hidden' }, expectBubble: true });
  });

  test('real 2bb5e41 host: showWidgetAnswerBubble=false records the answer on the card, wakes the bot with the full text, adds no user bubble', async (t) => {
    await answerOrdinaryCard(t, { harnessSettings: { showWidgetAnswerBubble: false }, expectBubble: false });
  });

  test('real 2bb5e41 host: the setting is read per answer (no restart), and a hidden answer survives a Host restart', async (t) => {
    const h = await harness(t);
    let host = await h.startHost();
    let api = host.getApi();
    const agentId = (await api.createAgent({ name: 'Card Bot', description: 'BOTTAG_CARD' })).agent.id;
    await api.openAgent({ id: agentId });

    // Switched to hidden while the Host runs: applies to the next answer.
    await h.setBubble(false);
    const first = await askCard(host, api, agentId, 'ASK_COLOR one', 'n-1');
    let users = userMessages(await transcriptOf(api, agentId)).length;
    await api.respondToWidget({ agentId, entryId: first.id, value: 'I pick red' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    assert.equal(userMessages(await transcriptOf(api, agentId)).length, users, 'hidden applied without a restart');

    // Switched back to shown: the next answer has a bubble again.
    await h.setBubble(true);
    const second = await askCard(host, api, agentId, 'ASK_COLOR two', 'n-2');
    users = userMessages(await transcriptOf(api, agentId)).length;
    await api.respondToWidget({ agentId, entryId: second.id, value: 'I pick blue' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    const shown = userMessages(await transcriptOf(api, agentId)).slice(users);
    assert.deepEqual(shown.map((e) => e.content), ['I pick blue']);

    // Hidden again; the Host stops while the answer turn is still running.
    await h.setBubble(false);
    const third = await askCard(host, api, agentId, 'ASK_COLOR three', 'n-3');
    users = userMessages(await transcriptOf(api, agentId)).length;
    const before = h.requests.length;
    const pending = api.respondToWidget({ agentId, entryId: third.id, value: 'I pick green HOLD' }).catch(() => {});
    await waitFor(() => h.requests.slice(before).some((r) => r.text.includes('I pick green HOLD')), { what: 'the held answer turn' });
    const marker = JSON.parse(await readFile(join(h.stateDir, 'host-data', 'host-pending-wakes.json'), 'utf8'));
    assert.ok(JSON.stringify(marker).includes('I pick green HOLD'), 'the in-flight answer turn is tracked for restart recovery');
    await host.dispose();
    h.release();
    await pending;

    host = await h.startHost();
    api = host.getApi();
    const restarted = await transcriptOf(api, agentId);
    assert.equal(restarted.find((e) => e.id === third.id)?.respondedValue, 'I pick green HOLD', 'the card keeps the answer across the restart');
    assert.equal(userMessages(restarted).length, users, 'still no bubble after the restart');
    await waitFor(() => h.requests.slice(before).some((r) => r.text.includes('It was answering') && r.text.includes('I pick green HOLD')),
      { what: 'the recovery wake carrying the interrupted answer' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);

    // The completed hidden answer from before the restart is still in the bot's history.
    const next = h.requests.length;
    await api.sendPrompt({ agentId, prompt: 'after restart', clientNonce: 'n-4' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    assert.ok(h.requests.slice(next).some((r) => r.all.includes('I pick red')), 'the hidden answer survives the restart in history');
  });

  test('real 2bb5e41 host: a multi-step card keeps every merged answer on the card when hidden', async (t) => {
    const h = await harness(t, { harnessSettings: { showWidgetAnswerBubble: false } });
    const host = await h.startHost();
    const api = host.getApi();
    const agentId = (await api.createAgent({ name: 'Trip Bot', description: 'BOTTAG_TRIP' })).agent.id;
    await api.openAgent({ id: agentId });
    const card = await askCard(host, api, agentId, 'ASK_STEPS', 's-1');
    const merged = 'Where?\nRome\n\nWhen?\nJune';
    const users = userMessages(await transcriptOf(api, agentId)).length;
    const before = h.requests.length;
    assert.equal((await api.respondToWidget({ agentId, entryId: card.id, value: merged }))?.accepted, true);
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    const after = await transcriptOf(api, agentId);
    assert.equal(after.find((e) => e.id === card.id)?.respondedValue, merged, 'the card shows the full selection');
    assert.equal(userMessages(after).length, users, 'no bubble');
    const turn = h.requests.slice(before).find((r) => r.text.includes(`[Answering your question ${card.id}:`));
    assert.ok(turn && turn.text.includes('Rome') && turn.text.includes('June'), 'the bot received every answer');
    // A card answers once: a second tap is refused and changes nothing.
    assert.equal((await api.respondToWidget({ agentId, entryId: card.id, value: 'Paris' }))?.accepted, false);
    assert.equal((await transcriptOf(api, agentId)).find((e) => e.id === card.id)?.respondedValue, merged);
  });

  for (const show of [true, false]) {
    test(`real 2bb5e41 host (showWidgetAnswerBubble=${show}): bot-resource removal cards (Remove and Cancel) behave exactly as before`, async (t) => {
      const h = await harness(t, { harnessSettings: { showWidgetAnswerBubble: show } });
      const host = await h.startHost();
      const api = host.getApi();
      const agentId = (await api.createAgent({ name: 'Skills Bot', description: 'BOTTAG_SKILLS' })).agent.id;
      await api.openAgent({ id: agentId });
      const skillNames = () => (host.transcript.sessions.activeSession?.skills?.list?.() ?? []).map((skill) => skill.name);
      for (const name of ['Disposable', 'Keeper']) {
        await api.sendPrompt({ agentId, prompt: `MAKE_SKILL ${name}`, clientNonce: `mk-${name}` });
        await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      }
      assert.deepEqual(skillNames().filter((n) => n === 'Disposable' || n === 'Keeper').sort(), ['Disposable', 'Keeper']);

      const removeCard = await askCard(host, api, agentId, 'REMOVE_SKILL Disposable', 'r-1');
      assert.ok(removeCard.message.widget.resourceRemoval, 'the kernel posted a resource removal card');
      let users = userMessages(await transcriptOf(api, agentId)).length;
      assert.equal((await api.respondToWidget({ agentId, entryId: removeCard.id, value: 'bot-resource:remove' }))?.accepted, true);
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      let after = await transcriptOf(api, agentId);
      assert.equal(skillNames().includes('Disposable'), false, 'Remove removed the skill');
      assert.equal(after.find((e) => e.id === removeCard.id)?.respondedValue, 'bot-resource:remove');
      assert.deepEqual(userMessages(after).slice(users).map((e) => e.content), ['Removed bot-skill "Disposable".'],
        'the removal summary line is posted as before, under either setting');

      const cancelCard = await askCard(host, api, agentId, 'REMOVE_SKILL Keeper', 'r-2');
      users = userMessages(await transcriptOf(api, agentId)).length;
      const before = h.requests.length;
      assert.equal((await api.respondToWidget({ agentId, entryId: cancelCard.id, value: 'Cancel' }))?.accepted, true);
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      after = await transcriptOf(api, agentId);
      assert.equal(skillNames().includes('Keeper'), true, 'Cancel keeps the skill');
      assert.deepEqual(userMessages(after).slice(users).map((e) => e.content), ['Cancel'], 'Cancel keeps its bubble under either setting');
      assert.ok(h.requests.slice(before).some((r) => r.text.includes(`[Answering your question ${cancelCard.id}:`) && r.text.includes('Cancel')));
    });

    test(`real 2bb5e41 host (showWidgetAnswerBubble=${show}): a card answer can never pass as a client-typed message for ProposeModelChange`, async (t) => {
      const h = await harness(t, { harnessSettings: { showWidgetAnswerBubble: show } });
      const host = await h.startHost();
      const api = host.getApi();
      const agentId = (await api.createAgent({ name: 'Card Bot', description: 'BOTTAG_CARD' })).agent.id;
      await api.openAgent({ id: agentId });
      const card = await askCard(host, api, agentId, 'ASK_COLOR', 'p-1');
      const before = h.requests.length;
      // The answer contains the last typed (clientNonce) text, so only provenance tells them apart.
      await api.respondToWidget({ agentId, entryId: card.id, value: 'PROPOSE ASK_COLOR' });
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      const refused = h.requests.slice(before).find((r) => r.results.some((x) => /Refused, nothing changed/.test(x)));
      assert.ok(refused, 'ProposeModelChange refused the card-answer turn');
      assert.match(refused.results.join('\n'), /did not come from the user's client/);
      assert.ok(!(await transcriptOf(api, agentId)).some((e) => e?.message?.type === 'user-form'), 'no confirmation card');
      assert.equal((await new Models(h.stateDir, { filename: h.modelFile }).current()).routing.defaultRoute.profileId, 'pa');
    });

    test(`real 2bb5e41 host (showWidgetAnswerBubble=${show}): a card a group member raises lands in its 1:1 chat and follows the setting there; the room gets no user line`, async (t) => {
      const h = await harness(t, { harnessSettings: { showWidgetAnswerBubble: show } });
      const host = await h.startHost();
      const api = host.getApi();
      const alpha = (await api.createAgent({ name: 'alpha', description: 'BOTTAG_ALPHA' })).agent.id;
      const beta = (await api.createAgent({ name: 'beta', description: 'BOTTAG_BETA' })).agent.id;
      const groupId = (await api.createGroup({ name: '选择小组', memberAgentIds: [alpha, beta], namedBy: 'user' })).agent.id;
      await api.openAgent({ id: groupId });
      await api.sendPrompt({ agentId: groupId, prompt: 'GROUP_ASK_ALPHA', clientNonce: 'g-1' });
      const card = await waitFor(async () => widgetCards(await transcriptOf(api, alpha))[0], { what: 'alpha\'s card in its 1:1 chat' });
      await host.transcript.runLifecycle.drainExclusiveRuns(groupId);
      assert.deepEqual(widgetCards(await transcriptOf(api, groupId)), [], 'the kernel never shows the card in the room');
      const roomUsers = userMessages(await transcriptOf(api, groupId)).length;
      const ownUsers = userMessages(await transcriptOf(api, alpha)).length;
      const before = h.requests.length;
      await api.openAgent({ id: alpha });
      assert.equal((await api.respondToWidget({ agentId: alpha, entryId: card.id, value: 'I pick red' }))?.accepted, true);
      await host.transcript.runLifecycle.drainExclusiveRuns(alpha);
      const own = await transcriptOf(api, alpha);
      assert.equal(own.find((e) => e.id === card.id)?.respondedValue, 'I pick red');
      assert.deepEqual(userMessages(own).slice(ownUsers).map((e) => e.content), show ? ['I pick red'] : []);
      assert.ok(h.requests.slice(before).some((r) => r.bot === 'ALPHA' && r.text.includes(`[Answering your question ${card.id}:`) && r.text.includes('I pick red')),
        'alpha received the full answer');
      assert.equal(userMessages(await transcriptOf(api, groupId)).length, roomUsers, 'no user line in the room either way');
    });
  }
}
