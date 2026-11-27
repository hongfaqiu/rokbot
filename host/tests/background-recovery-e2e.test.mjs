import test from 'node:test';
import assert from 'node:assert/strict';

// Real-seed end-to-end checks for background work on the 2bb5e41 Host:
//   ROKBOT_TEST_HOST_SEED=/tmp/rokbot-seed/seed node --test host/tests/background-recovery-e2e.test.mjs
const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function realHostHarness(t, { env: extraEnv = {} } = {}) {
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const { cp, mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
  const { defaultPolicy } = await import('../runtime/model-policy.mjs');
  const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
  const HOST_DIR = resolve(import.meta.dirname, '..');

  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-background-')));
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
  const parentPrompts = [];
  const subagentPrompts = [];
  const toolResults = [];
  const hanging = new Set();
  const slow = new Set();
  const releaseSlow = () => {
    for (const res of slow) say(res, 'SUBTASK_RESULT: the slow answer is 43');
    slow.clear();
  };
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
    const users = messages.filter((m) => m?.role === 'user').map(textOf);
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const answered = messages.slice(messages.lastIndexOf(lastUser) + 1).some((m) => m?.role === 'tool');
    calls++;
    if (system.includes('GROK_BOT_MEMORY_EXTRACTION')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      say(res, 'Done.');
      return;
    }
    // A subagent conversation runs as the executor subagent (in 97658ad its prompt may also quote
    // <parent_conversation> containing DISPATCH_, so check the system prompt / <user_query> rather than raw users).
    const isSubagent = system.includes('running as the executor subagent')
      || users.some((text) => /<user_query>\s*SUBTASK_(OK|FAIL|HANG|SLOW)/.test(text));
    const subTask = isSubagent ? users.find((text) => /SUBTASK_(OK|FAIL|HANG|SLOW)/.test(text)) : undefined;
    if (subTask) {
      subagentPrompts.push(subTask);
      if (subTask.includes('SUBTASK_FAIL')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'subagent model rejected the request', type: 'invalid_request_error' } }));
        return;
      }
      if (subTask.includes('SUBTASK_SLOW')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        slow.add(res);
        res.on('close', () => slow.delete(res));
        return; // answers when the test calls releaseSlow()
      }
      if (subTask.includes('SUBTASK_HANG')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        hanging.add(res);
        res.on('close', () => hanging.delete(res));
        return; // never answers: a stuck subagent
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      say(res, 'SUBTASK_RESULT: the answer is 42');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = textOf(lastUser);
    if (answered) {
      for (const m of messages.slice(messages.lastIndexOf(lastUser) + 1)) if (m?.role === 'tool') toolResults.push(textOf(m));
      say(res, 'Done.');
      return;
    }
    parentPrompts.push(text);
    const check = text.includes('GROK_BOT_HIDDEN_PROMPT') ? null : text.match(/CHECK_SUBAGENT (sand-subagent-[0-9a-f-]+)/);
    if (check) {
      toolCall(res, 'CallDynamicTool', { namespace: 'cursor', toolName: 'CheckSubagent', arguments: { id: check[1] } }, `call_${calls}`);
      return;
    }
    // Host wake prompts quote earlier prompts; only a user message dispatches.
    const dispatch = text.includes('GROK_BOT_HIDDEN_PROMPT') ? null : text.match(/DISPATCH_(OK|FAIL|HANG|SLOW)/);
    if (dispatch) {
      toolCall(res, 'CallDynamicTool', {
        namespace: 'cursor',
        toolName: 'Task',
        arguments: { description: `probe ${dispatch[1].toLowerCase()}`, prompt: `SUBTASK_${dispatch[1]}: compute the answer and report it`, subagent_type: 'executor' },
      }, `call_${calls}`);
      return;
    }
    toolCall(res, 'SendToUser', { type: 'text', content: `REPORT:${parentPrompts.length}` }, `call_${calls}`);
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    for (const res of hanging) res.destroy();
    for (const res of slow) res.destroy();
    llm.closeAllConnections?.();
    llm.close(r);
  }));
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
    ROKBOT_BACKGROUND_READY_POLL_MS: '50',
    ...extraEnv,
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
    // Background work only: the Auto-review switch (on by default) would review each Task dispatch.
    await host.getApi().setHostSettings({ autoReviewInstructions: { isEnabled: false, allowInstructions: [], blockInstructions: [] } });
    return host;
  };
  const wakeFile = join(stateDir, 'host-data', 'host-pending-wakes.json');
  return { startHost, parentPrompts, subagentPrompts, toolResults, hanging, slow, releaseSlow, wakeFile, stateDir };
}

