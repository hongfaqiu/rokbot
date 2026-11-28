import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_APPROVAL_NOTE, captureGroupSend, createPostingOrder, groupApprovalNotice, installLocalGroupTurns,
  runLocalGroupMemberTurn,
} from '../runtime/local-group-turns.mjs';

// Seed-free checks of local group member turns. The real-kernel end-to-end checks are in
// local-group-chat-e2e.test.mjs (ROKBOT_TEST_HOST_SEED).

test('captureGroupSend: room text and attachments go to the room; "to":"dm" and every card go to the 1:1 chat', () => {
  assert.deepEqual(captureGroupSend({ message: { type: 'text', content: 'hi' } }), { route: 'room' });
  assert.deepEqual(captureGroupSend({ message: { type: 'attachment', url: 'u' } }), { route: 'room' });
  assert.deepEqual(captureGroupSend({ message: { type: 'text', content: 'psst' }, deliverTo: 'dm' }), { route: 'direct', approval: false });
  for (const type of ['auto-review-approval', 'local-tool-permission', 'permission-request', 'user-form', 'publish-approval', 'widget']) {
    assert.deepEqual(captureGroupSend({ message: { type } }), { route: 'direct', approval: true }, type);
  }
  assert.deepEqual(captureGroupSend({ message: { type: 'text', content: 'x', channel: 'slack:C1' } }), { route: 'direct', approval: true },
    'a channel send is not a room post');
});

test('groupApprovalNotice is plain text that names the 1:1 chat and carries no approval object', () => {
  const notice = groupApprovalNotice({ name: 'alpha' }, { type: 'auto-review-approval', approval: { summary: 'Merge PR 19', requestId: 'secret-id' } });
  assert.equal(notice.type, 'text');
  assert.match(notice.content, /Waiting for approval: Merge PR 19/);
  assert.match(notice.content, /alpha .*1:1 chat/);
  assert.doesNotMatch(JSON.stringify(notice), /secret-id/);
  assert.equal(notice.approval, undefined);
});

test('createPostingOrder releases results in dispatch order', async () => {
  const order = createPostingOrder();
  const a = order.enter('room');
  const b = order.enter('room');
  const other = order.enter('other-room');
  const seen = [];
  const pb = b.waitForEarlier().then(() => seen.push('b'));
  await other.waitForEarlier();
  seen.push('other');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ['other'], 'b waits for a; other rooms do not');
  a.release();
  await pb;
  assert.deepEqual(seen, ['other', 'b']);
  b.release();
  other.release();
  assert.equal(order.pending('room'), 0);
});

function fakeGlue() {
  const glue = {
    posted: [], outcomes: [], working: [], errors: [],
    reportMemberTurnOutcome: (_room, memberId, outcome) => glue.outcomes.push([memberId, outcome]),
    setTemporalMemberWorking: (_room, memberId, on) => glue.working.push([memberId, on]),
    postGroupMemberMessage: (_room, member, message) => glue.posted.push([member.id, message]),
    surfaceGroupMemberTurnError: (_room, error) => glue.errors.push(error.message),
  };
  return glue;
}
const room = { id: 'room-1' };
const request = (id, extra = {}) => ({ member: { id, name: id }, prompt: `[Group chat: "g"] hi ${id}`, ...extra });

test('runLocalGroupMemberTurn: replies become posts, a member that sends nothing passes, the prompt says room lines are not approvals', async () => {
  const glue = fakeGlue();
  const order = createPostingOrder();
  const prompts = [];
  const runMember = async (memberId, prompt, capture) => {
    prompts.push(prompt);
    if (memberId === 'alpha') capture.onRoomPost({ type: 'text', content: 'REPLY_ALPHA' });
    return { result: { text: 'Done.' }, cancelled: false };
  };
  const a = await runLocalGroupMemberTurn(glue, room, request('alpha', { hiddenPrompt: 'form answered' }), () => true, { runMember, order });
  const b = await runLocalGroupMemberTurn(glue, room, request('beta'), () => true, { runMember, order });
  assert.deepEqual(a, { kind: 'shown', posts: [{ type: 'text', content: 'REPLY_ALPHA' }] });
  assert.deepEqual(b, { kind: 'shown', posts: [] }, 'silence is a pass: shown with nothing to post');
  assert.deepEqual(glue.outcomes, [['alpha', 'delivered'], ['beta', 'pass']]);
  assert.ok(prompts[0].includes('hi alpha') && prompts[0].includes('form answered') && prompts[0].includes(GROUP_APPROVAL_NOTE));
  assert.deepEqual(glue.working, [['alpha', true], ['alpha', false], ['beta', true], ['beta', false]]);
});

