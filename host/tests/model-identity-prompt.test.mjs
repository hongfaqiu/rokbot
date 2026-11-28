import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_MODEL_IDENTITY_PROMPT_LINE, modelIdentityDirective, summarizeConfiguredModels } from '../runtime/model-identity.mjs';
import { promptToolsOverrides } from '../runtime/recovered-prompt-tools.mjs';
import { installLocalPromptPolicy } from '../runtime/prompt-runtime.mjs';
import { parseModelRouting } from '../runtime/model-routing.mjs';

// Real-seed check (optional; the real Host keeps timers alive, so force exit):
//   ROKBOT_TEST_HOST_SEED=/tmp/rokbot-seed/seed node --test --test-force-exit host/tests/model-identity-prompt.test.mjs
const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

const UPSTREAM_EVASION = /Never identify yourself as|do not name or speculate|say you are Grok Bot/;
const FAKE_KEY = 'sk-test-identity-0123456789';

function routedConfig() {
  const routing = {
    version: 1,
    providers: [
      { id: 'p1', name: 'Mock Provider', baseUrl: 'http://127.0.0.1:1/v1', apiKey: FAKE_KEY, apiFormat: 'openai' },
      { id: 'p2', name: 'Backup Provider', baseUrl: 'http://127.0.0.1:2/v1', apiKey: FAKE_KEY, apiFormat: 'anthropic' },
    ],
    profiles: [
      { id: 'main', name: 'Main', providerId: 'p1', model: 'mock-chat-1' },
      { id: 'backup', name: 'Backup', providerId: 'p2', model: 'mock-backup-2' },
    ],
    defaultRoute: { profileId: 'main', fallbacks: [{ profileId: 'backup' }] },
    botRoutes: { 'agent-x': { profileId: 'backup', fallbacks: [] } },
  };
  const { config } = parseModelRouting(JSON.stringify(routing), {});
  return { modelRouting: config, model: 'mock-chat-1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: FAKE_KEY };
}

test('identity line names the profile, reports the configured model and keeps the secrets boundary (EN + ZH)', () => {
  assert.doesNotMatch(LOCAL_MODEL_IDENTITY_PROMPT_LINE, UPSTREAM_EVASION);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /agent name in your profile/);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /configured to use/);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /Never invent model names, version numbers/);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /Never reveal API keys, tokens/);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /档案里的名字/);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /不许编造/);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /API key、token、密码等密钥一律不说/);
  assert.match(LOCAL_MODEL_IDENTITY_PROMPT_LINE, /模型服务 → 对话模型/);
  assert.equal(promptToolsOverrides.SAND_MODEL_IDENTITY_PROMPT_LINE('upstream'), LOCAL_MODEL_IDENTITY_PROMPT_LINE);
});

test('directive reports the routed primary, fallbacks and bot routes without credentials or URLs', () => {
  const directive = modelIdentityDirective(routedConfig());
  assert.match(directive, /default chat model is `mock-chat-1` \(Mock Provider\)/);
  assert.match(directive, /fall back to `mock-backup-2` \(Backup Provider\)/);
  assert.match(directive, /Some bots have their own route using `mock-backup-2`/);
  assert.doesNotMatch(directive, new RegExp(FAKE_KEY));
  assert.doesNotMatch(directive, /127\.0\.0\.1|https?:/);
});

test('directive handles legacy OPENAI_MODEL-only configuration and missing config', () => {
  assert.match(modelIdentityDirective({ model: 'legacy-model', apiKey: FAKE_KEY, baseUrl: 'http://x' }), /default chat model is `legacy-model`\./);
  assert.equal(modelIdentityDirective(null), null);
  assert.equal(summarizeConfiguredModels({ model: '' }), null);
});

test('prompt policy appends the model directive to user-facing roles only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-model-identity-'));
  const prompts = await installLocalPromptPolicy(dir, null, { pollMs: 60_000, memoryMounts: false, modelIdentity: 'MODEL_NOTE' });
  t.after(async () => { await prompts.close(); await rm(dir, { recursive: true, force: true }); });
  const render = prompts.snapshot();
  assert.match(render('parent', 'BASE parent'), /BASE parent\n\nMODEL_NOTE$/);
  assert.match(render('automation', 'BASE automation'), /MODEL_NOTE$/);
  assert.equal(render('generalPurpose', 'BASE sub'), 'BASE sub');
});

if (configuredSeed) {
  test('real 2bb5e41 Host system prompt carries the honest identity line and configured model', async t => {
    const { createServer } = await import('node:http');
    const { createRequire } = await import('node:module');
    const { cp, realpath, writeFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
    const { defaultPolicy } = await import('../runtime/model-policy.mjs');
    const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
    const HOST_DIR = resolve(import.meta.dirname, '..');

    const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-identity-')));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const workSeed = join(stateDir, 'seed');
    await cp(configuredSeed, workSeed, { recursive: true });
    const reliableDir = join(workSeed, 'reliable-core', 'v1');
    await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
    await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
    await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

    const textOf = m => Array.isArray(m?.content) ? m.content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : String(m?.content ?? '');
    const systems = [];
    const llm = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(req.url?.startsWith('/internal/') ? 200 : 404, { 'content-type': 'application/json' }); res.end('null'); return;
      }
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = messages.filter(m => m?.role === 'system').map(textOf).join('\n');
      if (!system.includes('GROK_BOT_MEMORY_EXTRACTION')) systems.push(system);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise(r => llm.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { llm.closeAllConnections?.(); llm.close(r); }));
    const base = `http://127.0.0.1:${llm.address().port}`;
    const exec = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise(r => exec.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { exec.closeAllConnections?.(); exec.close(r); }));
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
    const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

    const library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
    await loadRecoveredHostCore(library, reliableDir);
    const model = { apiFormat: 'openai', baseUrl: `${base}/v1`, apiKey: FAKE_KEY, model: 'mock-identity-model',
      policy: defaultPolicy('mock-identity-model'), usageDirectory: join(stateDir, 'usage'), routingDirectory: join(stateDir, 'routing') };
    const prompts = await installLocalPromptPolicy(stateDir, library, { pollMs: 60_000, memoryMounts: false, modelIdentity: modelIdentityDirective(model) });
    t.after(() => prompts.close());
    const host = new library.SandHost({ environment: library.readSandHostEnvironment(process.env), startExtensions: createExtensionStarter(library, model) });
    await host.start();
    try {
      await host.getApi().setHostSettings({ autoReviewInstructions: { isEnabled: false, allowInstructions: [], blockInstructions: [] } });
      const api = host.getApi();
      const agentId = (await api.createAgent({ name: 'Identity Probe', description: 'probe' })).agent.id;
      await api.openAgent({ id: agentId });
      await api.sendPrompt({ agentId, prompt: '你用什么模型？', clientNonce: 'identity-1' });
      const deadline = Date.now() + 20_000;
      while (!systems.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      assert.ok(systems.length, 'the mock LLM received a parent turn');
      const system = systems[0];
      assert.ok(system.includes(LOCAL_MODEL_IDENTITY_PROMPT_LINE), 'recovered prompt uses the local identity line');
      assert.match(system, /default chat model is `mock-identity-model`/);
      assert.doesNotMatch(system, UPSTREAM_EVASION);
      assert.doesNotMatch(system, new RegExp(FAKE_KEY));
    } finally {
      await host.dispose();
    }
  });
}
