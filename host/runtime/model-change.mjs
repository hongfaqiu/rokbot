// T-59 part 2: change this Bot's chat model route (primary profile and fallback chain) from the
// conversation. Design: docs/model-switch-from-chat.md.
//
// Two code-enforced gates:
//  1. ProposeModelChange only posts a confirmation card, and refuses unless the current run is a
//     visible, client-sent user turn whose typed text names every model it touches.
//  2. The change is applied only when the user submits that card through the kernel's
//     submitUserForm channel; the card carries a one-time Host nonce bound to the exact change.
// The store is the platform routing config (model.env ROKBOT_MODEL_ROUTING, written by Models.save
// exactly as the settings page does), never the Magpie gateway. Nothing here logs or returns API
// keys, base URLs or tokens: only profile ids, profile names and model ids.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { makeLocalHarnessTool } from './local-state-tools.mjs';
import { validateModelRouting } from './model-routing.mjs';

export const PROPOSE_MODEL_CHANGE_TOOL_NAME = 'ProposeModelChange';
export const MODEL_CHANGE_AUDIT_FILE = 'model-change-audit.jsonl';
export const MODEL_CHANGE_CONFIRM_FIELD = 'confirm';
const PROPOSAL_TTL_MS = 15 * 60_000;
const MAX_FALLBACKS = 8;

