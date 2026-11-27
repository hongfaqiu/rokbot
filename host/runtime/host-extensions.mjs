import { createModelSession } from './model-session.mjs';
import { startLocalHostMcp } from './host-mcp.mjs';
import { decorateLocalHostAutomations } from './host-automations.mjs';
import { createHarnessModelErrorMapper } from './model-errors.mjs';
import { observeModelFetch } from './model-observation.mjs';
import { startLocalNotifications } from './host-notifications.mjs';
import { startLocalAutoReview } from './host-auto-review.mjs';
import { localTemplates } from './host-local-profile.mjs';
import { createModelRouter } from './model-router.mjs';
import { recordUsage } from './usage-ledger.mjs';
import { recordRouting } from './routing-log.mjs';
import { transcribeLocalAudio } from './host-speech.mjs';
import { createLocalCapabilities, startLocalMemory } from './host-capabilities.mjs';
import { contextPolicyFor } from './context-policy.mjs';
import { startLocalManagedSkills } from './host-skills.mjs';
import { startLocalWebhooks } from './host-webhooks.mjs';
import { startLocalFederation } from './host-federation.mjs';
import { createLocalServiceRuntime } from './media-runtime.mjs';
import { modelRouteForAgent } from './model-routing.mjs';
import { contextCacheFilePath } from './model-context-cache.mjs';
import { createLocalExecBridge } from './local-exec-bridge.mjs';
import { decorateHostExtensionsFor2bb5e41 } from './local-harness-bridge.mjs';

const unsubscribe = () => () => {};
export function unavailable(capability) {
  const error = new Error(`${capability} is unavailable in the local workspace runtime`);
  error.code = 'LOCAL_CAPABILITY_UNAVAILABLE';
  return error;
}
const rejectCapability = capability => async () => { throw unavailable(capability); };

function localAuth() {
  return {
    getAccessToken: rejectCapability('Official account authentication'),
    getBestEffortAccessToken: async () => null,
    peekAccessToken: () => null,
    getTeamId: async () => undefined,
    getMachineId: async () => 'local-workspace',
    getLastRenewalEvent: () => null,
    subscribeToRenewal: unsubscribe,
    getUserFullName: () => undefined,
    holdCredentialRenewals: () => () => {},
    setCredentialRenewalTimeoutReader() {},
    getBoxCredentialMint: () => null,
  };
}

function localIdentity(context) {
  return {
    isWriteEnabled: async () => false,
    ensureServerBacked: rejectCapability('Server agent identity'),
    createRemoteAgentFirst: async (_fields, options) => {
      if (options?.harness === 'temporal') throw unavailable('Server agent creation');
      return null;
    },
    createAgentFromTemplate: rejectCapability('Published bot templates'),
    rollbackRemoteAgent: rejectCapability('Server agent rollback'),
    adoptServerAgent: rejectCapability('Server agent identity'),
    adoptServerAgentById: async (agentId) => {
      const store = context?.deps?.session?.store;
      if (typeof store?.agentDirExists === 'function' && !store.agentDirExists(agentId)) {
        return 'missing';
      }
      return 'bound';
    },
    ensureServerRoomMembers: async () => {},
    reconcileBeforeStartupResume: async () => ({ reconciled: true }),
    reconcileBeforeResume: async () => ({ reconciled: true }),
    getHarnessMigrationCoverage: async () => ({}),
    deleteAgents: async (agentIds = []) => {
      const ids = [...new Set(agentIds)];
      const local = ids.length > 0 && typeof context?.deps?.transcript?.deleteAgents === 'function'
        ? await context.deps.transcript.deleteAgents(ids)
        : null;
      return { deletedIds: ids, refusedIds: [], failedIds: [], local };
    },
    subscribeTemporalMirrorsDropped: unsubscribe,
    flushPendingEdits: async () => {},
    expectLocalEdit: (_agentId, write) => (typeof write === 'function' ? write() : undefined),
    clearGeneratedRoomNameStamps: async () => ({ outcome: 'already_done', clearedIds: [] }),
    noteAgentImported() {}, noteAgentMinted() {}, async noteAgentDeleted() {},
    async reconcileNow() { return false; },
  };
}

