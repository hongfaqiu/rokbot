import test from 'node:test';
import assert from 'node:assert/strict';

import { withLocalGroups, installLocalGroups } from '../runtime/local-groups.mjs';

// Unit checks run everywhere. The real-seed end-to-end checks need the materialized 2bb5e41 seed:
//   ROKBOT_TEST_HOST_SEED=/tmp/rokbot-seed/seed node --test host/tests/local-group-chat-e2e.test.mjs
const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

test('withLocalGroups sends createGroup to the local manager, not the server proxy', async () => {
  const calls = [];
  const api = {
    createGroup: async () => { throw new Error('Official account authentication is unavailable in the local workspace runtime'); },
    setGroupMembers: async () => 'kept',
  };
  const manager = { createGroup: async (args) => { calls.push(args); return { agent: { id: `g${calls.length}`, name: args.name }, transcript: [] }; } };
  const local = withLocalGroups(api, manager);
  const created = await local.createGroup({ name: '研发群', description: 'd', memberAgentIds: ['a', 'b'], namedBy: 'user', humanMemberUserIds: [1] });
  assert.deepEqual(created, { agent: { id: 'g1', name: '研发群' }, transcript: [] });
  assert.deepEqual(calls, [{ name: '研发群', description: 'd', memberIds: ['a', 'b'], namedBy: 'user' }]);
  assert.equal(await local.setGroupMembers(), 'kept', 'other methods are untouched');
});

test('withLocalGroups answers a retried clientNonce with the first group', async () => {
  let n = 0;
  const manager = { createGroup: async () => ({ agent: { id: `g${++n}` } }) };
  const local = withLocalGroups({}, manager);
  const a = await local.createGroup({ name: 'x', memberAgentIds: ['a'], clientNonce: 'n1' });
  const b = await local.createGroup({ name: 'x', memberAgentIds: ['a'], clientNonce: 'n1' });
  const c = await local.createGroup({ name: 'x', memberAgentIds: ['a'], clientNonce: 'n2' });
  assert.equal(a.agent.id, 'g1');
  assert.equal(b.agent.id, 'g1');
  assert.equal(c.agent.id, 'g2');
});

test('withLocalGroups forgets a failed clientNonce so the client can retry', async () => {
  let fail = true;
  const manager = { createGroup: async () => { if (fail) throw new Error('A group needs at least one existing member agent.'); return { agent: { id: 'g' } }; } };
  const local = withLocalGroups({}, manager);
  await assert.rejects(local.createGroup({ name: 'x', memberAgentIds: [], clientNonce: 'n' }), /at least one existing member/);
  fail = false;
  assert.equal((await local.createGroup({ name: 'x', memberAgentIds: ['a'], clientNonce: 'n' })).agent.id, 'g');
});

test('installLocalGroups patches SandHost#getApi once', async () => {
  class SandHost {
    constructor() { this.transcript = { createGroup: async (args) => ({ agent: { id: 'local', name: args.name } }) }; }
    getApi() { return { createGroup: async () => { throw new Error('server'); }, listAgents: async () => [] }; }
  }
  const library = { SandHost };
  installLocalGroups(library);
  const once = SandHost.prototype.getApi;
  installLocalGroups(library);
  assert.equal(SandHost.prototype.getApi, once, 'idempotent');
  const api = new SandHost().getApi();
  assert.equal((await api.createGroup({ name: 'n', memberAgentIds: ['a'] })).agent.id, 'local');
  assert.deepEqual(await api.listAgents(), []);
});

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function realHostHarness(t) {
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const { cp, mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
  const { defaultPolicy } = await import('../runtime/model-policy.mjs');
  const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
  const HOST_DIR = resolve(import.meta.dirname, '..');

  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-group-')));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const workSeed = join(stateDir, 'seed');
  await cp(configuredSeed, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

  const textOf = (message) => (Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
    : String(message?.content ?? ''));
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
  let calls = 0;
  const llm = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(req.url?.startsWith('/internal/') ? 200 : 404, { 'content-type': 'application/json' });
      res.end('null');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.filter((m) => m?.role === 'system').map(textOf).join('\n');
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const answered = messages.slice(messages.lastIndexOf(lastUser) + 1).some((m) => m?.role === 'tool');
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (system.includes('GROK_BOT_MEMORY_EXTRACTION')) { say(res, 'Done.'); return; }
    const bot = system.match(/BOTTAG_([A-Z]+)/)?.[1] ?? 'UNKNOWN';
    const text = textOf(lastUser);
    requests.push({ bot, text, system, messages, tools: (body.tools ?? []).map((tool) => tool.function?.name) });
    if (answered) { say(res, 'Done.'); return; }
    toolCall(res, 'SendToUser', { type: 'text', content: `REPLY_${bot}` }, `call_${calls}`);
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { llm.closeAllConnections?.(); llm.close(r); }));
  const base = `http://127.0.0.1:${llm.address().port}`;
  const exec = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => exec.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { exec.closeAllConnections?.(); exec.close(r); }));
  const tokenFile = join(stateDir, 'internal-host-token');
  await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

  const env = {
    ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'), ROKBOT_STATE_DIR: stateDir, ROKBOT_DATA_DIR: stateDir,
    ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile, ROKBOT_INTERNAL_HOST_URL: base, ROKBOT_NOTIFICATION_URL: base,
    ROKBOT_CONNECTORS_URL: `${base}/internal/connectors`, ROKBOT_SHARING_URL: `${base}/internal/sharing`,
    ROKBOT_EXECUTION_URL: `http://127.0.0.1:${exec.address().port}`, ROKBOT_BOX_TOKEN: 'test-box-token',
    SAND_DATA_ROOT: join(stateDir, 'host-data'), SAND_BACKEND_URL: 'http://127.0.0.1:9',
    SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_ANALYTICS: '1', SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1', SAND_BOX_MAX_WINDOWS: '1',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
  await loadRecoveredHostCore(library, reliableDir);
  const startHost = async () => {
    const host = new library.SandHost({
      environment: library.readSandHostEnvironment(process.env),
      startExtensions: createExtensionStarter(library, {
        apiFormat: 'openai', baseUrl: `${base}/v1`, apiKey: 'test-key', model: 'gpt-4o-mini',
        policy: defaultPolicy('gpt-4o-mini'), usageDirectory: join(stateDir, 'usage'), routingDirectory: join(stateDir, 'routing'),
      }),
    });
    await host.start();
    return host;
  };
  return { startHost, requests, stateDir, library };
}

