// T-58 regression: a RequestUserForm card is shown, the user submits it, and nothing happens.
// The 2bb5e41 kernel's UserFormResponses.submitUserForm only wakes the form author for group
// members (wakeFormAuthor returns early when memberAgentId == null); for a 1:1 bot the official
// app relied on the server-hosted agent to resume, which the local runtime does not have. The local
// userForm port also never registered the request with the host's UserFormService.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { createLocalUserFormPort } from '../runtime/local-state-tools.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

test('local userForm port starts a form with a request id and reports no remap hold', async () => {
  const port = createLocalUserFormPort({ sessionExt: {} });
  const started = await port.requestForm({ agentId: 'a1', form: { title: 'T', fields: [] } });
  assert.equal(started.kind, 'started');
  assert.match(started.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(port.hasRemapHold('a1'), false);
  assert.deepEqual(await port.remapTargets({ agentId: 'a1', targets: [] }), { kind: 'no_hold' });
});

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


const USER_FORM_ARGS = {
  title: 'Pick a nickname',
  instruction: 'Tell me what to call you.',
  reason: 'other',
  fields: [{ id: 'nickname', label: 'Nickname', type: 'text', required: true }],
};

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
  const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-user-form-submit-'));
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
      const text = textOf(body);
      const last = body.messages?.at(-1);
      if (text.includes('[The user submitted the form')) {
        sseResponse(res, { content: 'Thanks, got the form.' });
      } else if (last?.role === 'user' && text.includes('show me the form') && !text.includes('Showed the form')) {
        sseResponse(res, { tool_calls: [{ index: 0, id: 'call_form_1', type: 'function', function: { name: 'CallDynamicTool', arguments: JSON.stringify({ namespace: 'cursor', toolName: 'RequestUserForm', arguments: USER_FORM_ARGS }) } }] });
      } else {
        sseResponse(res, { content: 'ok' });
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
  const modelConfig = {
    apiFormat: 'openai',
    baseUrl: `${modelBase}/v1`,
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
    policy: defaultPolicy('gpt-4o-mini'),
    usageDirectory: join(stateDir, 'usage'),
    routingDirectory: join(stateDir, 'routing'),
  };
  const host = new library.SandHost({
    environment: library.readSandHostEnvironment(process.env),
    startExtensions: createExtensionStarter(library, modelConfig),
  });
  await host.start();
  t.after(() => host.dispose());
  return { host, api: host.getApi(), requests };
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

if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 host: submitting a RequestUserForm card resolves it and resumes the 1:1 bot with the receipt', async (t) => {
    const { host, api, requests } = await bootHost(t);
    const created = await api.createAgent({ name: 'Form Bot', description: 'asks with a form' });
    const agentId = created.agent.id;
    await api.openAgent({ id: agentId });
    await api.sendPrompt({ agentId, prompt: 'show me the form', clientNonce: 'form-1' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);

    const formEntry = (await transcriptOf(api, agentId)).find((e) => e?.kind === 'send-message' && e.message?.type === 'user-form');
    assert.ok(formEntry, 'RequestUserForm must post a user-form card');
    assert.equal(formEntry.message.formRequest.title, USER_FORM_ARGS.title);
    assert.equal(typeof formEntry.formRequestId, 'string', 'the card keeps the form request id');
    const requestsBeforeSubmit = requests.length;

    // The box-browser fill itself is upstream code that needs a live box; record what reaches it
    // instead of waiting out the stub box's ensureReady retries.
    const fills = [];
    host.transcript.userFormPort.fill = async (fillAgentId, values) => {
      fills.push({ fillAgentId, values });
      return { outcomes: values.map((entry) => ({ id: entry.field.id, filled: false })) };
    };

    await api.submitUserForm({ agentId, entryId: formEntry.id, values: { nickname: 'Alice' }, platform: 'desktop' });
    await waitFor(async () => {
      const entry = (await transcriptOf(api, agentId)).find((e) => e?.id === formEntry.id);
      return entry?.formResolution != null;
    }, { label: 'form resolution stamp' });
    const resolved = (await transcriptOf(api, agentId)).find((e) => e?.id === formEntry.id);
    assert.equal(resolved.formResolution, 'submitted', 'the card leaves its pending state');
    assert.equal(fills.length, 1, 'the host receives the submission');
    assert.equal(fills[0].fillAgentId, agentId);
    assert.deepEqual(fills[0].values.map((entry) => [entry.field.id, entry.value]), [['nickname', 'Alice']]);

    const resumed = await waitFor(
      () => requests.slice(requestsBeforeSubmit).find((body) => textOf(body).includes('[The user submitted the form "Pick a nickname"')),
      { label: 'bot resumed with the form receipt' },
    );
    assert.ok(!textOf(resumed).includes('Alice'), 'submitted values never enter the model conversation');
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    const after = await transcriptOf(api, agentId);
    const resumeIndex = after.findIndex((e) => e?.id === formEntry.id);
    assert.ok(
      after.slice(resumeIndex + 1).some((e) => JSON.stringify(e).includes('Thanks, got the form.')),
      'the resumed turn delivers its reply into the chat',
    );
    assert.ok(
      !after.some((e) => e?.kind === 'user-message' && JSON.stringify(e).includes('[The user submitted the form')),
      'the receipt is a hidden wake, not a visible user message',
    );
  });

  test('real 2bb5e41 host: dismissing a RequestUserForm card resumes the 1:1 bot with the dismissed receipt', async (t) => {
    const { host, api, requests } = await bootHost(t);
    const created = await api.createAgent({ name: 'Form Bot', description: 'asks with a form' });
    const agentId = created.agent.id;
    await api.openAgent({ id: agentId });
    await api.sendPrompt({ agentId, prompt: 'show me the form', clientNonce: 'form-2' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    const formEntry = (await transcriptOf(api, agentId)).find((e) => e?.kind === 'send-message' && e.message?.type === 'user-form');
    assert.ok(formEntry);
    const before = requests.length;
    await api.dismissUserForm({ agentId, entryId: formEntry.id, mode: 'dismissed', platform: 'desktop' });
    await waitFor(
      () => requests.slice(before).find((body) => textOf(body).includes('[The user dismissed your form "Pick a nickname"')),
      { label: 'bot resumed with the dismissed receipt' },
    );
    const resolved = (await transcriptOf(api, agentId)).find((e) => e?.id === formEntry.id);
    assert.equal(resolved.formResolution, 'dismissed');
  });
}
