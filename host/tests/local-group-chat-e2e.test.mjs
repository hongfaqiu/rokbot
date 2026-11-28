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

async function treeSitterAvailable() {
  const { createRequire } = await import('node:module');
  const { delimiter } = await import('node:path');
  const paths = (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean);
  try {
    createRequire(import.meta.url).resolve('tree-sitter', { paths });
    createRequire(import.meta.url).resolve('tree-sitter-bash', { paths });
    return true;
  } catch {
    return false;
  }
}

const BLOCK_REASON = 'Recursively deletes a directory and everything in it.';

// Mock model conventions (one model serves every Bot; each Bot's description carries BOTTAG_<NAME>):
//   - a "[Group chat: ...]" turn whose new lines hold GROUP_* from the user: reply REPLY_<NAME>
//     with SendToUser, or stay silent when the user wrote PASS_<NAME>; a turn with only other
//     members' lines: stay silent (keeps later waves quiet and the run deterministic);
//   - GROUP_RM_<NAME> <dir>: that Bot runs `rm -rf <dir>`, which Auto-review blocks, then retries
//     for the approval card the way the shipped block reminder says;
//   - anything else (1:1 chat): reply REPLY_<NAME>.
async function realHostHarness(t) {
  const { createServer } = await import('node:http');
  const { rmSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { cp, mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
  const { defaultPolicy } = await import('../runtime/model-policy.mjs');
  const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
  const HOST_DIR = resolve(import.meta.dirname, '..');

  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-group-')));
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workSeed = join(stateDir, 'seed');
  await cp(configuredSeed, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

  const textOf = (message) => (Array.isArray(message?.content)
    ? message.content.map((part) => part?.text ?? '').join('\n')
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
  const classifierCalls = [];
  const finalResults = new Map();
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
    const classify = body.tools?.length === 1 ? body.tools[0].function : undefined;
    if (body.stream === false && /classif/i.test(classify?.name ?? '')) {
      classifierCalls.push(body.model);
      const decision = { decision: 'BLOCK', reason: BLOCK_REASON, blocked_effect: 'destructive_data_loss',
        outbound_authorization: 'not_outbound', action_description: 'Delete a directory tree',
        proposed_allow_rule: 'Allow deleting scratch directories this bot created' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `review-${calls}`, model: body.model, usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: `k${calls}`, type: 'function', function: { name: classify.name, arguments: JSON.stringify(decision) } }] } }] }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.filter((m) => m?.role === 'system').map(textOf).join('\n');
    // The harness may append its own <system_reminder> user turns; the prompt is the last other one.
    // A reminder can also be prepended to the prompt itself (e.g. a tool-catalog update when the
    // tool set changed since the last turn); that message still carries the <user_query>.
    const reminderOnly = (m) => { const t = textOf(m).trimStart(); return t.startsWith('<system_reminder>') && !t.includes('<user_query>'); };
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user' && !reminderOnly(m));
    const results = messages.slice(messages.lastIndexOf(lastUser) + 1).filter((m) => m?.role === 'tool').map(textOf);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (system.includes('GROK_BOT_MEMORY_EXTRACTION')) { say(res, 'Done.'); return; }
    const bot = system.match(/BOTTAG_([A-Z]+)/)?.[1] ?? 'UNKNOWN';
    const text = textOf(lastUser);
    const inGroup = text.includes('[Group chat: ');
    requests.push({ bot, text, inGroup, system, messages, tools: (body.tools ?? []).map((tool) => tool.function?.name) });
    const rmTarget = text.match(new RegExp(`GROUP_RM_${bot} (\\S+)`))?.[1];
    if (rmTarget) {
      const command = `rm -rf ${rmTarget}`;
      if (results.length === 0) return toolCall(res, 'Shell', { command, description: 'Delete the scratch directory' }, `call_${calls}`);
      const blocked = results.at(-1).match(/Rejected: ([^\n]+)/);
      if (results.length === 1 && blocked && /request_smart_mode_approval/.test(results[0])) {
        return toolCall(res, 'Shell', { command, description: 'Delete the scratch directory',
          request_smart_mode_approval: true, smart_mode_block_reason: blocked[1] }, `call_${calls}`);
      }
      finalResults.set(rmTarget, results);
      return say(res, 'Done.');
    }
    if (results.length > 0) { say(res, 'Done.'); return; }
    if (text.includes(`SLOW_${bot}`)) await new Promise((r) => setTimeout(r, 600));
    if (inGroup && (!/GROUP_[A-Z]/.test(text) || text.includes(`PASS_${bot}`))) { say(res, 'Nothing to add.'); return; }
    toolCall(res, 'SendToUser', { type: 'text', content: `REPLY_${bot}` }, `call_${calls}`);
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { llm.closeAllConnections?.(); llm.close(r); }));
  const base = `http://127.0.0.1:${llm.address().port}`;
  // The box: performs exactly the reviewed `rm -rf <dir>` and answers like the exec daemon.
  const executed = [];
  let library;
  const exec = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    const rmTarget = raw.match(/rm -rf (\/[^\s"'\\\x00-\x1f]+)/)?.[1];
    if (req.url?.includes('ExecService/Exec') && contentType.includes('application/connect+proto') && rmTarget) {
      if (rmTarget.startsWith(`${stateDir}/scratch/`)) {
        executed.push(rmTarget);
        rmSync(rmTarget, { recursive: true, force: true });
      }
      const wrap = (bytes, field = 1) => {
        const length = [];
        let n = bytes.length;
        while (n >= 0x80) { length.push((n & 0x7f) | 0x80); n >>>= 7; }
        length.push(n);
        return Buffer.concat([Buffer.from([(field << 3) | 2, ...length]), bytes]);
      };
      const frame = (flags, bytes) => {
        const header = Buffer.alloc(5);
        header.writeUInt8(flags, 0);
        header.writeUInt32BE(bytes.length, 1);
        return Buffer.concat([header, bytes]);
      };
      const out = [
        library.ExecClientMessage.fromJson({ id: 0, shellStream: { stdout: { data: `removed ${rmTarget}\n` } } }).toBinary(),
        library.ExecClientMessage.fromJson({ id: 0, shellStream: { exit: { code: 0 } } }).toBinary(),
      ];
      const close = library.ExecClientControlMessage.fromJson({ streamClose: { id: 0 } }).toBinary();
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.end(Buffer.concat([...out.map((m) => frame(0, wrap(m))), frame(0, wrap(close, 2)), frame(2, Buffer.from('{}'))]));
      return;
    }
    if (contentType.includes('application/connect+proto')) {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.end(Buffer.from([0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0x7b, 0x7d]));
    } else if (contentType.includes('application/json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    } else {
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end();
    }
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

  library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
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
  return { startHost, requests, classifierCalls, finalResults, executed, stateDir, library };
}

const groupOf = async (api, id) => (await api.listAgents()).find((agent) => agent.id === id);
/** Member-authored posts of a group, in transcript order. */
const memberPosts = async (api, id) => (await api.getAgentTranscript({ id }))
  .filter((entry) => entry.kind === 'send-message' && entry.author != null)
  .map((entry) => ({ author: entry.author.id, text: entry.message?.content }));
const cardsIn = async (api, id) => (await api.getAgentTranscript({ id }))
  .filter((entry) => entry.kind === 'send-message' && entry.message?.type !== 'text' && entry.message?.type !== 'attachment');

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
        await waitFor(async () => (await memberPosts(api, groupId)).length >= 2, { what: 'member replies in the group' });
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
        assert.ok(transcript.includes('GROUP_HELLO everyone'), 'the user message is kept after restart');
        assert.deepEqual(await memberPosts(api, groupId), [
          { author: alpha, text: 'REPLY_ALPHA' },
          { author: gamma, text: 'REPLY_GAMMA' },
        ], 'member replies and their authors are kept after restart');
    } finally {
      await second.dispose();
    }
  });

  test('real 2bb5e41 Host: one message in a local group gets a reply from each member Bot, authored by it, in member order; a member that passes posts nothing', async (t) => {
    const h = await realHostHarness(t);
    const host = await h.startHost();
    try {
      const api = host.getApi();
      const alpha = (await api.createAgent({ name: 'alpha', description: 'BOTTAG_ALPHA' })).agent.id;
      const beta = (await api.createAgent({ name: 'beta', description: 'BOTTAG_BETA' })).agent.id;
      const gamma = (await api.createAgent({ name: 'gamma', description: 'BOTTAG_GAMMA' })).agent.id;
      const groupId = (await api.createGroup({ name: '研发群', memberAgentIds: [alpha, beta, gamma], namedBy: 'user' })).agent.id;

      await api.openAgent({ id: groupId });
      // alpha answers last (SLOW_ALPHA) but is first in member order; beta passes.
      await api.sendPrompt({ agentId: groupId, prompt: 'GROUP_HELLO SLOW_ALPHA PASS_BETA', clientNonce: 'g-1' });
      await waitFor(async () => (await memberPosts(api, groupId)).length >= 2, { what: 'two member replies' });
      await host.transcript.runLifecycle.drainExclusiveRuns(groupId);

      assert.deepEqual(await memberPosts(api, groupId), [
        { author: alpha, text: 'REPLY_ALPHA' },
        { author: gamma, text: 'REPLY_GAMMA' },
      ], 'each replying member posts once, as itself, in member order; the passing member posts nothing');
      const posts = (await api.getAgentTranscript({ id: groupId })).filter((entry) => entry.kind === 'send-message');
      assert.ok(posts.every((entry) => entry.author != null), 'the group itself posts nothing');
      assert.deepEqual(posts.map((entry) => entry.author.name), ['alpha', 'gamma']);

      // Every member ran its own turn with its own system prompt; the group never ran as a Bot.
      const groupTurns = h.requests.filter((request) => request.inGroup && request.text.includes('GROUP_HELLO'));
      assert.deepEqual([...new Set(groupTurns.map((request) => request.bot))].sort(), ['ALPHA', 'BETA', 'GAMMA']);
      assert.equal(h.requests.filter((request) => request.bot === 'UNKNOWN').length, 0, 'no model turn ran for the group itself');
      assert.ok(groupTurns.every((request) => request.text.includes('研发群')), 'member prompts carry the group tag');

      // Replies go to the room, not to the members' 1:1 chats.
      for (const id of [alpha, beta, gamma]) {
        const own = JSON.stringify(await api.getAgentTranscript({ id }));
        assert.ok(!own.includes('REPLY_'), `${id} 1:1 chat holds no group reply`);
        assert.ok(!own.includes('GROUP_HELLO'), `${id} 1:1 chat shows no group prompt`);
      }

      // A member's 1:1 chat still works as before.
      await api.sendPrompt({ agentId: alpha, prompt: 'hello alpha', clientNonce: 'dm-1' });
      await waitFor(async () => JSON.stringify(await api.getAgentTranscript({ id: alpha })).includes('REPLY_ALPHA'), { what: 'a 1:1 reply' });
      await host.transcript.runLifecycle.drainExclusiveRuns(alpha);
    } finally {
      await host.dispose();
    }
  });

  test('real 2bb5e41 Host: an approval card raised by a member in a group goes to that member\'s 1:1 chat; the group only shows a notice and cannot approve', async (t) => {
    if (!await treeSitterAvailable()) return t.skip('tree-sitter natives not on NODE_PATH (shell review needs them)');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const h = await realHostHarness(t);
    const host = await h.startHost();
    try {
      const api = host.getApi();
      await api.setHostSettings({ autoReviewInstructions: { isEnabled: true, allowInstructions: [], blockInstructions: [] } });
      const alpha = (await api.createAgent({ name: 'alpha', description: 'BOTTAG_ALPHA' })).agent.id;
      const beta = (await api.createAgent({ name: 'beta', description: 'BOTTAG_BETA' })).agent.id;
      const groupId = (await api.createGroup({ name: '发布小组', memberAgentIds: [alpha, beta], namedBy: 'user' })).agent.id;
      const dir = join(h.stateDir, 'scratch', 'approve');
      await mkdir(join(dir, 'nested'), { recursive: true });
      await writeFile(join(dir, 'nested', 'file.txt'), 'keep me unless approved\n');

      await api.openAgent({ id: groupId });
      await api.sendPrompt({ agentId: groupId, prompt: `GROUP_RM_ALPHA ${dir}`, clientNonce: 'rm-1' });
      const card = await waitFor(async () => (await cardsIn(api, alpha))
        .find((entry) => entry.message.type === 'auto-review-approval' && entry.message.approval.status === 'pending'), { what: 'a pending card in alpha\'s 1:1 chat' });
      assert.equal(card.message.approval.command, `rm -rf ${dir}`);
      assert.ok(h.classifierCalls.length > 0, 'Auto-review classified the call');

      // The room has no card, only alpha's notice; beta was not held back by alpha's wait.
      await waitFor(async () => (await memberPosts(api, groupId)).some((post) => post.author === beta), { what: 'beta\'s reply' });
      const notice = await waitFor(async () => (await memberPosts(api, groupId))
        .find((post) => post.author === alpha && /Waiting for approval/.test(post.text)), { what: 'the waiting notice' });
      assert.match(notice.text, /1:1 chat/);
      assert.deepEqual(await cardsIn(api, groupId), [], 'no card is ever shown in the group');
      assert.ok(!JSON.stringify(await api.getAgentTranscript({ id: groupId })).includes(card.message.approval.requestId), 'the group never learns the request id');
      assert.ok((await groupOf(api, alpha))?.awaitingUserResponse, 'alpha waits for its user');
      assert.equal((await groupOf(api, groupId))?.awaitingUserResponse ?? null, null, 'the group does not');

      // Approving "from the group" does nothing; nothing ran.
      await api.resolveAutoReviewApproval({ entryId: card.id, requestId: card.message.approval.requestId, resolution: 'approved', agentId: groupId })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await cardsIn(api, alpha)).find((entry) => entry.id === card.id).message.approval.status, 'pending');
      assert.ok(existsSync(dir));
      assert.deepEqual(h.executed, []);

      // Only the answer in alpha's own 1:1 chat runs it.
      await api.resolveAutoReviewApproval({ entryId: card.id, requestId: card.message.approval.requestId, resolution: 'approved', agentId: alpha });
      await waitFor(() => h.finalResults.has(dir), { what: 'the result after approval' });
      assert.deepEqual(h.executed, [dir]);
      assert.ok(!existsSync(dir));
      await host.transcript.runLifecycle.drainExclusiveRuns(groupId);
      assert.deepEqual(await cardsIn(api, groupId), []);
    } finally {
      await host.dispose();
    }
  });
}