function inferenceAgentId(options) {
  const id = options?.agentId ?? options?.getAgentId?.() ?? options?.agentStore?.getId?.();
  return typeof id === 'string' && id ? id : undefined;
}

export function createInference(config, library, services, { fetchImpl, sessionFactory = createModelSession } = {}) {
  const modelFetch = fetchImpl ?? globalThis.fetch;
  return {
    isReady: async () => true,
    port: {
      resolvePrivacyMode: async () => library.PrivacyMode.NO_STORAGE,
      getGeminiVideoAttachedMediaUrlProvider: () => undefined,
      videoAnalysisEnabled: services.videoAnalysisEnabled,
      createSession: (onRequestId, options) => ['watchVideo', 'videoReview'].includes(options?.localMediaKind) && services.videoAnalysisEnabled(options.localMediaKind)
        ? services.createVideoSession(options.localMediaKind, onRequestId)
        : (() => {
          const agentId = inferenceAgentId(options);
          const route = config.modelRouting ? modelRouteForAgent(config.modelRouting, agentId) : undefined;
          const sessionConfig = route ? { ...config, ...route } : { ...config, ...contextPolicyFor(config, config.model) };
          const routerConfig = options?.isSummarizationSession
            ? (config.modelRouting
              ? (config.modelRouting.adaptiveRouting?.enabled
                ? { ...config, modelRouting: { ...config.modelRouting, adaptiveRouting: { ...config.modelRouting.adaptiveRouting, enabled: false } } }
                : config)
              : (config.policy ? { ...config, policy: { ...config.policy, mode: 'manual' } } : config))
            : config;
          return sessionFactory({ ...sessionConfig, onRequestId,
            contextCachePath: contextCacheFilePath(config.dataDirectory),
            selectRequest: createModelRouter(routerConfig, { agentId, fetchImpl: modelFetch, onDecision: decision => console.info('[model-router]', JSON.stringify(decision)) }),
            onFallback: event => recordRouting(config.routingDirectory, { kind: 'model-fallback', status: 'fallback', agentId,
              session: options?.isSummarizationSession ? 'summary' : 'chat', ...event }),
            onUsage: usage => recordUsage(config.usageDirectory, { ...usage, kind: options?.isSummarizationSession ? 'summary' : 'chat' }),
            fetchImpl: observeModelFetch(modelFetch, options),
            mapError: createHarnessModelErrorMapper(library) });
        })(),
      // These are official analytics endpoints, disabled with Host telemetry.
      recordPostTurnLabeling() {}, recordFollowupLabeling() {},
    },
    onModelExperimentApplied: unsubscribe,
    createWebSearch: services.createWebSearch,
    createWebFetch: services.createWebFetch,
    transcribeAudio: transcribeLocalAudio,
    previewVoice: rejectCapability('Voice preview'),
  };
}