const clean = value => typeof value === 'string' ? value.replace(/[\r\n`]+/g, ' ').trim().slice(0, 120) : '';

// ---------------------------------------------------------------------------------------------
// Single source of truth for the configured route: the same config object createInference reads.

/** Wraps the runtime model config; createInference, CurrentModel and this module all read it. */
export function createLiveModelRouting(config) {
  return {
    routing: () => config?.modelRouting,
    summary: agentId => routeSummary(config?.modelRouting, agentId),
    replace(next) { if (config) config.modelRouting = next; },
  };
}

/** The route that serves this Bot's chat turns, and which slot of the config holds it. */
export function effectiveRoute(routing, agentId) {
  if (!routing) return undefined;
  const bot = agentId && routing.botRoutes?.[agentId];
  if (bot) return { scope: 'bot', route: bot };
  if (routing.defaultRoute) return { scope: 'default', route: routing.defaultRoute };
  return undefined;
}

const canonicalRoute = route => JSON.stringify({
  profileId: route?.profileId, effort: route?.effort ?? 'default',
  fallbacks: (route?.fallbacks ?? []).map(item => ({ profileId: item.profileId, effort: item.effort ?? 'default' })),
});

/** Whitelisted, credential-free copy of a route (profile ids and efforts only). */
const publicRoute = route => ({
  profileId: route.profileId, effort: route.effort ?? 'default',
  fallbacks: (route.fallbacks ?? []).map((item, order) => ({ profileId: item.profileId, effort: item.effort ?? 'default', order })),
});

function describeProfile(routing, profileId) {
  const profile = routing?.profiles?.find(item => item.id === profileId);
  const provider = profile && routing.providers?.find(item => item.id === profile.providerId);
  return { profileId, model: clean(profile?.model) || undefined, name: clean(profile?.name) || undefined,
    providerName: clean(provider?.name) || undefined };
}

/** Credential-free summary of the route this Bot's next turn will use. */
export function routeSummary(routing, agentId) {
  const found = effectiveRoute(routing, agentId);
  if (!found) return undefined;
  return { scope: found.scope, primary: describeProfile(routing, found.route.profileId),
    fallbacks: (found.route.fallbacks ?? []).map(item => describeProfile(routing, item.profileId)) };
}

const modelLabel = item => item?.model ? `\`${item.model}\`${item.providerName ? ` (${item.providerName})` : ''}` : `\`${item?.profileId}\``;
const plainLabel = item => item?.model ?? item?.profileId ?? '?';
const chainLabel = list => list.length ? list.map(plainLabel).join(' → ') : '无';

export function describeRouteSummary(summary) {
  if (!summary) return '';
  const fallbacks = summary.fallbacks.length ? summary.fallbacks.map(modelLabel).join(', ') : 'none';
  return `Configured route for this Bot's next turns (${summary.scope === 'bot' ? 'this Bot\'s own route' : 'the Host default route'}): `
    + `primary ${modelLabel(summary.primary)}; fallbacks in order: ${fallbacks}.`;
}

// ---------------------------------------------------------------------------------------------
// Gate 1: who started the current run.

/** Records each runner.run's origin so a tool call can check it in code. */
export function createTurnProvenance() {
  const storage = new AsyncLocalStorage();
  return {
    run: (provenance, fn) => storage.run(Object.freeze({ ...provenance }), fn),
    current: () => storage.getStore(),
  };
}

/**
 * The text the user typed for this run: the newest visible user message, only if a client sent it
 * (clients send `clientNonce`; Host-internal sendPrompt calls never do) and it is this run's prompt.
 */
export function userTypedTextForRun(entries, prompt) {
  if (typeof prompt !== 'string' || !Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind !== 'message' || entry.role !== 'user') continue;
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (typeof entry.clientNonce !== 'string' || !entry.clientNonce || !content) return null;
    return prompt.includes(content) ? content : null;
  }
  return null;
}

/** Why this run may not propose a model change, or undefined if it may. */
export function turnRefusal(provenance) {
  if (!provenance) return 'not inside a user turn';
  if (provenance.hidden) return 'this run is hidden (a wake, receipt or background run), not a message the user sent';
  if (provenance.requestSource !== 'turn') return `this run was started by "${provenance.requestSource ?? 'unknown'}", not by the user sending a message`;
  if (provenance.group) return 'group chats cannot change models';
  if (provenance.inAutomationRun) return 'automation runs cannot change models';
  if (!provenance.typedText) return 'the message for this run did not come from the user\'s client';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Planning a change.

class ModelChangeError extends Error {}
const refuse = message => { throw new ModelChangeError(message); };

function profileChoices(routing) {
  return (routing.profiles ?? []).map(item => `${item.id} (${clean(item.model)})`).join(', ');
}

/** Resolve a user's model reference to one configured profile. */
export function resolveProfile(routing, reference) {
  const ref = typeof reference === 'string' ? reference.trim().toLowerCase() : '';
  if (ref.length < 2) refuse('Each model must be named.');
  const profiles = routing.profiles ?? [];
  const keys = profile => [profile.id, profile.model, profile.name].map(value => String(value ?? '').toLowerCase());
  let matches = profiles.filter(profile => keys(profile).includes(ref));
  if (!matches.length) matches = profiles.filter(profile => keys(profile).some(value => value.includes(ref)));
  if (matches.length === 1) return matches[0];
  if (!matches.length) refuse(`No configured model matches "${clean(reference)}". Configured: ${profileChoices(routing)}. New providers or keys can only be added in the settings page.`);
  refuse(`"${clean(reference)}" matches several configured models: ${matches.map(item => `${item.id} (${clean(item.model)})`).join(', ')}. Ask the user which one.`);
}

const asList = value => value === undefined ? [] : (Array.isArray(value) ? value : [value]);

/**
 * Turn tool arguments into before/after routes. Every model reference must appear in the text the
 * user typed for this turn, so content the bot read elsewhere cannot pick the model.
 */
export function planModelChange(routing, agentId, args = {}, { typedText = '' } = {}) {
  if (!routing) refuse('The model routing configuration is unavailable.');
  if (routing.adaptiveRouting?.enabled) refuse('Adaptive routing is on, so the primary model is chosen per task. Change it in the settings page.');
  const found = effectiveRoute(routing, agentId);
  if (!found) refuse('No chat route is configured yet. Set one up in the settings page.');
  const typed = typedText.toLowerCase();
  const pick = reference => {
    if (typeof reference !== 'string' || !typed.includes(reference.trim().toLowerCase()))
      refuse(`The user's own message must name "${clean(String(reference ?? ''))}". Only models the user typed in this message can be changed; ask the user to say which model.`);
    return resolveProfile(routing, reference);
  };
  const before = publicRoute(found.route);
  const profiles = new Map((routing.profiles ?? []).map(item => [item.id, item]));
  let primaryId = before.profileId;
  let effort = before.effort;
  let chain = before.fallbacks.map(item => ({ profileId: item.profileId, effort: item.effort }));
  const touched = [];

  if (args.primary !== undefined) {
    const profile = pick(args.primary);
    touched.push(profile.id);
    if (profile.id !== primaryId) {
      primaryId = profile.id;
      if (effort !== 'default' && !(profile.efforts ?? []).includes(effort)) effort = 'default';
    }
  }
  if (args.fallbacks !== undefined) {
    chain = asList(args.fallbacks).map(reference => { const p = pick(reference); touched.push(p.id); return { profileId: p.id, effort: 'default' }; });
  }
  for (const reference of asList(args.removeFallbacks)) {
    const profile = pick(reference);
    touched.push(profile.id);
    if (!chain.some(item => item.profileId === profile.id)) refuse(`${clean(profile.model)} is not in the fallback chain.`);
    chain = chain.filter(item => item.profileId !== profile.id);
  }
  for (const reference of asList(args.addFallbacks)) {
    const profile = pick(reference);
    touched.push(profile.id);
    if (!chain.some(item => item.profileId === profile.id)) chain.push({ profileId: profile.id, effort: 'default' });
  }
  if (!touched.length) refuse('Say what to change: primary, addFallbacks, removeFallbacks or fallbacks.');
  const seen = new Set([primaryId]);
  chain = chain.filter(item => profiles.has(item.profileId) && !seen.has(item.profileId) && seen.add(item.profileId));
  if (chain.length > MAX_FALLBACKS) refuse(`At most ${MAX_FALLBACKS} fallback models are allowed.`);
  const after = publicRoute({ profileId: primaryId, effort, fallbacks: chain });
  if (canonicalRoute(after) === canonicalRoute(before)) refuse('That is already the current configuration; nothing to change.');
  return finishPlan(routing, agentId, found.scope, before, after, 'change');
}

function finishPlan(routing, agentId, scope, before, after, action) {
  const next = withRoute(routing, agentId, scope, after);
  try { validateModelRouting(next, { previous: routing }); }
  catch (error) { refuse(`The change is not valid: ${error.message}`); }
  return { action, scope, agentId, before, after,
    beforeSummary: summaryOfRoute(routing, before), afterSummary: summaryOfRoute(routing, after) };
}

function summaryOfRoute(routing, route) {
  return { primary: describeProfile(routing, route.profileId), fallbacks: route.fallbacks.map(item => describeProfile(routing, item.profileId)) };
}

function withRoute(routing, agentId, scope, route) {
  const next = structuredClone(routing);
  const value = { profileId: route.profileId, effort: route.effort, fallbacks: route.fallbacks.map((item, order) => ({ ...item, order })) };
  if (scope === 'bot') next.botRoutes = { ...(next.botRoutes ?? {}), [agentId]: value };
  else next.defaultRoute = value;
  return next;
}

// ---------------------------------------------------------------------------------------------
// Audit log (route objects and model names only).

async function readAudit(file) {
  const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

const scopeKey = (scope, agentId) => scope === 'bot' ? `bot:${agentId}` : 'default';

// ---------------------------------------------------------------------------------------------
// Gate 2: proposals, confirmation and apply.

/**
 * One controller per Host process. `openModels()` returns a Models instance (host/server/models.mjs)
 * for the model.env the runtime started with; apply goes through Models.save like the settings page.
 */
export function createModelChangeController({ dataDir, openModels, liveRouting, now = () => Date.now(), ttlMs = PROPOSAL_TTL_MS }) {
  const proposals = new Map();
  const auditFile = dataDir ? join(dataDir, MODEL_CHANGE_AUDIT_FILE) : '';
  let confirmationAvailable = false;

  async function storedRouting() {
    const models = openModels?.();
    if (!models) refuse('Model settings are not writable from this Host.');
    const current = await models.current();
    if (current.routingMigrated) refuse('This Host still uses the old single-model configuration. Change it in the settings page.');
    return { models, routing: current.routing };
  }

  return {
    get confirmationAvailable() { return confirmationAvailable; },
    markConfirmationChannel(available) { confirmationAvailable = Boolean(available); },
    owns: nonce => typeof nonce === 'string' && proposals.has(nonce),

    /** Plan from the persisted config (the same store the settings page edits). */
    async plan(agentId, args, { typedText }) {
      const { routing } = await storedRouting();
      if (args?.action === 'rollback') {
        const found = effectiveRoute(routing, agentId);
        if (!found) refuse('No chat route is configured.');
        const key = scopeKey(found.scope, agentId);
        const last = (await readAudit(auditFile)).filter(entry => entry.scopeKey === key).at(-1);
        if (!last) refuse('There is no earlier model change to roll back.');
        if (canonicalRoute(last.after.route) !== canonicalRoute(found.route))
          refuse('The configuration changed after the last chat change (for example in the settings page), so it cannot be rolled back from here.');
        return finishPlan(routing, agentId, found.scope, publicRoute(found.route), publicRoute(last.before.route), 'rollback');
      }
      return planModelChange(routing, agentId, args, { typedText });
    },

    /** Register a plan and return the card. The nonce is never shown to the model. */
    propose(plan) {
      if (!confirmationAvailable) refuse('The confirmation card channel is not available on this Host, so nothing can be changed from chat. Use the settings page.');
      for (const [nonce, item] of proposals) if (item.expiresAt <= now()) proposals.delete(nonce);
      const nonce = randomUUID();
      proposals.set(nonce, { ...plan, expiresAt: now() + ttlMs });
      return { nonce, formRequest: confirmationForm(plan) };
    },

    /** A submit or dismiss of our card. Returns the text the Host posts back into the chat. */
    async resolve({ nonce, agentId, values, dismissed = false }) {
      const proposal = proposals.get(nonce);
      proposals.delete(nonce); // one-time, whatever happens next
      if (!proposal) return { resolution: 'dismissed', message: '这张确认卡片已失效，没有修改任何模型设置。' };
      if (dismissed) return { resolution: 'dismissed', message: '已取消，模型设置没有改动。' };
      if (proposal.agentId !== agentId) return { resolution: 'dismissed', message: '确认来自另一个会话，没有修改任何模型设置。' };
      if (proposal.expiresAt <= now()) return { resolution: 'dismissed', message: '确认卡片已过期，没有修改任何模型设置。需要的话请重新说一次。' };
      const confirmed = String(values?.[MODEL_CHANGE_CONFIRM_FIELD] ?? '').trim().toLowerCase();
      if (!confirmed || ['false', '0', 'off', 'no'].includes(confirmed))
        return { resolution: 'dismissed', message: '没有勾选确认，模型设置没有改动。' };
      try {
        const { models, routing } = await storedRouting();
        const found = effectiveRoute(routing, agentId);
        if (!found || found.scope !== proposal.scope || canonicalRoute(found.route) !== canonicalRoute(proposal.before))
          return { resolution: 'dismissed', message: '模型配置在确认前已被修改（例如在设置页），这次改动没有应用。需要的话请重新说一次。' };
        await models.save(withRoute(routing, agentId, proposal.scope, proposal.after));
        const saved = (await models.current()).routing;
        liveRouting?.replace?.(saved);
        if (auditFile) {
          await mkdir(dirname(auditFile), { recursive: true, mode: 0o700 });
          await appendFile(auditFile, `${JSON.stringify({
            at: new Date(now()).toISOString(), action: proposal.action, agentId, scope: proposal.scope,
            scopeKey: scopeKey(proposal.scope, agentId),
            before: { route: publicRoute(proposal.before), ...proposal.beforeSummary },
            after: { route: publicRoute(proposal.after), ...proposal.afterSummary },
          })}\n`, { mode: 0o600 });
        }
        const verb = proposal.action === 'rollback' ? '已回滚' : '已修改';
        return { resolution: 'submitted', applied: true, message: `${verb}${scopeLabel(proposal.scope)}：主模型 ${plainLabel(proposal.beforeSummary.primary)} → ${plainLabel(proposal.afterSummary.primary)}；`
          + `备用 ${chainLabel(proposal.beforeSummary.fallbacks)} → ${chainLabel(proposal.afterSummary.fallbacks)}。从下一轮对话开始生效，这一轮不变。`
          + (proposal.action === 'rollback' ? '' : '想撤销的话，跟我说「回滚模型修改」。') };
      } catch (error) {
        const reason = error instanceof ModelChangeError ? error.message : '保存失败';
        return { resolution: 'dismissed', message: `模型设置没有改动：${reason}` };
      }
    },
  };
}

const scopeLabel = scope => scope === 'bot' ? '本 Bot 的对话模型' : 'Host 默认对话模型';

function confirmationForm(plan) {
  const { beforeSummary: b, afterSummary: a } = plan;
  return {
    title: plan.action === 'rollback' ? '确认回滚对话模型' : '确认修改对话模型',
    instruction: `${scopeLabel(plan.scope)}：主模型 ${plainLabel(b.primary)} → ${plainLabel(a.primary)}；备用 ${chainLabel(b.fallbacks)} → ${chainLabel(a.fallbacks)}。确认后从下一轮对话开始生效。`,
    reason: 'other',
    fields: [{ id: MODEL_CHANGE_CONFIRM_FIELD, label: '我确认这次修改', type: 'checkbox', required: true }],
  };
}

// ---------------------------------------------------------------------------------------------
// Wiring: the kernel's submitUserForm / dismissUserForm channel and the tool.

const CONFIRMATION_WRAPPED = Symbol('rokbot.modelChangeConfirmation');

/**
 * Intercept submit/dismiss of our own cards on the kernel's UserFormResponses. Returns false when
 * the channel is not there; the controller then refuses every proposal (safe degradation).
 * `locate(agentId, entryId)` → { session, entry } ; `settle(located, resolution, message)` stamps
 * the card and posts the Host's result message.
 */
export function installModelChangeConfirmation(tm, controller, { locate, settle }) {
  const responses = tm?.userFormResponses;
  if (!responses || typeof responses.submitUserForm !== 'function' || typeof responses.dismissUserForm !== 'function') {
    controller.markConfirmationChannel(false);
    return false;
  }
  if (!responses[CONFIRMATION_WRAPPED]) {
    const submit = responses.submitUserForm.bind(responses);
    const dismiss = responses.dismissUserForm.bind(responses);
    const ours = async args => {
      const located = await locate(args?.agentId, args?.entryId).catch(() => null);
      const entry = located?.entry;
      if (!entry || entry.kind !== 'send-message' || entry.message?.type !== 'user-form' || entry.formResolution != null) return null;
      return controller.owns(entry.formRequestId) ? located : null;
    };
    responses.submitUserForm = async args => {
      const located = await ours(args);
      if (!located) return submit(args);
      const outcome = await controller.resolve({ nonce: located.entry.formRequestId, agentId: args.agentId, values: args.values });
      await settle(located, outcome.resolution, outcome.message);
    };
    responses.dismissUserForm = async args => {
      const located = await ours(args);
      if (!located) return dismiss(args);
      const outcome = await controller.resolve({ nonce: located.entry.formRequestId, agentId: args.agentId, dismissed: true });
      await settle(located, 'dismissed', outcome.message);
    };
    responses[CONFIRMATION_WRAPPED] = true;
  }
  controller.markConfirmationChannel(true);
  return true;
}

const PROPOSE_DESCRIPTION = [
  'Propose a change to the chat models this Bot uses: switch the primary model, add or remove fallback models, replace the fallback chain, or roll back the last chat change.',
  'Use it only when the user asks for it in their own message. Pass model names exactly as the user wrote them; only models already configured on this Host can be chosen.',
  'This tool changes nothing by itself: it shows the user a confirmation card, and the Host applies the change only after the user confirms on that card, from the next turn on.',
  'Tell the user to confirm on the card; do not say the change is done.',
].join(' ');

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['change', 'rollback'], description: '"change" (default) or "rollback" to restore the route before the last chat change.' },
    primary: { type: 'string', description: 'New primary model, as the user named it.' },
    addFallbacks: { type: 'array', items: { type: 'string' }, description: 'Models to append to the fallback chain.' },
    removeFallbacks: { type: 'array', items: { type: 'string' }, description: 'Models to remove from the fallback chain.' },
    fallbacks: { type: 'array', items: { type: 'string' }, description: 'Replace the whole fallback chain with these models, in order.' },
  },
  additionalProperties: false,
};

/** `postCard(formRequest, nonce)` puts the card into this Bot's chat. */
export function createProposeModelChangeTool(library, { controller, provenance, agentId, postCard }) {
  return makeLocalHarnessTool(library, {
    name: PROPOSE_MODEL_CHANGE_TOOL_NAME,
    description: PROPOSE_DESCRIPTION,
    schema: PROPOSE_SCHEMA,
    run: async args => {
      const refusal = turnRefusal(provenance.current());
      if (refusal) return `Refused, nothing changed: ${refusal}. Model changes can only be requested by the user in a chat message, then confirmed on a card.`;
      try {
        if (!controller.confirmationAvailable) refuse('The confirmation card channel is not available on this Host, so nothing can be changed from chat. Use the settings page.');
        const plan = await controller.plan(agentId, args, { typedText: provenance.current().typedText });
        const { nonce, formRequest } = controller.propose(plan);
        await postCard(formRequest, nonce);
        return `A confirmation card is shown to the user: ${formRequest.instruction} Nothing is changed until the user confirms on the card; the Host then posts the result. Ask the user to confirm on the card.`;
      } catch (error) {
        if (error instanceof ModelChangeError) return `Refused, nothing changed: ${error.message}`;
        throw error;
      }
    },
  });
}
