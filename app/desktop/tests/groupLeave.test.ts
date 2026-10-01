import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { leaveGroupAsSelf } from '../src/app/groupSelfLeave';
import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { SendCloudGroupControlInput } from '../src/features/cloud/cloudGroupControl.types';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import {
  chooseLeaveSuccessor,
  LEAVE_GROUP_ERROR,
  LEAVE_GROUP_UNAVAILABLE,
  leaveGroupPrompt,
  memberCanBeRemoved,
  runGroupLeave,
  selfLeaveMode,
} from '../src/features/safety/groupLeave';
import type { CanonicalSessionState } from '../src/kordi-app/types';

function recordingSteps(overrides: {
  envelope?: () => Promise<unknown>;
  leave?: () => Promise<unknown>;
  isOwner?: boolean;
} = {}) {
  const order: string[] = [];
  return {
    order,
    steps: {
      isOwner: overrides.isOwner ?? false,
      sendLeaveEnvelopes: async () => { order.push('envelope'); return overrides.envelope?.(); },
      leaveOnServer: async () => { order.push('leave'); return overrides.leave?.(); },
      removeLocally: async () => { order.push('local'); },
    },
  };
}

test('a leave tells the group, then the server, then this device', async () => {
  const { order, steps } = recordingSteps();
  assert.equal(await runGroupLeave(steps), 'left');
  assert.deepEqual(order, ['envelope', 'leave', 'local']);
});

test('a connection problem while telling the group stops the leave', async () => {
  for (const failure of [new CloudAuthError('network_error', 'offline', 0), new CloudAuthError('server_error', 'down', 503)]) {
    const { order, steps } = recordingSteps({ envelope: () => Promise.reject(failure) });
    await assert.rejects(runGroupLeave(steps), { message: LEAVE_GROUP_ERROR });
    assert.deepEqual(order, ['envelope']);
  }
});

test('a refused envelope does not stop the leave', async () => {
  const { order, steps } = recordingSteps({
    envelope: () => Promise.reject(new CloudAuthError('CHAT_RELATIONSHIP_REQUIRED', 'contacts only', 403)),
  });
  assert.equal(await runGroupLeave(steps), 'left');
  assert.deepEqual(order, ['envelope', 'leave', 'local']);
});

test('a server without the leave route falls back to the envelope-only leave', async () => {
  const missing = () => Promise.reject(buildCloudAuthError(404, null, 'missing'));
  const member = recordingSteps({ leave: missing });
  assert.equal(await runGroupLeave(member.steps), 'envelope-only');
  assert.deepEqual(member.order, ['envelope', 'leave', 'local']);

  const owner = recordingSteps({ leave: missing, isOwner: true });
  await assert.rejects(runGroupLeave(owner.steps), { message: LEAVE_GROUP_UNAVAILABLE });
  assert.deepEqual(owner.order, ['envelope', 'leave'], 'an owner never leaves without a successor');
});

test('a failed server leave keeps the group on this device', async () => {
  const failed = recordingSteps({ leave: () => Promise.reject(new CloudAuthError('network_error', 'offline', 0)) });
  await assert.rejects(runGroupLeave(failed.steps), { message: LEAVE_GROUP_ERROR });
  assert.deepEqual(failed.order, ['envelope', 'leave']);

  const gone = recordingSteps({ leave: () => Promise.reject(buildCloudAuthError(404, { error: { code: 'CHAT_ENTITY_NOT_FOUND', message: 'gone' } }, 'x')) });
  assert.equal(await runGroupLeave(gone.steps), 'left');
  assert.deepEqual(gone.order, ['envelope', 'leave', 'local']);
});

test('the creator can leave only when the server hands the group on', () => {
  const base = { isSelf: true, isCreator: true, admin: true, canManageMembers: true };
  assert.equal(memberCanBeRemoved({ ...base, safetyFeaturesAvailable: false }), false);
  assert.equal(memberCanBeRemoved({ ...base, safetyFeaturesAvailable: true }), true);
  assert.equal(memberCanBeRemoved({ isSelf: true, isCreator: false, admin: false, canManageMembers: false, safetyFeaturesAvailable: false }), true);
  assert.equal(memberCanBeRemoved({ isSelf: false, isCreator: false, admin: false, canManageMembers: true, safetyFeaturesAvailable: true }), true);
  assert.equal(memberCanBeRemoved({ isSelf: false, isCreator: false, admin: true, canManageMembers: true, safetyFeaturesAvailable: true }), false);
  assert.equal(memberCanBeRemoved({ isSelf: false, isCreator: true, admin: true, canManageMembers: true, safetyFeaturesAvailable: true }), false);
});

