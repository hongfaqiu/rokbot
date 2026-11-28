import test from 'node:test';
import assert from 'node:assert/strict';

// Real-seed end-to-end check of local Auto-review on the 2bb5e41 Host: the switch enforces
// review, the Host-configured model classifies, a BLOCK the model escalates shows an approval
// card in the chat, and the user's answer runs, refuses or expires the call.
//   ROKBOT_TEST_HOST_SEED=/tmp/rokbot-seed/seed NODE_PATH=<dir with tree-sitter + tree-sitter-bash> \
//     node --test host/tests/auto-review-e2e.test.mjs
// Shell review needs the tree-sitter natives the Host image ships (host/release/arm-runtime).
const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const BLOCK_REASON = 'Recursively deletes a directory and everything in it.';

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

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function autoReviewHost(t, { ttlMs, harnessSettings }) {
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const { existsSync, rmSync } = await import('node:fs');
  const { cp, mkdir, mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
  const { defaultPolicy } = await import('../runtime/model-policy.mjs');
  const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
  const HOST_DIR = resolve(import.meta.dirname, '..');

  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-auto-review-')));
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const scratchRoot = join(stateDir, 'scratch');
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
  const seen = { classifierCalls: [], finalResults: new Map(), shellSchemas: [] };
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
      // The Host's configured model, asked with the shipped classifier tool.
      const input = JSON.parse(textOf(body.messages.find((m) => m.role === 'user')));
      seen.classifierCalls.push({ model: body.model, input });
      const decision = { decision: 'BLOCK', reason: BLOCK_REASON, blocked_effect: 'destructive_data_loss',
        outbound_authorization: 'not_outbound', action_description: 'Delete a directory tree',
        proposed_allow_rule: 'Allow deleting scratch directories this bot created' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `review-${calls}`, model: body.model, usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: `k${calls}`, type: 'function', function: { name: classify.name, arguments: JSON.stringify(decision) } }] } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // The harness may append its own <system_reminder> user turns; the user's text is the last other one.
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user' && !textOf(m).trimStart().startsWith('<system_reminder>'));
    const target = textOf(lastUser).match(/AUTO_REVIEW_RM (\S+)/)?.[1];
    if (!target || textOf(lastUser).includes('GROK_BOT_HIDDEN_PROMPT')) return say(res, 'Done.');
    const shell = body.tools?.find((tool) => tool.function?.name === 'Shell');
    if (shell) seen.shellSchemas.push(Object.keys(shell.function.parameters.properties));
    const results = messages.slice(messages.lastIndexOf(lastUser) + 1).filter((m) => m?.role === 'tool').map(textOf);
    const command = `rm -rf ${target}`;
    if (results.length === 0) return toolCall(res, 'Shell', { command, description: 'Delete the scratch directory' }, `call_${calls}`);
    const blocked = results.at(-1).match(/Rejected: ([^\n]+)/);
    if (results.length === 1 && blocked && /request_smart_mode_approval/.test(results[0])) {
      // What the shipped block reminder tells the model to do: retry for the native card.
      return toolCall(res, 'Shell', { command, description: 'Delete the scratch directory',
        request_smart_mode_approval: true, smart_mode_block_reason: blocked[1] }, `call_${calls}`);
    }
    seen.finalResults.set(target, results);
    return say(res, 'Done.');
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { llm.closeAllConnections?.(); llm.close(r); }));
  const base = `http://127.0.0.1:${llm.address().port}`;

  // The box: performs exactly the reviewed `rm -rf <scratch dir>` and answers like the exec daemon.
  const executed = [];
  let library;
  const exec = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    const rmTarget = raw.match(/rm -rf (\/[^\s"'\\\x00-\x1f]+)/)?.[1];
    if (req.url?.includes('ExecService/Exec') && contentType.includes('application/connect+proto') && rmTarget) {
      if (rmTarget.startsWith(`${scratchRoot}/`)) {
        executed.push(rmTarget);
        rmSync(rmTarget, { recursive: true, force: true });
      }
      // ExecStreamElement: 1 exec_client_message, 2 exec_client_control_message.
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
      const messages = [
        library.ExecClientMessage.fromJson({ id: 0, shellStream: { stdout: { data: `removed ${rmTarget}\n` } } }).toBinary(),
        library.ExecClientMessage.fromJson({ id: 0, shellStream: { exit: { code: 0 } } }).toBinary(),
      ];
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      const close = library.ExecClientControlMessage.fromJson({ streamClose: { id: 0 } }).toBinary();
      res.end(Buffer.concat([...messages.map((m) => frame(0, wrap(m))), frame(0, wrap(close, 2)), frame(2, Buffer.from('{}'))]));
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
  if (harnessSettings !== undefined) {
    await writeFile(join(stateDir, 'harness-settings.json'), JSON.stringify({ version: 1, settings: harnessSettings }));
  }

  const env = {
    ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'), ROKBOT_STATE_DIR: stateDir, ROKBOT_DATA_DIR: stateDir,
    ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile, ROKBOT_INTERNAL_HOST_URL: base, ROKBOT_NOTIFICATION_URL: base,
    ROKBOT_CONNECTORS_URL: `${base}/internal/connectors`, ROKBOT_SHARING_URL: `${base}/internal/sharing`,
    ROKBOT_EXECUTION_URL: `http://127.0.0.1:${exec.address().port}`, ROKBOT_BOX_TOKEN: 'test-box-token',
    SAND_DATA_ROOT: join(stateDir, 'host-data'), SAND_BACKEND_URL: 'http://127.0.0.1:9',
    SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_ANALYTICS: '1', SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1', SAND_BOX_MAX_WINDOWS: '1',
    ROKBOT_AUTO_REVIEW_APPROVAL_TTL_MS: String(ttlMs),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  // Host log lines ("Local auto-review BLOCK; model=...") as an operator would read them.
  const logs = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    stream.write = function capture(chunk, ...rest) {
      logs.push(String(chunk));
      return write.call(this, chunk, ...rest);
    };
    t.after(() => { stream.write = write; });
  }

  library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
  await loadRecoveredHostCore(library, reliableDir);
  const host = new library.SandHost({
    environment: library.readSandHostEnvironment(process.env),
    startExtensions: createExtensionStarter(library, {
      apiFormat: 'openai', baseUrl: `${base}/v1`, apiKey: 'test-key', model: 'review-test-model',
      policy: defaultPolicy('review-test-model'), usageDirectory: join(stateDir, 'usage'), routingDirectory: join(stateDir, 'routing'),
    }),
  });
  await host.start();
  t.after(() => host.dispose());
  const scratch = async (name) => {
    const dir = join(scratchRoot, name);
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'file.txt'), 'keep me unless approved\n');
    return dir;
  };
  return { host, api: host.getApi(), seen, executed, logs, scratch, existsSync };
}

const cardOf = async (api, agentId) => (await api.getAgentTranscript({ id: agentId }))
  .find((entry) => entry.kind === 'send-message' && entry.message?.type === 'auto-review-approval');
const pendingCard = (api, agentId) => waitFor(async () => {
  const card = await cardOf(api, agentId);
  return card?.message.approval.status === 'pending' && card;
}, { what: 'pending approval card' });
const settledCard = (api, agentId, status) => waitFor(async () => {
  const card = await cardOf(api, agentId);
  return card?.message.approval.status === status && card;
}, { what: `card ${status}` });
async function summaryOf(api, agentId) {
  const listed = await api.listAgents();
  const agents = Array.isArray(listed) ? listed : listed?.agents ?? listed?.items ?? [];
  return agents.find((agent) => agent.id === agentId);
}
async function newBot(api, name) {
  const agentId = (await api.createAgent({ name, description: 'auto-review e2e' })).agent.id;
  await api.openAgent({ id: agentId });
  return agentId;
}

// Approval cards are resolved by resolveAutoReviewApproval, never respondToWidget: identical under both values.
for (const harnessSettings of [undefined, { showWidgetAnswerBubble: false }]) {
const bubbleSuffix = harnessSettings ? ' (showWidgetAnswerBubble=false)' : '';
if (configuredSeed) {
  test(`real 2bb5e41 Host: Auto-review BLOCK shows an approval card; approve runs, deny refuses, a new message or the TTL expires it, off skips review${bubbleSuffix}`, async (t) => {
    if (!await treeSitterAvailable()) return t.skip('tree-sitter natives not on NODE_PATH (shell review needs them)');
    const h = await autoReviewHost(t, { ttlMs: 8_000, harnessSettings });
    const { api, seen, executed, logs, scratch, existsSync } = h;
    await api.setHostSettings({ autoReviewInstructions: { isEnabled: true, allowInstructions: [], blockInstructions: [] } });

    // 1. Approve: classifier BLOCK -> model retries for approval -> card -> approved -> the command runs.
    const approveDir = await scratch('approve');
    const approveBot = await newBot(api, 'approve');
    await api.sendPrompt({ agentId: approveBot, prompt: `AUTO_REVIEW_RM ${approveDir}`, clientNonce: 'approve-1' });
    const card = await pendingCard(api, approveBot);
    assert.ok(logs.some((line) => line.includes('Local auto-review BLOCK; model=review-test-model')), 'the classifier ran on the Host model');
    assert.ok(seen.classifierCalls.every((call) => call.model === 'review-test-model'));
    assert.equal(seen.classifierCalls[0].input.proposed_tool_call.arguments.command, `rm -rf ${approveDir}`);
    assert.ok(seen.shellSchemas[0].includes('request_smart_mode_approval'), 'Shell offers the approval retry while review is on');
    const { approval } = card.message;
    assert.equal(approval.command, `rm -rf ${approveDir}`);
    assert.equal(approval.reason, BLOCK_REASON);
    assert.equal(approval.surface, 'box_shell');
    assert.equal(approval.proposedRule, 'Allow deleting scratch directories this bot created');
    assert.match(approval.summary, /Delete the scratch directory/);
    assert.ok(existsSync(approveDir), 'nothing ran before the answer');
    assert.equal(executed.length, 0);
    const waiting = await waitFor(async () => (await summaryOf(api, approveBot))?.awaitingUserResponse, { what: 'awaiting state' });
    assert.equal(waiting.reason, approval.summary);
    await api.resolveAutoReviewApproval({ entryId: card.id, requestId: approval.requestId, resolution: 'approved', agentId: approveBot });
    await settledCard(api, approveBot, 'approved');
    await waitFor(() => seen.finalResults.has(approveDir), { what: 'result after approval' });
    assert.deepEqual(executed, [approveDir]);
    assert.ok(!existsSync(approveDir), 'the approved rm -rf ran');
    assert.match(seen.finalResults.get(approveDir).at(-1), /removed /);
    await waitFor(async () => (await summaryOf(api, approveBot))?.awaitingUserResponse == null, { what: 'awaiting cleared' });
    // A second answer (another device) settles nothing new: the original stale-card path refreshes it.
    await api.resolveAutoReviewApproval({ entryId: card.id, requestId: approval.requestId, resolution: 'denied', agentId: approveBot });
    assert.equal((await cardOf(api, approveBot)).message.approval.status, 'approved');

    // 2. Deny: the refusal goes back to the model and nothing runs.
    const denyDir = await scratch('deny');
    const denyBot = await newBot(api, 'deny');
    await api.sendPrompt({ agentId: denyBot, prompt: `AUTO_REVIEW_RM ${denyDir}`, clientNonce: 'deny-1' });
    const denyCard = await pendingCard(api, denyBot);
    await api.resolveAutoReviewApproval({ entryId: denyCard.id, requestId: denyCard.message.approval.requestId, resolution: 'denied', agentId: denyBot });
    await settledCard(api, denyBot, 'denied');
    await waitFor(() => seen.finalResults.has(denyDir), { what: 'result after denial' });
    assert.match(seen.finalResults.get(denyDir).at(-1), /The user declined this action on its approval card, so nothing ran/);
    assert.ok(existsSync(denyDir));

    // 3. A new user message expires the waiting card.
    const redirectDir = await scratch('redirect');
    const redirectBot = await newBot(api, 'redirect');
    await api.sendPrompt({ agentId: redirectBot, prompt: `AUTO_REVIEW_RM ${redirectDir}`, clientNonce: 'redirect-1' });
    const redirectCard = await pendingCard(api, redirectBot);
    await api.sendPrompt({ agentId: redirectBot, prompt: 'Never mind, keep it.', clientNonce: 'redirect-2' });
    await settledCard(api, redirectBot, 'expired');
    await api.resolveAutoReviewApproval({ entryId: redirectCard.id, requestId: redirectCard.message.approval.requestId,
      resolution: 'approved', agentId: redirectBot });
    assert.equal((await cardOf(api, redirectBot)).message.approval.status, 'expired', 'a late approval does not revive it');
    assert.ok(existsSync(redirectDir));

    // 4. An unanswered card expires after its TTL and the model hears so.
    const ttlDir = await scratch('ttl');
    const ttlBot = await newBot(api, 'ttl');
    await api.sendPrompt({ agentId: ttlBot, prompt: `AUTO_REVIEW_RM ${ttlDir}`, clientNonce: 'ttl-1' });
    await pendingCard(api, ttlBot);
    await settledCard(api, ttlBot, 'expired');
    await waitFor(() => seen.finalResults.has(ttlDir), { what: 'result after expiry' });
    assert.match(seen.finalResults.get(ttlDir).at(-1), /approval card expired before anyone answered it/);
    assert.ok(existsSync(ttlDir));

    // 5. Switch off: no classifier call, no card, the command runs.
    await api.setHostSettings({ autoReviewInstructions: { isEnabled: false, allowInstructions: [], blockInstructions: [] } });
    const offDir = await scratch('off');
    const offBot = await newBot(api, 'off');
    const classifierCallsBefore = seen.classifierCalls.length;
    await api.sendPrompt({ agentId: offBot, prompt: `AUTO_REVIEW_RM ${offDir}`, clientNonce: 'off-1' });
    await waitFor(() => seen.finalResults.has(offDir), { what: 'unreviewed result' });
    assert.equal(seen.classifierCalls.length, classifierCallsBefore);
    assert.equal(await cardOf(api, offBot), undefined);
    assert.ok(!seen.shellSchemas.at(-1).includes('request_smart_mode_approval'));
    assert.ok(!existsSync(offDir));
    assert.deepEqual(executed, [approveDir, offDir]);
  });
}
}
