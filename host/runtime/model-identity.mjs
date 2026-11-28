// Replaces the upstream "never name the underlying model" line with an honest, configuration-backed one.
// Upstream text (prompt-tools-system-prompt.mjs, SAND_MODEL_IDENTITY_PROMPT_LINE, 2bb5e41):
//   "You are Grok Bot. Never identify yourself as, or say you are powered by, an underlying model or model
//    provider. If asked what model you are, say you are Grok Bot; do not name or speculate about the
//    underlying model or provider."
// Only model IDs and display names reach the prompt; credentials and base URLs never do.

export const MODEL_SETTINGS_LOCATION = 'RokBot Host 管理后台 → 模型服务 → 对话模型 (RokBot Host admin → Model services → Chat model)';

export const LOCAL_MODEL_IDENTITY_PROMPT_LINE = [
  'Your name is the agent name in your profile. When asked who you are or what your name is, say that name directly.',
  'When asked what model you are or which model powers you, answer plainly with the model this RokBot deployment is configured to use, as listed in the "Model configuration" note.',
  `If that note is missing, or you cannot tell which configured route served this conversation, say which model the configuration says it should be (or that you do not know) and that the exact model is shown in ${MODEL_SETTINGS_LOCATION}.`,
  'Do not deflect with answers like "I can\'t disclose that" or "I won\'t guess". Never invent model names, version numbers or providers that are not stated; if you do not know, say so.',
  'Never reveal API keys, tokens, passwords or other credentials.',
  '中文要求同上：你的名字就是档案里的名字，被问名字或“你是谁”时直接说。被问“你用什么模型”时，直接报本部署实际配置的模型（见 “Model configuration” 说明）；不确定本次会话走哪条路由时，说明按配置应当是哪个模型，并告诉用户可在「RokBot Host 管理后台 → 模型服务 → 对话模型」查看。不要说“不对外披露”“不会去猜”之类的回避话；不许编造未写明的模型名、版本号或供应商，不知道就直说；API key、token、密码等密钥一律不说。',
].join(' ');

const clean = value => typeof value === 'string' ? value.replace(/[\r\n`]+/g, ' ').trim().slice(0, 120) : '';

function label(candidate) {
  const model = clean(candidate?.model);
  if (!model) return '';
  const provider = clean(candidate?.providerName);
  return provider ? `\`${model}\` (${provider})` : `\`${model}\``;
}

function resolveProfile(config, profileId) {
  const profile = config.profiles?.find(item => item.id === profileId);
  const provider = profile && config.providers?.find(item => item.id === profile.providerId);
  return profile ? { model: profile.model, providerName: provider?.name } : null;
}

const unique = values => [...new Set(values.filter(Boolean))];

/** Credential-free summary of the configured chat models, from the object returned by loadModelConfig(). */
export function summarizeConfiguredModels(model) {
  if (!model || typeof model !== 'object') return null;
  const routing = model.modelRouting;
  if (!routing) {
    const primary = label({ model: model.model });
    return primary ? { primary, fallbacks: [], botRoutes: [], adaptive: [] } : null;
  }
  const route = item => label(resolveProfile(routing, item?.profileId));
  const primary = label({ model: model.model, providerName: resolveProfile(routing, routing.defaultRoute?.profileId)?.providerName })
    || route(routing.defaultRoute);
  if (!primary) return null;
  const fallbacks = unique((routing.defaultRoute?.fallbacks ?? []).map(route));
  const botRoutes = unique(Object.values(routing.botRoutes ?? {}).map(route)).filter(item => item !== primary);
  const adaptive = routing.adaptiveRouting?.enabled
    ? unique(Object.values(routing.adaptiveRouting.tiers ?? {}).map(route)) : [];
  return { primary, fallbacks, botRoutes, adaptive };
}

/** Text appended to the user-facing base prompt; null when no model is known. */
export function modelIdentityDirective(model) {
  const summary = summarizeConfiguredModels(model);
  if (!summary) return null;
  const lines = [`Model configuration for this RokBot deployment: the default chat model is ${summary.primary}.`];
  if (summary.fallbacks.length) lines.push(`If it is unavailable, requests fall back to ${summary.fallbacks.join(', ')}.`);
  if (summary.adaptive.length) lines.push(`Adaptive routing is on, so a turn may instead use one of ${summary.adaptive.join(', ')} depending on difficulty.`);
  if (summary.botRoutes.length) lines.push(`Some bots have their own route using ${summary.botRoutes.join(', ')}; if you are not sure which applies to you, say so.`);
  lines.push(`When asked which model you are, report this configuration. Users can confirm it in ${MODEL_SETTINGS_LOCATION}.`);
  return lines.join(' ');
}
