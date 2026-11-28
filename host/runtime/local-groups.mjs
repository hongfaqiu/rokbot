// Local group chats for the 2bb5e41 Host.
//
// The shipped gateway (createHostGatewayApi) wraps its API with the server-agent proxy, and that
// wrapper sends every `createGroup` to the official server (`proxy.createRoom`). The local
// workspace has no official account, so the room call fails with "Official account
// authentication is unavailable in the local workspace runtime" and no group can be created.
// The local implementation is already in the kernel (TranscriptManager.createGroup ->
// GroupChatGlue: group dir + group config + roster event); only the proxy wrapper hides it.
// `setGroupMembers` already falls back to the local manager for non-server agents.
//
// This restores the unwrapped local `createGroup` on every gateway API the Host hands out.

const INSTALLED = Symbol.for('rokbot.localGroups.installed');
const NONCE_CAP = 64;

/** The gateway API with `createGroup` answered by the local transcript manager. */
export function withLocalGroups(api, manager, nonces = new Map()) {
  if (api == null || typeof manager?.createGroup !== 'function') return api;
  const create = args => manager.createGroup({
    name: args.name,
    description: args.description,
    memberIds: args.memberAgentIds ?? [],
    ...(args.namedBy === undefined ? {} : { namedBy: args.namedBy }),
  });
  return {
    ...api,
    createGroup: async (args = {}) => {
      // Only Bots can be members locally; humanMemberUserIds and a temporal route need the server.
      const nonce = typeof args.clientNonce === 'string' && args.clientNonce ? args.clientNonce : null;
      if (nonce === null) return create(args);
      // A retried request (same nonce) answers with the group made the first time.
      if (!nonces.has(nonce)) {
        const pending = create(args);
        nonces.set(nonce, pending);
        pending.catch(() => nonces.delete(nonce));
        while (nonces.size > NONCE_CAP) nonces.delete(nonces.keys().next().value);
      }
      return nonces.get(nonce);
    },
  };
}

/** Patch `SandHost#getApi` so every API (gateway server, tests, internal callers) creates groups locally. */
export function installLocalGroups(library) {
  const proto = library?.SandHost?.prototype;
  if (!proto || typeof proto.getApi !== 'function' || proto[INSTALLED]) return;
  const original = proto.getApi;
  const noncesByHost = new WeakMap();
  proto.getApi = function getApiWithLocalGroups(...args) {
    if (!noncesByHost.has(this)) noncesByHost.set(this, new Map());
    return withLocalGroups(original.apply(this, args), this.transcript, noncesByHost.get(this));
  };
  Object.defineProperty(proto, INSTALLED, { value: true });
}