test('the leave prompt explains channels, devices, rejoining, and ownership', () => {
  assert.equal(
    leaveGroupPrompt('Design', false),
    "Leave Design? You'll stop getting messages from this group and all of its channels, and it will be removed from your devices. To come back, you'll need an invite link from someone in the group.",
  );
  assert.match(leaveGroupPrompt('Design', true), /You're the group owner, so another member will become the owner\.$/);
  assert.match(leaveGroupPrompt('Design', true, 'Bea'), /so Bea will become the owner\.$/);
});

test('a leaving owner hands the group to an admin, else the earliest-joined member', () => {
  const candidates = [
    { identityId: 'human:c', accountId: 'acct_c', name: 'Cy' },
    { identityId: 'human:b', accountId: 'acct_b', name: 'Bea' },
  ];
  assert.equal(chooseLeaveSuccessor({ candidates, adminIdentityIds: ['human:me', 'human:b'] })?.accountId, 'acct_b');
  assert.equal(chooseLeaveSuccessor({
    candidates,
    adminIdentityIds: ['human:me'],
    serverMembers: [
      { account_id: 'acct_me', membership_state: 'active', joined_at: '2026-01-01T00:00:00Z' },
      { account_id: 'acct_b', membership_state: 'active', joined_at: '2026-03-01T00:00:00Z' },
      { account_id: 'acct_c', membership_state: 'active', joined_at: '2026-02-01T00:00:00Z' },
      { account_id: 'acct_old', membership_state: 'left', joined_at: '2025-01-01T00:00:00Z' },
    ],
  })?.accountId, 'acct_c');
  assert.equal(chooseLeaveSuccessor({ candidates: [], adminIdentityIds: [] }), null);
});

function groupState(): CanonicalSessionState {
  const identity = (id: string, accountId: string, name: string, source = 'cloud') => ({
    id, kind: 'human', displayName: name, source, humanId: accountId, sourceIdentityId: accountId,
    avatarKey: id, createdAtMs: 1, updatedAtMs: 1,
  });
  const session = (id: string) => ({
    id, kind: 'group', title: 'Design', status: 'active', createdByIdentityId: 'human:me',
    metadata: { groupSpaceId: 'session:group:root', groupCreatorIdentityId: 'human:me', adminIdentityIds: ['human:me'] },
    createdAtMs: 1, updatedAtMs: 1,
  });
  const member = (sessionId: string, identityId: string) => ({ sessionId, identityId, role: identityId === 'human:me' ? 'self' : 'person', state: 'active', addedAtMs: 1 });
  return {
    storagePath: '/tmp/canonical',
    profile: { id: 'profile', humanIdentityId: 'human:me', storageRoot: '/tmp/canonical', createdAtMs: 1, updatedAtMs: 1 },
    identities: [identity('human:me', 'acct_me', 'Me', 'local'), identity('human:b', 'acct_b', 'Bea'), identity('human:c', 'acct_c', 'Cy')],
    sessions: [session('session:group:root'), session('session:group:channel')],
    participants: ['session:group:root', 'session:group:channel'].flatMap((sessionId) => (
      ['human:me', 'human:b', 'human:c'].map((identityId) => member(sessionId, identityId))
    )),
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as CanonicalSessionState;
}

test('an owner leaving a group tells every channel, names a successor, and leaves the whole group once', async () => {
  const rootConversationId = '00000000-0000-4000-8000-0000000000aa';
  const order: string[] = [];
  const envelopes: SendCloudGroupControlInput[] = [];
  const leaveBodies: unknown[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: { request: { sessionId: string } }) => {
      // The chat bootstrap also loads locally deleted message ids.
      if (command !== 'desktop_canonical_remove_session_participant') return [];
      order.push(`local:${args.request.sessionId}`);
      return groupState();
    } },
  } });
  __setSessionBackendForTests({ load: async () => ({ token: 'tok', accountId: 'acct_me', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/chat/sync/bootstrap')) {
        return Response.json({
          protocol_version: 2,
          latest_messages: [],
          conversations: [{
            id: rootConversationId, kind: 'group', shared_title: 'Design', version: 3, created_by_account_id: 'acct_me',
            legacy_session_id: 'session:group:root', latest_message_sequence: 4, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
            members: [
              { account_id: 'acct_me', role: 'owner', membership_state: 'active', joined_at: '2026-01-01T00:00:00Z', version: 1, last_delivered_sequence: 0, last_read_sequence: 0 },
              { account_id: 'acct_b', role: 'member', membership_state: 'active', joined_at: '2026-03-01T00:00:00Z', version: 1, last_delivered_sequence: 0, last_read_sequence: 0 },
              { account_id: 'acct_c', role: 'member', membership_state: 'active', joined_at: '2026-02-01T00:00:00Z', version: 1, last_delivered_sequence: 0, last_read_sequence: 0 },
            ],
            preferences: { account_id: 'acct_me', version: 1, personal_title: null },
          }],
        });
      }
      order.push(`server:${url.replace('http://srv', '')}`);
      leaveBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ left_conversation_ids: [rootConversationId], successor_account_id: 'acct_c' });
    },
  });
  const account = { accountId: 'acct_me', kordiId: '482731906', displayName: 'Me', primaryEmail: null, avatarUrl: null,
    avatar: { entityType: 'human', entityId: 'acct_me', source: 'generated', style: 'lorelei', seed: 'me', rendererVersion: 'r', uploadedAsset: null, version: 1, updatedAt: '2026-01-01T00:00:00Z' },
    nodeId: null, passwordSet: true } as const;
  let published: CanonicalSessionState | null = null;
  try {
    const outcome = await leaveGroupAsSelf({
      account,
      state: groupState(),
      actorIdentityId: 'human:me',
      groupContextSessionIds: ['session:group:root', 'session:group:channel'],
      groupSessionIds: ['session:group:root', 'session:group:channel'],
      rootSessionId: 'session:group:root',
      fallbackGroupSpaceId: 'session:group:root',
      groupCreatorIdentityId: 'human:me',
      createdByAccountId: 'acct_me',
      targetAccountIds: ['acct_b', 'acct_c'],
      sendCloudGroupControl: async (input) => { order.push(`envelope:${input.groupId}`); envelopes.push(input); },
      setCanonicalState: (state) => { published = state; },
      client,
    });

    assert.equal(outcome, 'left');
    assert.deepEqual(order, [
      'envelope:session:group:root',
      'envelope:session:group:channel',
      `server:/v2/chat/conversations/${rootConversationId}/leave`,
      'local:session:group:root',
      'local:session:group:channel',
    ]);
    for (const envelope of envelopes) {
      assert.equal(envelope.kind, 'group-update');
      assert.deepEqual(envelope.memberLeaves?.map((leave) => leave.accountId), ['acct_me']);
      assert.ok(!envelope.participants?.some((participant) => participant.accountId === 'acct_me'), 'the leaver is not listed');
      assert.equal(envelope.participants?.find((participant) => participant.accountId === 'acct_c')?.role, 'admin', 'the successor is listed as admin');
      assert.equal(envelope.participants?.find((participant) => participant.accountId === 'acct_b')?.role, 'person');
    }
    assert.equal(leaveBodies.length, 1, 'the server leave runs once, on the main conversation');
    assert.equal((leaveBodies[0] as { successor_account_id: string }).successor_account_id, 'acct_c');
    assert.ok(published, 'this device applies the removal');
  } finally {
    __setSessionBackendForTests(null);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('leaving tries the server unless it is known to lack the leave, and the creator needs confirmed support', () => {
  const confirmed = { loaded: true, available: true };
  const olderServer = { loaded: true, available: false };
  const notLoadedYet = { loaded: false, available: true };
  assert.equal(selfLeaveMode({ isCreator: false, serverSupport: confirmed }), 'server');
  assert.equal(selfLeaveMode({ isCreator: false, serverSupport: notLoadedYet }), 'server', 'a failed block list load still leaves on the server');
  assert.equal(selfLeaveMode({ isCreator: false, serverSupport: olderServer }), 'envelope-only');
  assert.equal(selfLeaveMode({ isCreator: false, serverSupport: null }), 'envelope-only');
  assert.equal(selfLeaveMode({ isCreator: true, serverSupport: confirmed }), 'server');
  assert.equal(selfLeaveMode({ isCreator: true, serverSupport: notLoadedYet }), 'unavailable');
  assert.equal(selfLeaveMode({ isCreator: true, serverSupport: olderServer }), 'unavailable');
  assert.equal(selfLeaveMode({ isCreator: true, serverSupport: null }), 'unavailable');
});

test('the group member hook leaves through the server only when it is supported', () => {
  const source = readFileSync(new URL('../src/app/useKordiGroupMemberRoles.ts', import.meta.url), 'utf8');
  assert.match(source, /serverSupport: account \? cloudBlocksSnapshot\(account\.accountId\) : null/);
  assert.match(source, /if \(leaveMode === 'server' && account\)/);
  assert.match(source, /if \(leaveMode === 'unavailable'\) throw new Error\(LEAVE_GROUP_UNAVAILABLE\)/);
  const dialog = readFileSync(new URL('../src/pages/GroupDetailsDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /memberCanBeRemoved\(\{ isSelf, isCreator, admin, canManageMembers, safetyFeaturesAvailable \}\)/);
  assert.match(dialog, /leaveGroupPrompt\(space\.title, isCreator\)/);
});