/** Keep original stateful extensions; substitute account and inference boundaries. */
export function createExtensionStarter(library, modelConfig) {
  let capabilities, services;
  const apis = new Map();
  const replacements = {
    auth: () => localAuth(),
    'agent-identity': context => localIdentity(context),
    'desktop-telemetry': () => ({}),
    orbit: () => ({}),
    'identity-socket': () => ({ isEnabled: false }),
    'user-skills-cache': () => ({ isEnabled: false }),
    'team-admin-policy': () => ({
      isCloudAgentsDisabled: () => true,
      getSnapshot: () => undefined,
      peekSnapshot: () => undefined,
      isLocalEgressRequired: () => false,
      subscribeLocalEgressRequired: unsubscribe,
      noteLocalEgressInputsChanged() {},
      whenLocalEgressRecordSettled: async () => {},
      subscribe: unsubscribe,
      prefetch() {},
      invalidate() {},
      dispose() {},
    }),
    'local-exec': context => createLocalExecBridge({
      gate: {
        blockedReason: id => apis.get('local-tool-permission')?.blockedReason?.(id),
        requiresApproval: id => apis.get('local-tool-permission')?.requiresApproval?.(id) ?? false,
      },
      logs: context.deps.telemetry?.logs,
      onComputerAttached: () => void context.host.events.emit('local-exec.computer-attached', {}),
      library,
    }),
    'managed-setup': startLocalManagedSkills,
    'bot-template-share': () => localTemplates(),
    'remote-agent-messaging': context => startLocalFederation(context, { extensions: id => apis.get(id) }),
    inference: () => createInference(modelConfig, library, services),
    mcp: context => startLocalHostMcp(context, library, { nativeEnabled: () => capabilities.get().macComputer,
      permission: () => apis.get('local-tool-permission') }),
    'auto-review': context => startLocalAutoReview(context, library, modelConfig, {
      auth: apis.get('auth'),
      settings: apis.get('settings'),
      telemetry: apis.get('telemetry'),
    }),
    ...(process.env.ROKBOT_NOTIFICATION_URL ?? process.env.GROKBOT_NOTIFICATION_URL
      ? { notifications: context => startLocalNotifications(context, library) } : {}),
  };
  return async ({ host }) => {
    const extensionDir = process.env.ROKBOT_DATA_DIR ?? process.env.GROKBOT_DATA_DIR ?? process.env.ROKBOT_STATE_DIR ?? process.env.GROKBOT_STATE_DIR ?? '/research/state';
    capabilities = await createLocalCapabilities(extensionDir);
    services = await createLocalServiceRuntime(extensionDir);
    const startExtension = async (extension, context) => {
      host.log(`starting extension ${extension.id}`);
      if (extension.id === 'memory') {
        const api = await startLocalMemory(context, extension, capabilities);
        return decorateHostExtensionsFor2bb5e41(extension, api, {
          context, library, apis, getInferenceReady: () => apis.get('inference')?.isReady?.() ?? true,
        });
      }
      const api = await (replacements[extension.id] ? replacements[extension.id](context) : extension.start(context));
      if (extension.id === 'attachments') return services.decorateAttachments(api);
      if (extension.id === 'experiments') {
        context.onStop(() => capabilities.close());
        return capabilities.experiments(api);
      }
      if (extension.id === 'turn-execution' || extension.id === 'transcript') {
        return decorateHostExtensionsFor2bb5e41(extension, api, {
          context, library, apis, getInferenceReady: () => apis.get('inference')?.isReady?.() ?? true,
        });
      }
      if (extension.id !== 'automations') return api;
      const turnExecution = apis.get('turn-execution');
      const settings = apis.get('settings');
      const automations = await decorateLocalHostAutomations(context, library, api, { turnExecution, settings });
      const webhooks = await startLocalWebhooks(context, { turnExecution });
      return { ...automations,
        ...(webhooks.getWebhookCredential ? { getWebhookCredential: webhooks.getWebhookCredential } : {}),
        async suspendWakes() { webhooks.suspend(); apis.get('remote-agent-messaging')?.suspend?.(); return automations.suspendWakes(); },
        resumeWakes() { const result = automations.resumeWakes(); webhooks.resume(); apis.get('remote-agent-messaging')?.resume?.(); return result; },
      };
    };
    const extensions = library.hostExtensionRegistry.map(extension => ({
      ...extension,
      start: async context => {
        const api = await startExtension(extension, context); apis.set(extension.id, api); return api;
      },
    }));
    const started = await library.startHostExtensions({
      extensions, host,
      onStopFailure: (id, error) => host.log(`extension ${id} stop failed: ${error.message}`),
    });
    return { order: started.order, api: id => started.apis[id], stop: started.stop };
  };
}
