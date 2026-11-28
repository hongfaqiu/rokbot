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
import { modelRouteForAgent, modelRouteForScenario } from './model-routing.mjs';
import { createLiveModelRouting } from './model-change.mjs';
import { reasoningOptions } from './model-policy.mjs';
import { contextCacheFilePath } from './model-context-cache.mjs';
import { createLocalExecBridge } from './local-exec-bridge.mjs';
import { decorateHostExtensionsFor2bb5e41 } from './local-harness-bridge.mjs';
import { startLocalContentSearch } from './content-search.mjs';
import { installLocalGroups } from './local-groups.mjs';

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

export function scenarioForSessionOptions(options) {
  if (options?.isSummarizationSession) return 'summarization';
  if (options?.modelId === 'sand-memory-extraction') return 'memoryExtraction';
  if (options?.isSubagent) return 'subagent';
  if (options?.inAutomationRun) return 'automation';
  return null;
}

const USAGE_KIND_BY_SCENARIO = {
  summarization: 'summary',
  memoryExtraction: 'memory',
  subagent: 'subagent',
  automation: 'automation',
};

export function createInference(config, library, services, { fetchImpl, sessionFactory = createModelSession } = {}) {
  const modelFetch = fetchImpl ?? globalThis.fetch;
  const explicitScenarioRoute = (scenario, agentId) => (
    scenario && config.modelRouting?.scenarioRoutes?.[scenario]
      ? modelRouteForScenario(config.modelRouting, scenario, { agentId })
      : undefined
  );
  return {
    isReady: async () => true,
    // The one configured-route source: sessions below, CurrentModel and ProposeModelChange read it.
    liveModelRouting: createLiveModelRouting(config),
    port: {
      resolvePrivacyMode: async () => library.PrivacyMode.NO_STORAGE,
      getGeminiVideoAttachedMediaUrlProvider: () => undefined,
      videoAnalysisEnabled: services.videoAnalysisEnabled,
      externalSummarizationModelId: () => explicitScenarioRoute('summarization')?.model,
      createSession: (onRequestId, options) => ['watchVideo', 'videoReview'].includes(options?.localMediaKind) && services.videoAnalysisEnabled(options.localMediaKind)
        ? services.createVideoSession(options.localMediaKind, onRequestId)
        : (() => {
          const agentId = inferenceAgentId(options);
          const scenario = scenarioForSessionOptions(options);
          const scenarioRoute = explicitScenarioRoute(scenario, agentId);
          const route = scenarioRoute ?? (config.modelRouting ? modelRouteForAgent(config.modelRouting, agentId) : undefined);
          const sessionConfig = route ? { ...config, ...route } : { ...config, ...contextPolicyFor(config, config.model) };
          const usageKind = (scenario && USAGE_KIND_BY_SCENARIO[scenario]) || 'chat';
          let selectRequest;
          if (scenarioRoute) {
            const select = candidate => ({ ...candidate, requestOptions: reasoningOptions(candidate.model, candidate.effort) });
            const selected = { ...select(scenarioRoute), fallbacks: scenarioRoute.fallbacks.map(select) };
            selectRequest = async ({ signal } = {}) => { signal?.throwIfAborted(); return selected; };
          } else {
            const disableAdaptive = scenario === 'summarization' || scenario === 'memoryExtraction';
            const routerConfig = disableAdaptive
              ? (config.modelRouting
                ? (config.modelRouting.adaptiveRouting?.enabled
                  ? { ...config, modelRouting: { ...config.modelRouting, adaptiveRouting: { ...config.modelRouting.adaptiveRouting, enabled: false } } }
                  : config)
                : (config.policy ? { ...config, policy: { ...config.policy, mode: 'manual' } } : config))
              : config;
            selectRequest = createModelRouter(routerConfig, { agentId, fetchImpl: modelFetch, onDecision: decision => console.info('[model-router]', JSON.stringify(decision)) });
          }
          return sessionFactory({ ...sessionConfig, onRequestId,
            contextCachePath: contextCacheFilePath(config.dataDirectory),
            selectRequest,
            onFallback: event => recordRouting(config.routingDirectory, { kind: 'model-fallback', status: 'fallback', agentId,
              session: usageKind, ...event }),
            onUsage: usage => recordUsage(config.usageDirectory, { ...usage, kind: usageKind, agentId }),
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
  // Group chats are local Bots; the shipped gateway would send createGroup to the official server.
  installLocalGroups(library);
  let capabilities, services;
  const apis = new Map();
  const replacements = {
    auth: () => localAuth(),
    'agent-identity': context => localIdentity(context),
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
    'content-search': context => startLocalContentSearch(context, library),
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
    // harness-settings.json is re-read here so a change applies to the very next card answer.
    const showWidgetAnswerBubble = async () => {
      try { await capabilities.refresh(); } catch {}
      return capabilities.get().showWidgetAnswerBubble !== false;
    };
    services = await createLocalServiceRuntime(extensionDir);
    const startExtension = async (extension, context) => {
      host.log(`starting extension ${extension.id}`);
      if (extension.id === 'memory') {
        const api = await startLocalMemory(context, extension, capabilities);
        return decorateHostExtensionsFor2bb5e41(extension, api, {
          context, library, apis, getInferenceReady: () => apis.get('inference')?.isReady?.() ?? true,
          showWidgetAnswerBubble,
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
          showWidgetAnswerBubble,
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
