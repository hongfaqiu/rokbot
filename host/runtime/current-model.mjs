// T-59: a read-only "which model is answering right now" query for the bot.
// The base prompt (model-identity.mjs) states the *configured* models and is rendered before a
// model is chosen, so it cannot know which route or fallback served a call. The model session
// records the candidate that actually answered each call (getServedModel); this module keeps the
// newest record per runner and offers it as the CurrentModel tool. Only model IDs and display
// names leave the session: never API keys, base URLs or tokens.
import { makeLocalHarnessTool } from './local-state-tools.mjs';

export const CURRENT_MODEL_TOOL_NAME = 'CurrentModel';

const CURRENT_MODEL_DESCRIPTION = [
  'Read-only. Returns the model that actually served this conversation\'s latest model call (the one that decided to call this tool),',
  'including the configured fallback model when the primary route failed and a fallback answered.',
  'Call it when asked which model you are, which model is answering, or whether a fallback is in use, and answer with what it returns.',
  'It also states the configured route (primary and fallbacks) that this Bot\'s next turns will use.',
  'It never returns API keys, tokens or endpoint URLs. Takes no arguments.',
].join(' ');

const clean = value => typeof value === 'string' ? value.replace(/[\r\n`]+/g, ' ').trim().slice(0, 120) : '';

function label(model, providerName) {
  const id = clean(model);
  if (!id) return '';
  const provider = clean(providerName);
  return provider ? `\`${id}\` (${provider})` : `\`${id}\``;
}

/** One line for the bot, from a getServedModel() record. */
export function describeServedModel(served) {
  const current = label(served?.model, served?.providerName);
  if (!current) {
    return 'No model call has completed in this conversation yet. Answer from the "Model configuration" note instead.';
  }
  const lines = [];
  const primary = label(served.primaryModel, served.primaryProviderName);
  if (served.fallback && primary && primary !== current) {
    lines.push(`This turn is served by ${current}, a configured fallback: the primary model ${primary} failed, so the fallback answered.`);
  } else {
    lines.push(`This turn is served by ${current}, the primary model of the route configured for this conversation.`);
  }
  const reported = clean(served.reportedModel);
  if (reported && reported !== clean(served.model)) lines.push(`The provider reports its model ID as \`${reported}\`.`);
  return lines.join(' ');
}

// Same scenarios host-extensions.mjs routes separately; their sessions are not "this turn".
const backgroundSession = options => Boolean(options?.isSubagent || options?.isSummarizationSession
  || options?.modelId === 'sand-memory-extraction');

/** Remembers the chat sessions a runner opens and reports the newest served model among them. */
export function createServedModelTracker({ keep = 8 } = {}) {
  const sessions = [];
  return {
    wrapInference(port) {
      if (!port || typeof port.createSession !== 'function') return port;
      return {
        ...port,
        createSession(onRequestId, options) {
          const session = port.createSession(onRequestId, options);
          if (session && typeof session.getServedModel === 'function' && !backgroundSession(options)) {
            sessions.push(session);
            if (sessions.length > keep) sessions.splice(0, sessions.length - keep);
          }
          return session;
        },
      };
    },
    latest() {
      let newest;
      for (const session of sessions) {
        let served;
        try { served = session.getServedModel(); } catch { served = undefined; }
        if (served && (!newest || (served.servedAt ?? 0) >= (newest.servedAt ?? 0))) newest = served;
      }
      return newest;
    },
  };
}

/**
 * `configured()` (optional) returns the credential-free line for the route this Bot's next turns
 * use, read from the same live routing object the inference sessions use (model-change.mjs).
 */
export function createCurrentModelTool(library, tracker, { configured } = {}) {
  return makeLocalHarnessTool(library, {
    name: CURRENT_MODEL_TOOL_NAME,
    description: CURRENT_MODEL_DESCRIPTION,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const served = describeServedModel(tracker.latest());
      let route = '';
      try { route = configured?.() ?? ''; } catch { route = ''; }
      return route ? `${served} ${route}` : served;
    },
  });
}