test('runLocalGroupMemberTurn: a faster later member still settles after an earlier one; a member waiting on approval does not hold others back', async () => {
  const glue = fakeGlue();
  const order = createPostingOrder();
  let approve;
  const approved = new Promise((r) => { approve = r; });
  const runMember = async (memberId, _prompt, capture) => {
    if (memberId === 'slow') await new Promise((r) => setTimeout(r, 30));
    if (memberId === 'waits') {
      capture.onApproval({ type: 'auto-review-approval', approval: { summary: 'Restart the Host' } });
      await approved;
    }
    capture.onRoomPost({ type: 'text', content: `REPLY_${memberId}` });
    return { result: {}, cancelled: false };
  };
  const settled = [];
  const run = (id) => runLocalGroupMemberTurn(glue, room, request(id), () => true, { runMember, order })
    .then((outcome) => settled.push([id, outcome.posts.map((post) => post.content)]));
  const all = [run('slow'), run('fast'), run('waits'), run('last')];
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(settled, [['slow', ['REPLY_slow']], ['fast', ['REPLY_fast']], ['last', ['REPLY_last']]],
    'member order is kept, and the member waiting for approval stepped aside');
  assert.deepEqual(glue.posted.map(([id, message]) => [id, message.type]), [['waits', 'text']], 'the room only got a text notice');
  assert.match(glue.posted[0][1].content, /Restart the Host/);
  approve();
  await Promise.all(all);
  assert.deepEqual(settled.at(-1), ['waits', ['REPLY_waits']]);
});

test('runLocalGroupMemberTurn: a stale room turn runs nothing; an interrupted member stops; a failing member is reported', async () => {
  const glue = fakeGlue();
  const order = createPostingOrder();
  let ran = 0;
  const stale = await runLocalGroupMemberTurn(glue, room, request('a'), () => false, { order, runMember: async () => { ran++; return {}; } });
  assert.deepEqual(stale, { kind: 'not_shown' });
  assert.equal(ran, 0);
  const stopped = await runLocalGroupMemberTurn(glue, room, request('b'), () => true, { order, runMember: async () => ({ result: { aborted: true } }) });
  assert.deepEqual(stopped, { kind: 'stopped' });
  const failed = await runLocalGroupMemberTurn(glue, room, request('c'), () => true, { order, runMember: async () => { throw new Error('model down'); } });
  assert.deepEqual(failed, { kind: 'not_shown' });
  assert.deepEqual(glue.errors, ['model down']);
  assert.deepEqual(glue.outcomes.map(([, outcome]) => outcome), ['cancelled', 'cancelled', 'error']);
});

test('installLocalGroupTurns runs local members and leaves server-hosted ones to the kernel, once', async () => {
  const calls = [];
  class GroupChatGlue {
    constructor() { this.tm = { id: 'tm' }; }
    memberKindOf(id) { return id === 'remote' ? 'temporal' : 'local'; }
    async runGroupMemberTurn(_room, req) { calls.push(['kernel', req.member.id]); return { kind: 'not_shown' }; }
  }
  const runMember = async (tm, memberId, _prompt, capture) => {
    calls.push(['local', memberId, tm.id]);
    capture.onRoomPost({ type: 'text', content: 'hi' });
    return { result: {} };
  };
  assert.equal(installLocalGroupTurns(GroupChatGlue, { runMember }), true);
  assert.equal(installLocalGroupTurns(GroupChatGlue, { runMember }), false, 'idempotent');
  const glue = new GroupChatGlue();
  assert.deepEqual(await glue.runGroupMemberTurn(room, request('box'), () => true), { kind: 'shown', posts: [{ type: 'text', content: 'hi' }] });
  assert.deepEqual(await glue.runGroupMemberTurn(room, request('remote'), () => true), { kind: 'not_shown' });
  assert.deepEqual(calls, [['local', 'box', 'tm'], ['kernel', 'remote']]);
});
