// T-59 part 2 on the real 2bb5e41 kernel: a client-sent user message makes the bot call
// ProposeModelChange, the Host posts a user-form confirmation card, and only the user's
// submitUserForm on that card changes model.env; the next turn uses the new model. A Host-internal
// sendPrompt (no clientNonce) with the same words is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { loadModelConfig } from '../runtime/config.mjs';
import { Models } from '../server/models.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const configuredArchive = process.env.ROKBOT_TEST_HOST_ARCHIVE || process.env.PROKBOT_TEST_HOST_ARCHIVE;

async function materializeSeed(stateDir) {
  let seedDir = configuredSeed;
  if (!seedDir) {
    const matOut = join(stateDir, 'materialized');
    const res = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [join(HOST_DIR, 'release/patch-host.py'), '--archive', configuredArchive, '--output', matOut],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.ifError(res.error);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    seedDir = join(matOut, 'seed');
  }
  const workSeed = join(stateDir, 'seed');
  await cp(seedDir, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));
  return { workSeed, reliableDir };
}

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
}

function closeServer(server) {
  return new Promise((done) => { server.closeAllConnections?.(); server.close(done); });
}



function sseResponse(res, delta) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const textOf = (body) => (body.messages ?? [])
  .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
  .join('\n');

async function bootHost(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-model-change-e2e-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { workSeed, reliableDir } = await materializeSeed(stateDir);
  const tokenFile = join(stateDir, 'internal-host-token');
  await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

  const requests = [];
  const modelServer = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const last = body.messages?.at(-1);
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      if (last?.role === 'user' && lastText.includes('换成 model-b')) {
        sseResponse(res, { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'ProposeModelChange', arguments: JSON.stringify({ primary: 'model-b' }) } }] });
      } else {
        sseResponse(res, { content: `ok from ${body.model}` });
      }
      return;
    }
    if (req.url === '/internal/connectors/runtime') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 0, config: { mcpServers: {} }, display: { servers: [] } }));
      return;
    }
    if (req.url?.startsWith('/internal/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('null');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const modelBase = await listen(modelServer);
  t.after(() => closeServer(modelServer));

  const execServer = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/connect+proto')) {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.end(Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  const execBase = await listen(execServer);
  t.after(() => closeServer(execServer));

  const envOverrides = {
    ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'),
    ROKBOT_STATE_DIR: stateDir,
    ROKBOT_DATA_DIR: stateDir,
    ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
    ROKBOT_NOTIFICATION_URL: modelBase,
    ROKBOT_CONNECTORS_URL: `${modelBase}/internal/connectors`,
    ROKBOT_SHARING_URL: `${modelBase}/internal/sharing`,
    ROKBOT_EXECUTION_URL: execBase,
    ROKBOT_BOX_TOKEN: 'test-box-token',
    ROKBOT_REMOTE_BOX_DESKTOP: undefined,
    ROKBOT_MODEL_ENV: undefined,
    SAND_DATA_ROOT: join(stateDir, 'host-data'),
    SAND_BACKEND_URL: 'http://127.0.0.1:9',
    SAND_DISABLE_TELEMETRY: '1',
    SAND_DISABLE_ANALYTICS: '1',
    SAND_HOST_IN_BOX: '1',
    SAND_PACKAGED: '1',
    SAND_BOX_MAX_WINDOWS: '1',
  };
  const prevEnv = new Map();
  for (const [k, v] of Object.entries(envOverrides)) {
    prevEnv.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of prevEnv.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const require = createRequire(import.meta.url);
  const library = require(join(workSeed, 'host-library-reliable.cjs'));
  await loadRecoveredHostCore(library, reliableDir);
  const modelFile = join(stateDir, 'model.env');
  process.env.ROKBOT_MODEL_ENV = modelFile;
  await new Models(stateDir, { filename: modelFile }).save({
    version: 1,
    providers: [{ id: 'mock', name: 'Mock Provider', apiFormat: 'openai', baseUrl: `${modelBase}/v1`, apiKey: 'sk-e2e-secret-key-0001' }],
    profiles: [
      { id: 'pa', name: 'Model A', providerId: 'mock', model: 'model-a', efforts: [], contextWindowTokens: 64_000 },
      { id: 'pb', name: 'Model B', providerId: 'mock', model: 'model-b', efforts: [], contextWindowTokens: 64_000 },
    ],
    defaultRoute: { profileId: 'pa', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  const modelConfig = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: modelFile, ROKBOT_DATA_DIR: stateDir } });
  const host = new library.SandHost({
    environment: library.readSandHostEnvironment(process.env),
    startExtensions: createExtensionStarter(library, modelConfig),
  });
  await host.start();
  t.after(() => host.dispose());
  return { host, api: host.getApi(), requests, stateDir, modelFile };
}

async function waitFor(predicate, { timeoutMs = 20_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const transcriptOf = async (api, agentId) => {
  const t = await api.getAgentTranscript({ id: agentId });
  return Array.isArray(t) ? t : (t?.entries ?? t?.transcript ?? []);
};


const toolResultText = (body) => (body.messages ?? []).filter((m) => m.role === 'tool')
  .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');

if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 host: a user asks in chat, confirms the card, and the next turn runs on the new model', async (t) => {
    const { host, api, requests, stateDir, modelFile } = await bootHost(t);
    const created = await api.createAgent({ name: 'Model Bot', description: 'switches models' });
    const agentId = created.agent.id;
    await api.openAgent({ id: agentId });
    const routeOf = async () => (await new Models(stateDir, { filename: modelFile }).current()).routing.defaultRoute.profileId;

    // A Host-internal sendPrompt (no clientNonce) with the same words is refused in code.
    await api.sendPrompt({ agentId, prompt: '把主模型换成 model-b' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    const refused = requests.find((body) => toolResultText(body).includes('ProposeModelChange') || /Refused, nothing changed/.test(toolResultText(body)));
    assert.ok(refused, 'the tool ran and its result reached the model');
    assert.match(toolResultText(refused), /Refused, nothing changed: the message for this run did not come from the user's client/);
    assert.ok(!(await transcriptOf(api, agentId)).some((e) => e?.message?.type === 'user-form'), 'no card for a Host-internal prompt');

    // The user's own client message: a confirmation card, nothing changed yet.
    const before = requests.length;
    await api.sendPrompt({ agentId, prompt: '把主模型换成 model-b', clientNonce: 'mc-1' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    const proposed = requests.slice(before).find((body) => /confirmation card is shown/.test(toolResultText(body)));
    assert.ok(proposed, 'the tool proposed the change');
    const card = (await transcriptOf(api, agentId)).find((e) => e?.kind === 'send-message' && e.message?.type === 'user-form');
    assert.ok(card, 'the Host posted a user-form confirmation card');
    assert.match(card.message.formRequest.instruction, /model-a → model-b/);
    assert.equal(typeof card.formRequestId, 'string');
    assert.equal(JSON.stringify(requests).includes(card.formRequestId), false, 'the nonce never reaches the model');
    assert.equal(await routeOf(), 'pa');
    assert.ok(requests.slice(before).every((body) => body.model === 'model-a'), 'the proposing turn stays on the old model');

    // The user submits the card through the normal gateway method.
    await api.submitUserForm({ agentId, entryId: card.id, values: { confirm: 'true' }, platform: 'desktop' });
    await waitFor(async () => (await routeOf()) === 'pb', { label: 'model.env updated' });
    const after = await transcriptOf(api, agentId);
    assert.equal(after.find((e) => e?.id === card.id)?.formResolution, 'submitted');
    assert.ok(after.some((e) => e?.kind === 'send-message' && /已修改Host 默认对话模型：主模型 model-a → model-b/.test(JSON.stringify(e.message))),
      'the Host posts the result into the chat');
    const audit = await readFile(join(stateDir, 'model-change-audit.jsonl'), 'utf8');
    assert.equal(audit.includes('sk-e2e-secret-key'), false);
    assert.equal(audit.includes('127.0.0.1'), false);

    const next = requests.length;
    await api.sendPrompt({ agentId, prompt: 'hello again', clientNonce: 'mc-2' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    assert.ok(requests.length > next);
    assert.ok(requests.slice(next).every((body) => body.model === 'model-b'), 'the next turn runs on the new model');
  });
}
