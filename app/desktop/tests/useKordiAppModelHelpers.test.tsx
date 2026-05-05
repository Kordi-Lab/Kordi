import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalGroupInviteContextForSession,
  canonicalGroupInviteTitleForSession,
  canonicalSessionMessagesForGroupInvite,
  currentMentionQuery,
  filterMentionTargets,
  groupRenameMetadata,
  removeSessionFromCanonicalState,
} from '../src/app/useKordiAppModelHelpers';
import type { CanonicalSessionState } from '../src/kordi-app/types';

test('mention helper hides suggestions after an exact mention followed by whitespace', () => {
  const query = currentMentionQuery('@Kordi ');
  const options = [{
    value: 'Kordi',
    label: 'Kordi',
    detail: 'Local agent',
    nodeId: 'agent-local',
    runtime: 'local',
  }];

  assert.deepEqual(filterMentionTargets(options, query), []);
});

test('canonical session removal prunes session-scoped records', () => {
  const state = {
    sessions: [{ id: 'keep' }, { id: 'drop' }],
    participants: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    messages: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    delegatedExchanges: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    presence: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    contextSnapshots: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
  } as CanonicalSessionState;

  const next = removeSessionFromCanonicalState(state, 'drop')!;

  assert.deepEqual(next.sessions.map((session) => session.id), ['keep']);
  assert.deepEqual(next.messages.map((message) => message.sessionId), ['keep']);
  assert.deepEqual(next.participants.map((participant) => participant.sessionId), ['keep']);
});

test('group rename metadata changes the group name without overwriting manual session-title metadata', () => {
  assert.deepEqual(
    groupRenameMetadata({
      customName: 'Old group',
      groupSpaceId: 'session:group:root',
      titleSource: 'manual',
      sessionTitleSource: 'manual',
      extra: 'kept',
    }, 'New group', 'session:group:root'),
    {
      customName: 'New group',
      groupId: 'session:group:root',
      groupSpaceId: 'session:group:root',
      titleSource: 'manual',
      sessionTitleSource: 'manual',
      extra: 'kept',
    },
  );
});

test('group invite title falls back to the group space custom name for child sessions', () => {
  const state = {
    sessions: [
      {
        id: 'session:group:root',
        title: 'thefirsttestgroup',
        metadata: { customName: 'thefirsttestgroup', groupSpaceId: 'session:group:root' },
      },
      {
        id: 'session:group:child',
        title: 'Group',
        metadata: { groupSpaceId: 'session:group:root' },
      },
    ],
  } as CanonicalSessionState;

  assert.equal(canonicalGroupInviteTitleForSession(state, 'session:group:child'), 'thefirsttestgroup');
});

test('group invite context carries the child session title fallback, participants, and history', () => {
  const state = {
    profile: { humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Testuser2', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'kd_me', humanId: 'kh_me', avatarKey: 'me' },
      { id: 'human:jiaxin', kind: 'human', displayName: 'Jiaxin', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'kd_jiaxin', humanId: 'kh_jiaxin', avatarKey: 'jiaxin' },
    ],
    sessions: [
      {
        id: 'session:group:root',
        title: 'thefirsttestgroup',
        metadata: { customName: 'thefirsttestgroup', groupSpaceId: 'session:group:root', adminIdentityIds: ['human:me'] },
      },
      {
        id: 'session:group:child',
        title: 'Group',
        metadata: { groupSpaceId: 'session:group:root', adminIdentityIds: ['human:me'] },
      },
    ],
    participants: [
      { sessionId: 'session:group:child', identityId: 'human:me', role: 'admin', state: 'active' },
      { sessionId: 'session:group:child', identityId: 'human:jiaxin', role: 'person', state: 'active' },
    ],
    messages: [
      {
        id: 'msg:1',
        sessionId: 'session:group:child',
        senderIdentityId: 'human:me',
        senderRole: 'user',
        messageKind: 'text',
        contentText: 'Earlier question',
        content: { sender: 'Testuser2', timeLabel: '13:04' },
        sequenceNum: 1,
        createdAtMs: 1_000,
      },
    ],
  } as CanonicalSessionState;

  assert.deepEqual(canonicalGroupInviteContextForSession(state, 'session:group:child', 'session:group:child'), {
    parentSessionTitle: 'thefirsttestgroup',
    parentGroupSpaceId: 'session:group:root',
    parentSessionParticipants: [
      { identityId: 'human:me', displayName: 'Testuser2', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null },
      { identityId: 'human:jiaxin', displayName: 'Jiaxin', role: 'person', bridgeNodeId: 'kd_jiaxin', humanId: 'kh_jiaxin', agentId: null },
    ],
    parentSessionMessages: [
      { role: 'user', sender: 'Testuser2', text: 'Earlier question', timeLabel: '13:04', index: 0 },
    ],
  });
});

test('group invite snapshots carry existing session messages with sender labels', () => {
  const state = {
    profile: { humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', displayName: 'Testuser2' },
      { id: 'human:jiaxin', displayName: 'Jiaxin' },
      { id: 'agent:kordi', displayName: 'Kordi' },
    ],
    sessions: [{ id: 'session:group:child', title: 'Group', metadata: {} }],
    messages: [
      {
        id: 'msg:2',
        sessionId: 'session:group:child',
        senderIdentityId: 'human:jiaxin',
        senderRole: 'person',
        messageKind: 'text',
        contentText: 'Earlier reply',
        content: { timeLabel: '13:05' },
        sequenceNum: 2,
        createdAtMs: 2_000,
      },
      {
        id: 'msg:empty',
        sessionId: 'session:group:child',
        senderIdentityId: 'human:me',
        senderRole: 'user',
        messageKind: 'text',
        contentText: '   ',
        sequenceNum: 3,
        createdAtMs: 3_000,
      },
      {
        id: 'msg:1',
        sessionId: 'session:group:child',
        senderIdentityId: 'human:me',
        senderRole: 'user',
        messageKind: 'text',
        contentText: 'Earlier question',
        content: { sender: 'Testuser2', timeLabel: '13:04' },
        sequenceNum: 1,
        createdAtMs: 1_000,
      },
      {
        id: 'msg:agent',
        sessionId: 'session:other',
        senderIdentityId: 'agent:kordi',
        senderRole: 'owned-agent',
        messageKind: 'agent-turn',
        contentText: 'Not this session',
        sequenceNum: 1,
        createdAtMs: 1_500,
      },
    ],
  } as CanonicalSessionState;

  assert.deepEqual(canonicalSessionMessagesForGroupInvite(state, 'session:group:child'), [
    { role: 'user', sender: 'Testuser2', text: 'Earlier question', timeLabel: '13:04', index: 0 },
    { role: 'person', sender: 'Jiaxin', text: 'Earlier reply', timeLabel: '13:05', index: 1 },
  ]);
});
