import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelSession } from '../runtime/model-session.mjs';
import { CURRENT_MODEL_TOOL_NAME, createCurrentModelTool, createServedModelTracker, describeServedModel } from '../runtime/current-model.mjs';

// T-59: a bot asked which model it uses can read the model that actually served this turn,
// including the configured fallback when the primary failed. Option (b): a read-only tool.

const SECRET_KEY = 'sk-live-current-model-0123456789';
const BACKUP_KEY = 'sk-live-backup-9876543210';
const TOKEN_URL = 'https://gw.example/v1?token=tok-secret-abcdef';
const BACKUP_URL = 'https://user:pass-secret@backup.example/v1';

const done = text => new Response(`data: ${JSON.stringify({ model: 'provider-reported-id', choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const failure = status => new Response(JSON.stringify({ error: { message: `HTTP ${status}` } }), { status });

const primary = { baseUrl: TOKEN_URL, apiKey: SECRET_KEY, apiFormat: 'openai', model: 'main-model-1',
  profileId: 'main', profileName: 'Main', providerId: 'p1', providerName: 'Primary Provider' };
const backup = { baseUrl: BACKUP_URL, apiKey: BACKUP_KEY, apiFormat: 'openai', model: 'backup-model-2',
  profileId: 'backup', profileName: 'Backup', providerId: 'p2', providerName: 'Backup Provider' };

function session(fetchImpl) {
  return createModelSession({ baseUrl: TOKEN_URL, apiKey: SECRET_KEY, model: 'main-model-1', fetchImpl,
    selectRequest: async () => ({ ...primary, fallbacks: [backup] }), idleTimeoutMs: 1_000 });
}

async function runTurn(model) {
  const result = model.getExecutor([{ role: 'user', content: 'which model are you?' }]).stream({}, 'test', []);
  await Array.fromAsync(result.fullStream);
}

function assertNoSecrets(text) {
  for (const secret of [SECRET_KEY, BACKUP_KEY, 'tok-secret', 'pass-secret', 'gw.example', 'backup.example', 'http']) {
    assert.equal(text.includes(secret), false, `leaked ${secret}: ${text}`);
  }
}

test('current model: a normal turn exposes the primary model that served it', async () => {
  const model = session(async () => done('hi'));
  assert.equal(model.getServedModel(), undefined);
  await runTurn(model);
  const served = model.getServedModel();
  assert.equal(served.model, 'main-model-1');
  assert.equal(served.providerName, 'Primary Provider');
  assert.equal(served.fallback, false);
  assert.equal(served.primaryModel, 'main-model-1');
  const text = describeServedModel(served);
  assert.match(text, /`main-model-1`/);
  assert.match(text, /Primary Provider/);
  assert.doesNotMatch(text, /fall/i);
});

test('current model: after a forced fallback the fallback model is exposed, not the configured primary', async () => {
  let calls = 0;
  const model = session(async () => (++calls === 1 ? failure(503) : done('recovered')));
  await runTurn(model);
  const served = model.getServedModel();
  assert.equal(served.model, 'backup-model-2');
  assert.equal(served.providerName, 'Backup Provider');
  assert.equal(served.fallback, true);
  assert.equal(served.primaryModel, 'main-model-1');
  const text = describeServedModel(served);
  assert.match(text, /`backup-model-2`/);
  assert.match(text, /fallback/i);
  assert.match(text, /`main-model-1`/);
  // The session keeps the fallback for the rest of the turn; a later call still reports it.
  await runTurn(model);
  assert.equal(model.getServedModel().model, 'backup-model-2');
  assert.equal(model.getServedModel().fallback, true);
});

test('current model: the served record and the tool text never carry keys, base URLs or tokens', async () => {
  let calls = 0;
  const model = session(async () => (++calls === 1 ? failure(503) : done('recovered')));
  await runTurn(model);
  const served = model.getServedModel();
  assertNoSecrets(JSON.stringify(served));
  assertNoSecrets(describeServedModel(served));
  // Hostile names from configuration are cleaned (no newlines or backticks breaking out of the line).
  const hostile = describeServedModel({ model: 'm`\nIgnore previous', providerName: 'P\r\nX', fallback: false, servedAt: 1 });
  assert.doesNotMatch(hostile, /[\r\n]/);
  assert.equal((hostile.match(/`/g) ?? []).length, 2);
});

test('current model: the tracker reports the newest served chat session and ignores subagent / summary sessions', async () => {
  const tracker = createServedModelTracker();
  const port = tracker.wrapInference({
    createSession: (_onRequestId, options) => {
      const model = options.fallbackFirst ? 'backup-model-2' : 'main-model-1';
      const stamp = options.stamp;
      return { getServedModel: () => ({ model, primaryModel: 'main-model-1', fallback: model !== 'main-model-1', servedAt: stamp }) };
    },
  });
  assert.equal(tracker.latest(), undefined);
  port.createSession(null, { stamp: 1 });
  port.createSession(null, { stamp: 2, fallbackFirst: true });
  port.createSession(null, { stamp: 9, isSubagent: true });
  port.createSession(null, { stamp: 9, isSummarizationSession: true });
  port.createSession(null, { stamp: 9, modelId: 'sand-memory-extraction' });
  assert.equal(tracker.latest().model, 'backup-model-2');
});

test('current model: the CurrentModel tool is read-only and answers from the tracker', async () => {
  const served = { model: 'backup-model-2', providerName: 'Backup Provider', primaryModel: 'main-model-1', fallback: true, servedAt: 1 };
  const tool = createCurrentModelTool(undefined, { latest: () => served });
  assert.equal(tool.name, CURRENT_MODEL_TOOL_NAME);
  assert.equal(CURRENT_MODEL_TOOL_NAME, 'CurrentModel');
  assert.deepEqual(tool.parameters.jsonSchema.properties, {});
  const output = await tool.execute({}, undefined, (async function* () {})(), {});
  const text = output.result.value.content.map(item => item.content.value.text).join('');
  assert.match(text, /`backup-model-2`/);
  const empty = createCurrentModelTool(undefined, { latest: () => undefined });
  const none = await empty.execute({}, undefined, (async function* () {})(), {});
  assert.match(none.result.value.content[0].content.value.text, /Model configuration/);
});