async function sentTexts(api, agentId) {
  return (await api.getAgentTranscript({ id: agentId }))
    .filter((entry) => entry.kind === 'send-message')
    .map((entry) => entry.message?.content);
}

if (configuredSeed) {
  test('real 2bb5e41 Host wakes the parent bot when its background subagent finishes or fails', async (t) => {
    const h = await realHostHarness(t, { env: { ROKBOT_SUBAGENT_STALL_MS: '0' } });
    const { existsSync } = await import('node:fs');
    const host = await h.startHost();
    try {
      const api = host.getApi();
      const agentId = (await api.createAgent({ name: 'rokbot', description: 'dispatcher' })).agent.id;
      await api.openAgent({ id: agentId });

      await api.sendPrompt({ agentId, prompt: 'DISPATCH_OK please', clientNonce: 'ok-1' });
      await waitFor(() => h.parentPrompts.some((text) => text.includes('SUBTASK_RESULT: the answer is 42')), { what: 'completion wake' });
      const wake = h.parentPrompts.find((text) => text.includes('SUBTASK_RESULT'));
      assert.match(wake, /\[A background task just completed\]/);
      assert.match(wake, /sand-subagent-[0-9a-f-]+/, 'the wake names the task id');
      await waitFor(async () => (await sentTexts(api, agentId)).includes(`REPORT:${h.parentPrompts.indexOf(wake) + 1}`), { what: 'bot report after wake' });

      await api.sendPrompt({ agentId, prompt: 'DISPATCH_FAIL please', clientNonce: 'fail-1' });
      const failWake = await waitFor(() => h.parentPrompts.find((text) => /Background task "SUBTASK_FAIL/.test(text)), { what: 'failure wake' });
      assert.match(failWake, /Background task "SUBTASK_FAIL[^"]*" \(executor\) failed/);
      await waitFor(() => !existsSync(h.wakeFile), { what: 'pending wakes consumed' });
    } finally {
      await host.dispose();
    }
  });

  test('real 2bb5e41 Host watchdog reports a stalled background subagent once', async (t) => {
    const h = await realHostHarness(t, { env: {
      ROKBOT_SUBAGENT_STALL_MS: '1200', ROKBOT_BACKGROUND_WATCHDOG_TICK_MS: '100', ROKBOT_SUBAGENT_STALL_MAX_NOTICES: '1',
    } });
    const host = await h.startHost();
    try {
      const api = host.getApi();
      const agentId = (await api.createAgent({ name: 'rokbot', description: 'dispatcher' })).agent.id;
      await api.openAgent({ id: agentId });
      await api.sendPrompt({ agentId, prompt: 'DISPATCH_HANG please', clientNonce: 'hang-1' });
      const stall = await waitFor(() => h.parentPrompts.find((text) => text.includes('no visible progress')), { what: 'stall wake' });
      assert.match(stall, /\[A background task needs attention\]/);
      assert.match(stall, /SUBTASK_HANG: compute the answer/);
      assert.match(stall, /task id: sand-subagent-[0-9a-f-]+/);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      assert.equal(h.parentPrompts.filter((text) => text.includes('no visible progress')).length, 1, 'no repeated stall wakes');
    } finally {
      host.transcript.rokbotBackgroundRecovery?.beginShutdown('test');
      await host.dispose();
    }
  });

  test('real 2bb5e41 Host restart wakes the bot about the interrupted subagent and consumes pending wakes', async (t) => {
    const h = await realHostHarness(t, { env: { ROKBOT_SUBAGENT_STALL_MS: '0' } });
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
    let agentId;
    const first = await h.startHost();
    try {
      const api = first.getApi();
      agentId = (await api.createAgent({ name: 'rokbot', description: 'dispatcher' })).agent.id;
      await api.openAgent({ id: agentId });
      await api.sendPrompt({ agentId, prompt: 'DISPATCH_HANG please', clientNonce: 'hang-2' });
      await waitFor(() => h.subagentPrompts.length > 0 && h.hanging.size > 0, { what: 'subagent running' });
      await first.transcript.runLifecycle.drainExclusiveRuns(agentId);
    } finally {
      // What host.mjs does on SIGTERM before disposing.
      first.transcript.rokbotBackgroundRecovery.beginShutdown('SIGTERM');
      await first.dispose();
    }
    const saved = JSON.parse(readFileSync(h.wakeFile, 'utf8'));
    const marker = saved.pending.find((entry) => entry.kind === 'subagent');
    assert.ok(marker, 'the running subagent is persisted');
    assert.equal(marker.agentId, agentId);
    assert.match(marker.workId, /^sand-subagent-/);
    assert.equal(marker.subagentType, 'executor');
    assert.match(marker.prompt, /SUBTASK_HANG: compute the answer/);
    assert.equal(marker.interruptedReason, 'SIGTERM');
    // A record left by an older Host (same shape as the live 梦 app one), days old.
    saved.pending.push({ agentId, kind: 'subagent', workId: 'sand-subagent-legacy-0001', markedAtMs: Date.now() - 4 * 24 * 3600_000, title: 'legacy lost task', subagentType: 'executor' });
    writeFileSync(h.wakeFile, JSON.stringify(saved));
    for (const res of h.hanging) res.destroy();

    const before = h.parentPrompts.length;
    const second = await h.startHost();
    try {
      const wake = await waitFor(() => h.parentPrompts.slice(before).find((text) => text.includes('interrupted by a Host restart')), { what: 'restart wake' });
      assert.match(wake, new RegExp(marker.workId));
      assert.match(wake, /SUBTASK_HANG: compute the answer/);
      assert.match(wake, /task id: sand-subagent-/);
      assert.match(wake, /Do not re-run it blindly/);
      assert.match(wake, /sand-subagent-legacy-0001/);
      assert.match(wake, /never reported back/);
      await waitFor(() => !existsSync(h.wakeFile), { what: 'pending wakes consumed after restart' });
      const api = second.getApi();
      await waitFor(async () => (await sentTexts(api, agentId)).some((text) => /^REPORT:/.test(text ?? '')), { what: 'bot reports after restart' });
    } finally {
      await second.dispose();
    }
  });

  // 梦 app, 2026-11-25 21:49 (+08): the bot was not the open one, so its session retired when the
  // dispatching turn ended. The next turn got a new runner, CheckSubagent answered "No subagent ...
  // is currently running", and the bot re-dispatched the task while the original kept running.
  test('real 2bb5e41 Host keeps a background subagent visible to its bot after the dispatching turn ends while another bot is open', async (t) => {
    const h = await realHostHarness(t, { env: { ROKBOT_SUBAGENT_STALL_MS: '0', ROKBOT_DEFERRED_RETIRE_POLL_MS: '100' } });
    const { existsSync } = await import('node:fs');
    const host = await h.startHost();
    try {
      const api = host.getApi();
      const dream = (await api.createAgent({ name: '梦 app', description: 'dispatcher' })).agent.id;
      const other = (await api.createAgent({ name: 'other', description: 'the bot the user has open' })).agent.id;

      await api.sendPrompt({ agentId: dream, prompt: 'DISPATCH_SLOW please', clientNonce: 'slow-1' });
      await waitFor(() => h.slow.size > 0, { what: 'slow subagent running' });
      await host.transcript.runLifecycle.drainExclusiveRuns(dream);
      // The user switches to another bot: 2bb5e41 retires the previous bot's session right away.
      await api.openAgent({ id: other });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.notEqual(host.transcript.sessions.activeSession?.id, dream);

      const runner = host.transcript.runnerRegistry.peekRunner(dream);
      assert.ok(runner, 'the bot keeps its runner while its background subagent runs');
      const [running] = runner.listRunningSubagents();
      assert.ok(running, 'the bot\'s current runner still lists the subagent');
      const id = running.subagentId;
      assert.match(id, /^sand-subagent-/);

      await api.sendPrompt({ agentId: dream, prompt: `CHECK_SUBAGENT ${id}`, clientNonce: 'check-1' });
      const result = await waitFor(() => h.toolResults.find((text) => text.includes(id) || /No subagent/.test(text)), { what: 'CheckSubagent result' });
      assert.doesNotMatch(result, /No subagent/, `CheckSubagent from a later turn must see the running task, got: ${result}`);
      await host.transcript.runLifecycle.drainExclusiveRuns(dream);
      // Back to the other bot before the result arrives, so the idle retirement is exercised again.
      await api.openAgent({ id: other });

      h.releaseSlow();
      const wake = await waitFor(() => h.parentPrompts.find((text) => text.includes('SUBTASK_RESULT: the slow answer is 43')), { what: 'completion wake' });
      assert.match(wake, new RegExp(id));
      await waitFor(() => !existsSync(h.wakeFile), { what: 'pending wakes consumed' });
      // With the work done, the deferred retirement goes through: the idle bot is closed again.
      await waitFor(() => host.transcript.runnerRegistry.peekRunner(dream) === undefined, { what: 'idle session retired after the background work' });
    } finally {
      await host.dispose();
    }
  });
}
