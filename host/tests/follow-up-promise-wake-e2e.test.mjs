// A bot tells the user "I'll get back to you", its turn ends, and nothing ever follows.
//
// Two real-seed (2bb5e41) cases:
// 1. The bot dispatched a background subagent and acknowledged. The completion wake runs as a
//    hidden, silence-allowed turn (runBackgroundWake). When the model answers that wake with plain
//    assistant text instead of SendToUser, the result must still reach the user.
// 2. The bot promised a later report but nothing is running that would wake it. The Host must
//    nudge it once so it finishes now or says plainly that nothing is pending.
//
//   ROKBOT_TEST_HOST_SEED=/tmp/rokbot-seed/seed node --test --test-force-exit host/tests/follow-up-promise-wake-e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

async function waitFor(predicate, { timeoutMs = 25_000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
  : String(message?.content ?? ''));

const withoutReminders = (text) => text.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '').trim();

const WAKE_TAG = '[A background task just completed]';
const PROMISE_NUDGE_MARK = 'nothing is running that will wake you';
const WAKE_TEXT_NUDGE_MARK = 'Your answer to that background result was plain assistant text';

async function realHost(t, { wakeAnswer = 'plain' } = {}) {
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const { cp, mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
  const { defaultPolicy } = await import('../runtime/model-policy.mjs');
  const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
  const HOST_DIR = resolve(import.meta.dirname, '..');

  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-follow-up-promise-')));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const workSeed = join(stateDir, 'seed');
  await cp(configuredSeed, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

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
  const send = (res, content, id) => toolCall(res, 'SendToUser', { type: 'text', content, end_turn: true }, id);

  const parentPrompts = [];
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
    // The kernel injects <system_reminder> blocks (alone or ahead of a hidden wake prompt); the
    // turn's prompt is the last user message with text outside them.
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user' && withoutReminders(textOf(m)));
    const after = messages.slice(messages.lastIndexOf(lastUser) + 1);
    const toolsAfter = after.filter((m) => m?.role === 'tool').map(textOf);
    const calledAfter = after.flatMap((m) => (m?.tool_calls ?? []).map((c) => c.function?.name));
    calls++;
    const id = `call_${calls}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (system.includes('GROK_BOT_MEMORY_EXTRACTION')) return say(res, 'Done.');

    // A subagent conversation starts from its Task prompt.
    if (!users.some((text) => /BUILD_CHECK|PROMISE_ONLY|PLAIN_ANSWER/.test(text)) && users.some((text) => text.includes('SUBTASK_BUILD'))) {
      // Finish after the dispatching turn has ended, as a real build would.
      await new Promise((r) => setTimeout(r, 1500));
      return say(res, 'SUBTASK_RESULT: 3 tests failed in auth.spec');
    }
    const text = withoutReminders(textOf(lastUser));
    if (calledAfter.includes('SendToUser')) return say(res, '');
    if (toolsAfter.length === 0) parentPrompts.push(text);

    if (text.includes(PROMISE_NUDGE_MARK)) {
      return send(res, 'PROMISE_FULFILLED: the answer is 42.', id);
    }
    if (text.includes(WAKE_TEXT_NUDGE_MARK)) {
      if (wakeAnswer === 'stubborn') return say(res, 'BUILD_RESULT: 3 tests failed in auth.spec.');
      return send(res, 'BUILD_RESULT: 3 tests failed in auth.spec.', id);
    }
    if (text.includes(WAKE_TAG)) {
      if (wakeAnswer === 'silent') return say(res, '');
      return say(res, 'BUILD_RESULT: 3 tests failed in auth.spec.');
    }
    if (text.includes('BUILD_CHECK')) {
      if (!calledAfter.includes('CreateTrackedTasks')) {
        return toolCall(res, 'CreateTrackedTasks', { tasks: [{ title: 'Run the build check', status: 'in_progress' }] }, id);
      }
      if (!calledAfter.includes('CallDynamicTool')) {
        const key = toolsAfter.join('\n').match(/\b([A-Za-z]+-\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/)?.[1];
        return toolCall(res, 'CallDynamicTool', {
          namespace: 'cursor',
          toolName: 'Task',
          arguments: { description: 'build check', prompt: 'SUBTASK_BUILD: run the build and report', subagent_type: 'executor', task_ids: key ? [key] : [] },
        }, id);
      }
      return send(res, "I'm running the build check now and will get back to you in a moment.", id);
    }
    if (text.includes('PROMISE_ONLY')) return send(res, 'Let me check that and get back to you shortly.', id);
    if (text.includes('PLAIN_ANSWER')) return send(res, 'The answer is 42.', id);
    return say(res, '');
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
    ROKBOT_BACKGROUND_READY_POLL_MS: '50', ROKBOT_SUBAGENT_STALL_MS: '0',
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
  const host = new library.SandHost({
    environment: library.readSandHostEnvironment(process.env),
    startExtensions: createExtensionStarter(library, {
      apiFormat: 'openai', baseUrl: `${base}/v1`, apiKey: 'test-key', model: 'gpt-4o-mini',
      policy: defaultPolicy('gpt-4o-mini'), usageDirectory: join(stateDir, 'usage'), routingDirectory: join(stateDir, 'routing'),
    }),
  });
  await host.start();
  t.after(() => host.dispose());
  await host.getApi().setHostSettings({ autoReviewInstructions: { isEnabled: false, allowInstructions: [], blockInstructions: [] } });
  const api = host.getApi();
  const agentId = (await api.createAgent({ name: 'rokbot', description: 'reports back' })).agent.id;
  await api.openAgent({ id: agentId });
  const sentTexts = async () => (await api.getAgentTranscript({ id: agentId }))
    .filter((entry) => entry.kind === 'send-message')
    .map((entry) => entry.message?.content ?? '');
  return { host, api, agentId, parentPrompts, sentTexts };
}

if (configuredSeed) {
  test('real 2bb5e41 Host: a background result the bot answers in plain text still reaches the user', async (t) => {
    const h = await realHost(t, { wakeAnswer: 'plain' });
    await h.api.sendPrompt({ agentId: h.agentId, prompt: 'BUILD_CHECK please run the build and tell me', clientNonce: 'build-1' });
    await waitFor(async () => (await h.sentTexts()).some((text) => text.includes('get back to you in a moment')), { what: 'acknowledgement' });
    await waitFor(() => h.parentPrompts.some((text) => text.includes(WAKE_TAG)), { what: 'completion wake' });
    const sent = await waitFor(async () => {
      const texts = await h.sentTexts();
      return texts.some((text) => text.includes('BUILD_RESULT')) ? texts : null;
    }, { what: 'the background result in the chat' });
    assert.equal(sent.filter((text) => text.includes('BUILD_RESULT')).length, 1, 'the result is delivered exactly once');
    assert.ok(
      !h.parentPrompts.some((text) => text.includes(PROMISE_NUDGE_MARK)),
      'a promise backed by running background work is not nudged',
    );
  });

  test('real 2bb5e41 Host: a bot that answers the wake check in plain text again still gets its result posted once', async (t) => {
    const h = await realHost(t, { wakeAnswer: 'stubborn' });
    await h.api.sendPrompt({ agentId: h.agentId, prompt: 'BUILD_CHECK please run the build and tell me', clientNonce: 'build-3' });
    const sent = await waitFor(async () => {
      const texts = await h.sentTexts();
      return texts.some((text) => text.includes('BUILD_RESULT')) ? texts : null;
    }, { what: 'the background result in the chat' });
    await h.host.transcript.runLifecycle.drainExclusiveRuns(h.agentId);
    assert.equal((await h.sentTexts()).filter((text) => text.includes('BUILD_RESULT')).length, 1);
    assert.equal(h.parentPrompts.filter((text) => text.includes(WAKE_TEXT_NUDGE_MARK)).length, 1, 'one check per wake');
    assert.ok(sent.length >= 2);
  });

  test('real 2bb5e41 Host: a background wake the bot chooses to stay silent on posts nothing', async (t) => {
    const h = await realHost(t, { wakeAnswer: 'silent' });
    await h.api.sendPrompt({ agentId: h.agentId, prompt: 'BUILD_CHECK please run the build and tell me', clientNonce: 'build-2' });
    await waitFor(() => h.parentPrompts.some((text) => text.includes(WAKE_TAG)), { what: 'completion wake' });
    await h.host.transcript.runLifecycle.drainExclusiveRuns(h.agentId);
    await new Promise((r) => setTimeout(r, 500));
    await h.host.transcript.runLifecycle.drainExclusiveRuns(h.agentId);
    const sent = await h.sentTexts();
    assert.deepEqual(sent.filter((text) => text.trim()), ["I'm running the build check now and will get back to you in a moment."]);
    assert.ok(!h.parentPrompts.some((text) => text.includes(WAKE_TEXT_NUDGE_MARK)), 'an empty wake answer is not nudged');
  });

  test('real 2bb5e41 Host: a promise to report back with nothing running nudges the bot once', async (t) => {
    const h = await realHost(t);
    await h.api.sendPrompt({ agentId: h.agentId, prompt: 'PROMISE_ONLY what is the answer?', clientNonce: 'promise-1' });
    await h.host.transcript.runLifecycle.drainExclusiveRuns(h.agentId);
    const sent = await waitFor(async () => {
      const texts = await h.sentTexts();
      return texts.some((text) => text.includes('PROMISE_FULFILLED')) ? texts : null;
    }, { what: 'the promised answer' });
    assert.equal(h.parentPrompts.filter((text) => text.includes(PROMISE_NUDGE_MARK)).length, 1, 'exactly one nudge');
    assert.deepEqual(sent.filter((text) => text.trim()), ['Let me check that and get back to you shortly.', 'PROMISE_FULFILLED: the answer is 42.']);
  });

  test('real 2bb5e41 Host: a complete answer is not nudged', async (t) => {
    const h = await realHost(t);
    await h.api.sendPrompt({ agentId: h.agentId, prompt: 'PLAIN_ANSWER what is the answer?', clientNonce: 'plain-1' });
    await h.host.transcript.runLifecycle.drainExclusiveRuns(h.agentId);
    await new Promise((r) => setTimeout(r, 300));
    await h.host.transcript.runLifecycle.drainExclusiveRuns(h.agentId);
    assert.deepEqual((await h.sentTexts()).filter((text) => text.trim()), ['The answer is 42.']);
    assert.ok(!h.parentPrompts.some((text) => text.includes(PROMISE_NUDGE_MARK)));
  });
}