const groupOf = async (api, id) => (await api.listAgents()).find((agent) => agent.id === id);

/** The Host's own gateway server on a random loopback port (never the production 1340). */
async function startGateway(t, library, host) {
  const gateway = await library.startGatewayServer({
    api: host.getApi(), subscribe: (listener) => host.subscribe(listener),
    getHealth: () => host.getHealth(), startedAt: host.startedAt, host: '127.0.0.1', port: 0,
  });
  t.after(() => gateway.close());
  return async (method, args) => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
    });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  };
}

if (configuredSeed) {
  test('real 2bb5e41 Host creates a named local group over its gateway, edits members, and keeps it across a restart', async (t) => {
    const h = await realHostHarness(t);
    let groupId, alpha, beta, gamma;
    const first = await h.startHost();
    try {
      const api = first.getApi();
      const rpc = await startGateway(t, h.library, first);
      alpha = (await api.createAgent({ name: 'alpha', description: 'BOTTAG_ALPHA' })).agent.id;
      beta = (await api.createAgent({ name: 'beta', description: 'BOTTAG_BETA' })).agent.id;
      gamma = (await api.createAgent({ name: 'gamma', description: 'BOTTAG_GAMMA' })).agent.id;

      // What the clients send from "+ 创建群聊".
      const created = await rpc('createGroup', { name: '发布小组', memberAgentIds: [alpha, beta], namedBy: 'user', clientNonce: 'group-1' });
      assert.equal(created.status, 200, created.text);
      assert.doesNotMatch(created.text, /Official account authentication|unavailable in the local workspace runtime/);
      assert.match(created.text, /发布小组/);
      const listed = (await api.listAgents()).find((agent) => agent.isGroup);
      assert.ok(listed, 'the group is listed');
      groupId = listed.id;
      assert.equal(listed.name, '发布小组');
      assert.deepEqual([...listed.memberIds].sort(), [alpha, beta].sort());
      const retried = await rpc('createGroup', { name: '发布小组', memberAgentIds: [alpha, beta], namedBy: 'user', clientNonce: 'group-1' });
      assert.equal(retried.status, 200, retried.text);
      assert.equal((await api.listAgents()).filter((agent) => agent.isGroup).length, 1, 'a retried request does not make a second group');

      // Add gamma, remove beta.
      const edited = await rpc('setGroupMembers', { id: groupId, memberAgentIds: [alpha, gamma] });
      assert.equal(edited.status, 200, edited.text);
      assert.deepEqual([...(await groupOf(api, groupId)).memberIds].sort(), [alpha, gamma].sort());

      // A group needs at least one existing Bot; the local kernel's own check answers.
      const empty = await rpc('createGroup', { name: 'empty', memberAgentIds: [] });
      assert.notEqual(empty.status, 200);
      assert.match(empty.text, /at least one existing member/);

      await api.openAgent({ id: groupId });
      await api.sendPrompt({ agentId: groupId, prompt: 'GROUP_HELLO everyone', clientNonce: 'g-hello' });
      await waitFor(async () => JSON.stringify(await api.getAgentTranscript({ id: groupId })).includes('REPLY_'), { what: 'a reply in the group' });
      await first.transcript.runLifecycle.drainExclusiveRuns(groupId);
    } finally {
      await first.dispose();
    }

    const second = await h.startHost();
    try {
      const api = second.getApi();
      const listed = await groupOf(api, groupId);
      assert.equal(listed?.name, '发布小组');
      assert.equal(listed.isGroup, true);
      assert.deepEqual([...listed.memberIds].sort(), [alpha, gamma].sort());
      const transcript = JSON.stringify(await api.getAgentTranscript({ id: groupId }));
      for (const text of ['GROUP_HELLO everyone', 'REPLY_']) assert.ok(transcript.includes(text), `${text} kept after restart`);
    } finally {
      await second.dispose();
    }
  });

  // 2bb5e41 runs member turns only for server-hosted (temporal) members: GroupChatGlue#runGroupMemberTurn
  // marks a local member "skipped", and a user message in a local group runs the group itself as one
  // ordinary Bot. Local member turns (and where their approval cards go) need a product decision first:
  // see the PR description.
  test.todo('real 2bb5e41 Host: one message in a local group gets a reply from each member Bot');
  test.todo('real 2bb5e41 Host: approval cards from a group turn are answered only in the user\'s 1:1 chat');
}
