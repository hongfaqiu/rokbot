import { createRequire } from 'node:module';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { provisionResources } from './host-resources.mjs';
import { resolve, join } from 'node:path';
import { loadModelConfig } from './config.mjs';
import { createExtensionStarter } from './host-extensions.mjs';
import { installHostNetworkBoundary } from './host-network.mjs';
import { loadRecoveredHostCore } from './recovered-host-core.mjs';
import { prepareHostReliability } from './reliability/prepare.mjs';
import { withLibraryCleanup } from './host-library-files.mjs';
import { installDefaultMachineRouting, observeHostComputers } from './host-computers.mjs';
import { loadExecutionNode, connectExecutionNode } from '../server/execution-node.mjs';
import { writePrivate } from '../server/storage.mjs';
import { decorateLocalSharingApi } from './sharing-import.mjs';
import { decorateLocalMigrationApi } from './migrate-import.mjs';
import { installLocalPromptPolicy } from './prompt-runtime.mjs';
import { modelIdentityDirective } from './model-identity.mjs';
import { summarizeAgent } from './host-summarize.mjs';
import { installModelRejectionGuard } from './model-rejection-guard.mjs';
import { preserveGatewayReplyFields } from './local-harness-bridge.mjs';
import { createListArrangement, withListArrangement, subscribeWithListArrangement, transcriptTailReader, rosterRefresher } from './list-arrangement.mjs';
import { withSearchAnswer } from './search-answer.mjs';

const stateDir = process.env.ROKBOT_STATE_DIR ?? process.env.GROKBOT_STATE_DIR ?? '/research/state';
const originalDir = process.env.ROKBOT_ORIGINAL_HOST ?? process.env.GROKBOT_ORIGINAL_HOST ?? '/research/original-host';
const dataDir = process.env.ROKBOT_DATA_DIR ?? process.env.GROKBOT_DATA_DIR ?? stateDir;
installModelRejectionGuard();
Object.assign(process.env, {
  SAND_DATA_ROOT: join(stateDir, 'host-data'),
  SAND_BACKEND_URL: 'http://127.0.0.1:9',
  SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_ANALYTICS: '1',
  SAND_BOX_AUTO_UPDATE: '0', SAND_BOX_STORE_SYNC: '0', SAND_BOX_STORE_COPY_IN: '0',
  SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1',
});

await mkdir(process.env.SAND_DATA_ROOT, { recursive: true });
await provisionResources(stateDir, originalDir);
const revision = (await readFile(join(originalDir, 'version'), 'utf8')).trim();
const executionTransport = await connectExecutionNode(await loadExecutionNode(dataDir), dataDir);
const executionNode = executionTransport.config;
if (executionNode?.enabled) {
  process.env.ROKBOT_EXECUTION_URL = executionNode.url;
  process.env.ROKBOT_BOX_HOST = new URL(executionNode.url).hostname;
  process.env.ROKBOT_BOX_TOKEN = executionNode.token;
}
const model = await loadModelConfig();
const tokenFile = process.env.ROKBOT_INTERNAL_HOST_TOKEN_FILE ?? process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE;
const internalToken = tokenFile
  ? (await readFile(tokenFile, 'utf8')).trim() : undefined;
