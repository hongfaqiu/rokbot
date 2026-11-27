import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createLocalCanvasPort } from '../runtime/local-canvas.mjs';
import { createLocalTrackedTasks } from '../runtime/local-tracked-tasks.mjs';
import {
  localCanvasOptions,
  localSkillToolOptions,
  localTrackedTasksOptions,
} from '../runtime/local-harness-bridge.mjs';
import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

async function* chunksOf(obj) {
  yield JSON.stringify(obj);
}

test('createLocalCanvasPort supports write, read, update, list, and safe ID validation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-canvas-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const port = createLocalCanvasPort({ agentDir: dir, agentId: 'bot-97' });
  const empty = await port.list({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.canvases, []);

  const created = await port.write({ title: 'Release Notes', source: '# v97658ad\nAll good.' });
  assert.equal(created.ok, true);
  assert.ok(created.canvasId.startsWith('canvas-'));
  assert.equal(created.title, 'Release Notes');

  const fetched = await port.read({ canvasId: created.canvasId });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.source, '# v97658ad\nAll good.');

  const rewritten = await port.write({ canvasId: created.canvasId, source: '# v97658ad\nUpdated.' });
  assert.equal(rewritten.ok, true);
  assert.equal(rewritten.title, 'Release Notes');
  assert.equal((await port.read({ canvasId: created.canvasId })).source, '# v97658ad\nUpdated.');

  const listed = await port.list({ query: 'Updated' });
  assert.equal(listed.ok, true);
  assert.equal(listed.canvases.length, 1);
  assert.equal(listed.canvases[0].canvasId, created.canvasId);

  const badRead = await port.read({ canvasId: '../etc/passwd' });
  assert.equal(badRead.ok, false);
  assert.equal(badRead.reason, 'not_found');

  assert.deepEqual(localCanvasOptions({ agentDir: dir }, { ROKBOT_LOCAL_CANVAS: '0' }), {});
});

test('createLocalTrackedTasks persists tasks, updates, tags, and subagent handoff linkage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-tasks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tracked = createLocalTrackedTasks({ agentDir: dir });
  assert.equal(tracked.unavailable, false);
  assert.deepEqual(
    tracked.tools.map((tool) => tool.name),
    ['CreateTrackedTasks', 'ListTrackedTasks', 'UpdateTrackedTasks', 'UpdateTrackedTaskTags'],
  );

  const byName = Object.fromEntries(tracked.tools.map((tool) => [tool.name, tool]));
  const createRes = await byName.CreateTrackedTasks.execute({}, {}, chunksOf({
    tasks: [{ title: 'Audit upstream diff' }, { title: 'Verify Docker smoke' }],
  }));
  assert.match(createRes.content[0].text, /RB-1/);
  assert.match(createRes.content[0].text, /RB-2/);

  const task1 = await tracked.read('RB-1');
  assert.equal(task1?.title, 'Audit upstream diff');
  assert.equal(task1?.status, 'todo');

  const linked = await tracked.linkSubagent({ keys: ['RB-1'], subagentId: 'sub-1', callId: 'call-1' });
  assert.equal(linked.length, 1);
  assert.equal(linked[0].key, 'RB-1');
  assert.equal((await tracked.read('RB-1')).status, 'in_progress');
  assert.deepEqual((await tracked.read('RB-1')).subagentIds, ['sub-1']);

  await byName.UpdateTrackedTaskTags.execute({}, {}, chunksOf({
    tags: [{ id: 'host', label: 'Host', color: 'blue' }],
  }));
  await byName.UpdateTrackedTasks.execute({}, {}, chunksOf({
    updates: [{ key: 'RB-1', status: 'done', tags: ['host'] }],
  }));
  const listOpen = await byName.ListTrackedTasks.execute({}, {}, chunksOf({}));
  assert.doesNotMatch(listOpen.content[0].text, /RB-1/);
  assert.match(listOpen.content[0].text, /RB-2/);

  const listAll = await byName.ListTrackedTasks.execute({}, {}, chunksOf({ include_closed: true, tag: 'host' }));
  assert.match(listAll.content[0].text, /RB-1 \[done\]/);

  // Opt-in by default; enabled with ROKBOT_TRACKED_TASKS=1
  assert.deepEqual(localTrackedTasksOptions({ agentDir: dir }, {}), {});
  assert.ok(localTrackedTasksOptions({ agentDir: dir }, { ROKBOT_TRACKED_TASKS: '1' }).trackedTasks);
});