if (internalToken !== undefined && !/^[A-Za-z0-9_-]{32,256}$/.test(internalToken)) throw new Error('Invalid internal Host token');
const boxHost = process.env.ROKBOT_BOX_HOST ?? process.env.GROKBOT_BOX_HOST;
const allowedHosts = boxHost ? [boxHost] : [];
const notificationUrl = process.env.ROKBOT_NOTIFICATION_URL ?? process.env.GROKBOT_NOTIFICATION_URL;
if (notificationUrl) allowedHosts.push(new URL(notificationUrl).hostname);
if (model.policy.mode === 'adaptive' || model.modelRouting?.adaptiveRouting?.enabled) allowedHosts.push('api.typesafe.ai');
installHostNetworkBoundary(model.modelBaseUrls ?? model.baseUrl, { additionalHosts: allowedHosts });
const require = createRequire(import.meta.url);
const recovered = (process.env.ROKBOT_RECOVERED_CORE ?? process.env.GROKBOT_RECOVERED_CORE) === '1';
let libraryPath = resolve(stateDir, 'host-library.cjs'), repaired;
if (recovered) {
  repaired = await prepareHostReliability(stateDir);
  libraryPath = repaired.libraryPath;
}
const library = require(libraryPath);
const core = recovered ? await loadRecoveredHostCore(library, repaired.directory) : { mode: 'bundled' };
if (recovered) core.reliability = repaired.status;
library.activateHostLocale();
const prompts = await installLocalPromptPolicy(dataDir, library, { revision, modelIdentity: modelIdentityDirective(model) });
const host = new library.SandHost({
  environment: library.readSandHostEnvironment(process.env),
  startExtensions: createExtensionStarter(library, model),
});
let gateway, computers;
let stopping = false;
async function saveHostStatus(status) {
  const destination = join(stateDir, 'host-status.json');
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, destination);
}
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[local-host] stopping (${signal})`);
  computers?.close();
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  // Persist in-flight turns/background work (and their last progress) before dispose aborts them,
  // so the next start can tell each bot what was interrupted.
  try {
    host.transcript?.rokbotBackgroundRecovery?.beginShutdown(signal);
  } catch (error) {
    console.warn('[local-host] could not record in-flight work:', error?.message ?? error);
  }
  await gateway?.close();
  await host.dispose();
  await executionTransport.close();
  await prompts.close();
  await saveHostStatus({
    ready: false, stoppedAt: new Date().toISOString(), pid: process.pid,
  });
  clearTimeout(deadline);
  process.exit(0);
}
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));

try {
  await host.start();
  try {
    await host.getApi().setHostSettings({
      featureFlagOverrides: { sand_multi_machine_local_exec: true },
    });
  } catch (error) {
    console.warn('[local-host] failed to enable multi-machine local-exec routing:', error?.message ?? error);
  }
  const localExecBridge = host.getLocalExecBridge();
  const defaultMachineId = installDefaultMachineRouting(localExecBridge, process.env.ROKBOT_DEFAULT_MACHINE_ID ?? process.env.GROKBOT_DEFAULT_MACHINE_ID);
  if (defaultMachineId) {
    console.log(`[local-host] default local-exec machine: ${defaultMachineId}`);
  }
  computers = observeHostComputers(localExecBridge);
  const localApplicationRpc = args => {
    if (args?.action === 'rokbot.manual-summary') return summarizeAgent(host, library, args.agentId);
    return host.requireHostExtensions().api('mcp').applicationRpc(args);
  };
  // Session list fields (last message time, pending cards) for every client.
  const listArrangement = createListArrangement({ readTail: transcriptTailReader(host) });
  const getHostHealth = () => {
    const base = host.getHealth();
    const searchIndex = host.hostExtensions?.api('content-search')?.getHealth?.();
    return searchIndex ? { ...base, searchIndex } : base;
  };
  gateway = await library.startGatewayServer({
    api: decorateLocalMigrationApi({ api: decorateLocalSharingApi({ api: withSearchAnswer({ ...withListArrangement(preserveGatewayReplyFields(withLibraryCleanup(host.getApi(), host, library)), listArrangement), localApplicationRpc }), host }), host }),
    subscribe: subscribeWithListArrangement(listener => host.subscribe(listener), listArrangement, rosterRefresher(host)),
    getHealth: getHostHealth, startedAt: host.startedAt,
    host: process.env.ROKBOT_HOST_BIND ?? process.env.GROKBOT_HOST_BIND ?? '0.0.0.0', port: Number(process.env.ROKBOT_HOST_PORT ?? process.env.GROKBOT_HOST_PORT ?? 1340),
    ...(internalToken ? { authToken: internalToken } : {}),
    onDesktopContact: () => host.noteDesktopContact(),
    prepareForUpgrade: async () => {
      if (internalToken) {
        // Freeze new turns in the same synchronous step as the idle check.
        // The original upgrade path otherwise awaits work before pausing turns.
        if (!host.transcript.isForcedUpgradePauseActive() && host.getHealth().isBusy)
          return { quiescing: false, runningTurns: 1 };
        const paused = await host.transcript.pauseTurnsForUpgrade();
        if (!paused.quiescing || paused.runningTurns > 0) return paused;
      }
      return host.prepareForUpgrade();
    },
    localExec: computers.bridge, webauthn: host.getWebAuthnBridge(),
    sseGzipDisabled: host.environment?.gatewaySseGzipDisabled ?? false,
    onCommandError: report => host.reportGatewayCommandError(report),
    onCommandComplete: report => host.reportGatewayCommandSuccess(report),
  });
  const searchIndex = host.hostExtensions?.api('content-search')?.getHealth?.();
  const status = { ready: true, revision, model: model.model, pid: process.pid,
    port: gateway.port, dataRoot: process.env.SAND_DATA_ROOT, identity: 'local-workspace',
    officialAccount: false, officialBackend: false, telemetry: false, updates: false, core,
    ...(searchIndex ? { searchIndex } : {}) };
  await saveHostStatus(status);
  await writePrivate(join(dataDir, 'execution-active.json'), JSON.stringify({
    revision: executionNode?.revision ?? '', pid: process.pid,
    config: executionNode ?? { enabled: false }, appliedAt: new Date().toISOString(),
  }));
  console.log(`[local-host] ready ${JSON.stringify({ revision: status.revision, model: status.model,
    pid: status.pid, port: status.port, core: core.mode, dataRoot: status.dataRoot })}`);
} catch (error) {
  console.error('[local-host] startup failed:', error);
  process.exitCode = 1;
  await host.dispose().catch(() => {});
  await executionTransport.close();
  await prompts.close();
  process.exit(1);
}