test('localSkillToolOptions enables virtualSkillFiles and serves skill files from Host disk', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-skill-tool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const skillDir = join(dir, 'my-skill');
  await mkdir(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  await writeFile(skillFile, '---\nname: my-skill\n---\nFollow these steps.\n');

  const baseStore = {
    list: () => [{ id: 'my-skill', name: 'my-skill', filePath: skillFile }],
    listAll: () => [{ id: 'my-skill', name: 'my-skill', filePath: skillFile }],
  };
  const opts = localSkillToolOptions(baseStore, {});
  assert.equal(opts.skillStore.virtualSkillFiles, true);

  const readSkill = opts.readManagedSkill({ path: skillFile });
  assert.equal(readSkill.result.case, 'success');
  assert.match(readSkill.result.value.output.value, /Follow these steps/);

  // Non-skill files return undefined so box reads continue untouched.
  assert.equal(opts.readManagedSkill({ path: '/etc/hosts' }), undefined);

  const disabled = localSkillToolOptions(baseStore, { ROKBOT_SKILL_TOOL: '0' });
  assert.equal(disabled.skillStore.virtualSkillFiles, undefined);
  assert.equal(disabled.readManagedSkill, undefined);
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

if (configuredSeed) {
  test('real 97658ad Host enables Skill/Canvas, supports ROKBOT_TRACKED_TASKS=1, and keeps cloud-only gates disabled', async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-97658ad-features-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const workSeed = join(stateDir, 'seed');
    await cp(configuredSeed, workSeed, { recursive: true });
    const reliableDir = join(workSeed, 'reliable-core', 'v1');
    await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
    await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
    await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

    const tokenFile = join(stateDir, 'internal-host-token');
    await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

    const requests = [];
    const modelServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(req.url?.startsWith('/internal/') ? 200 : 404, { 'content-type': 'application/json' });
      res.end(req.url === '/internal/connectors/runtime'
        ? JSON.stringify({ revision: 0, config: { mcpServers: {} }, display: { servers: [] } })
        : 'null');
    });
    await new Promise((r) => modelServer.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => { modelServer.closeAllConnections?.(); modelServer.close(r); }));
    const modelBase = `http://127.0.0.1:${modelServer.address().port}`;

    const execServer = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => execServer.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => { execServer.closeAllConnections?.(); execServer.close(r); }));
    const execBase = `http://127.0.0.1:${execServer.address().port}`;

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
      ROKBOT_TRACKED_TASKS: '1',
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
      process.env[k] = v;
    }
    const restoreEnv = () => {
      for (const [k, v] of prevEnv.entries()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };

    const require = createRequire(import.meta.url);
    const library = require(join(workSeed, 'host-library-reliable.cjs'));
    let host;
    try {
      await loadRecoveredHostCore(library, reliableDir);
      host = new library.SandHost({
        environment: library.readSandHostEnvironment(process.env),
        startExtensions: createExtensionStarter(library, {
          apiFormat: 'openai',
          baseUrl: `${modelBase}/v1`,
          apiKey: 'test-key',
          model: 'gpt-4o-mini',
          policy: defaultPolicy('gpt-4o-mini'),
          usageDirectory: join(stateDir, 'usage'),
          routingDirectory: join(stateDir, 'routing'),
        }),
      });
      await host.start();
      assert.deepEqual(host.requireHostExtensions().api('desktop-telemetry'), {});

      const api = host.getApi();
      const created = await api.createAgent({ name: 'Feature Bot', description: '97658ad feature check' });
      const agentId = created.agent.id;
      await api.openAgent({ id: agentId });
      await api.sendPrompt({ agentId, prompt: 'hello 97658ad', clientNonce: 'feat-97658ad' });
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);

      assert.ok(requests.length > 0);
      const body = requests[0];
      const nativeTools = (body.tools ?? []).map((tool) => (tool.function ?? tool).name);
      const text = (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      const ns = text.match(/<namespace name="cursor" tools="([^"]*)"/);
      const allTools = [...nativeTools, ...(ns ? ns[1].split(',').map((s) => s.trim()).filter(Boolean) : [])];

      // New self-hosted upstream features enabled:
      for (const expected of ['Skill', 'ReadCanvas', 'WriteCanvas', 'EditCanvas', 'ListCanvases', 'CreateTrackedTasks', 'ListTrackedTasks', 'UpdateTrackedTasks', 'Subagent']) {
        assert.ok(allTools.includes(expected), `Expected ${expected} in tool list: ${allTools.join(', ')}`);
      }
      // Verify cloud-only gates remain disabled:
      const session = await host.transcript.sessions.resolveBackgroundSession(agentId);
      const runner = host.transcript.ensureRunnerRegistry().getRunner(session);
      for (const cloudGate of [
        'financeCards', 'financeBalancesSpendingViews', 'tradingCards', 'shoppingCards',
        'shoppingDeals', 'shoppingTryOn', 'slackUserPresence', 'voiceCall',
        'eventTicketCard', 'reservationCard', 'placesCard', 'appearancePickerCard',
        'automationPurchaseCard', 'cloudflareSolverService',
      ]) {
        assert.equal(runner.gates[cloudGate](), false, `Cloud gate ${cloudGate} must stay false`);
      }
      assert.equal(runner.gates.cloudAgentsDisabledByTeam(), true);

      // Verify holdDurationMs and modifiers are supported on Computer tool:
      const comp = library.getComputerRecoveryBindings();
      const computerTool = comp.createComputerTool(
        { get: () => ({ execute: async () => ({ result: { case: 'success', value: { actionCount: 4, durationMs: 100 } } }) }) },
        { autoReview: undefined },
      );
      const schemaText = JSON.stringify(computerTool.parameters ?? {});
      assert.match(schemaText, /"holdDurationMs"/, 'Computer tool schema must expose holdDurationMs');
      assert.match(schemaText, /"modifiers"/, 'Computer tool schema must expose modifiers');
    } finally {
      await host?.dispose();
      restoreEnv();
    }
  });
}
