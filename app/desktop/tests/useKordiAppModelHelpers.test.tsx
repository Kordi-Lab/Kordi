import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalGroupInviteContextForSession,
  canonicalGroupInviteTitleForSession,
  canonicalGroupSessionSyncContextForSession,
  canonicalLocalAgentAvatarSeed,
  canonicalSessionMessagesForGroupInvite,
  currentMentionQuery,
  filterMentionTargets,
  groupRenameMetadata,
  mergeCanonicalStatePreservingCollaborationUiMessages,
  removeSessionFromCanonicalState,
  sessionRenameNoticeText,
} from '../src/app/useKordiAppModelHelpers';
import type { CanonicalSessionState } from '../src/kordi-app/types';

test('default local agent avatar uses one cross-device identity seed', () => {
  const state = {
    profile: {
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local:123',
    },
    identities: [{
      id: 'agent:local:123',
      kind: 'agent',
      displayName: 'My Kordi',
      source: 'local',
      ownerIdentityId: 'human:me',
      agentId: 'local:123',
      avatarKey: 'agent:local:123',
    }],
  } as unknown as CanonicalSessionState;

  assert.equal(canonicalLocalAgentAvatarSeed(state), 'cloud-local-agent');
});

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

test('canonical refresh preserves in-flight bridge UI sends until they are persisted', () => {
  const fetched = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [],
  } as unknown as CanonicalSessionState;
  const current = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [{
      id: 'msg:ui:pending',
      sessionId: 'session:bridge:person',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'hello',
      content: { sender: 'Me', timeLabel: '22:20', deliveryState: 'sending' },
      status: 'sending',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      sourceTransport: 'desktop-bridge-ui',
    }],
  } as unknown as CanonicalSessionState;

  const next = mergeCanonicalStatePreservingCollaborationUiMessages(fetched, current)!;

  assert.deepEqual(next.messages.map((message) => message.id), ['msg:ui:pending']);
});

test('canonical refresh preserves optimistic local-agent contact messages until they are persisted', () => {
  const fetched = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [],
  } as unknown as CanonicalSessionState;
  const current = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [{
      id: 'msg:ui:local-agent-contact-send',
      sessionId: 'session:bridge:person',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@MyKordi what are you doing',
      content: { sender: 'Me', timeLabel: '14:12' },
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      sourceTransport: 'desktop-chat-ui',
    }],
  } as unknown as CanonicalSessionState;

  const next = mergeCanonicalStatePreservingCollaborationUiMessages(fetched, current)!;

  assert.deepEqual(next.messages.map((message) => message.id), ['msg:ui:local-agent-contact-send']);
});

test('canonical refresh preserves bridge relay messages when a fetched snapshot lags behind bridge sync', () => {
  const fetched = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [{
      id: 'msg:old',
      sessionId: 'session:bridge:person',
      senderIdentityId: 'human:peer',
      senderRole: 'person',
      messageKind: 'text',
      contentText: 'old message',
      content: { sender: 'Peer', timeLabel: '14:10' },
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      sourceTransport: 'desktop-bridge-parent',
      sourceEventId: 'old-source',
    }],
  } as unknown as CanonicalSessionState;
  const current = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [
      fetched.messages[0],
      {
        id: 'msg:relay:new-peer-request',
        sessionId: 'session:bridge:person',
        senderIdentityId: 'human:peer',
        senderRole: 'person',
        messageKind: 'text',
        contentText: '@PeerKordi what are you doing',
        content: { sender: 'Peer', timeLabel: '14:11', kind: 'session-relay' },
        status: 'sent',
        sequenceNum: 2,
        createdAtMs: 2,
        updatedAtMs: 2,
        sourceTransport: 'desktop-bridge-session-relay',
        sourceEventId: 'relay-source',
      },
    ],
  } as unknown as CanonicalSessionState;

  const next = mergeCanonicalStatePreservingCollaborationUiMessages(fetched, current)!;

  assert.deepEqual(next.messages.map((message) => message.id), ['msg:old', 'msg:relay:new-peer-request']);
});

test('canonical refresh does not duplicate preserved bridge messages already fetched under another id', () => {
  const fetched = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [{
      id: 'msg:canonical:new-peer-request',
      sessionId: 'session:bridge:person',
      senderIdentityId: 'human:peer',
      senderRole: 'person',
      messageKind: 'text',
      contentText: '@PeerKordi what are you doing',
      content: { sender: 'Peer', timeLabel: '14:11', kind: 'session-relay' },
      status: 'sent',
      sequenceNum: 2,
      createdAtMs: 2,
      updatedAtMs: 2,
      sourceTransport: 'desktop-bridge-session-relay',
      sourceEventId: 'relay-source:new',
    }],
  } as unknown as CanonicalSessionState;
  const current = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [
      fetched.messages[0],
      {
        id: 'msg:relay:old-duplicate-id',
        sessionId: 'session:bridge:person',
        senderIdentityId: 'human:peer',
        senderRole: 'person',
        messageKind: 'text',
        contentText: '@PeerKordi   what are you doing',
        content: { sender: 'Peer', timeLabel: '14:11', kind: 'session-relay' },
        status: 'sent',
        sequenceNum: 1,
        createdAtMs: 2,
        updatedAtMs: 1,
        sourceTransport: 'desktop-bridge-session-relay',
        sourceEventId: 'relay-source:old',
      },
    ],
  } as unknown as CanonicalSessionState;

  const next = mergeCanonicalStatePreservingCollaborationUiMessages(fetched, current)!;

  assert.deepEqual(next.messages.map((message) => message.id), ['msg:canonical:new-peer-request']);
});

test('canonical refresh preserves optimistic sent bridge session messages until they are persisted', () => {
  const fetched = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [],
  } as unknown as CanonicalSessionState;
  const current = {
    sessions: [{ id: 'session:bridge:person' }],
    messages: [{
      id: 'msg:ui:sent-before-append',
      sessionId: 'session:bridge:person',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'hello',
      content: { sender: 'Me', timeLabel: '22:20' },
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      sourceTransport: 'desktop-bridge-ui',
    }],
  } as unknown as CanonicalSessionState;

  const next = mergeCanonicalStatePreservingCollaborationUiMessages(fetched, current)!;

  assert.deepEqual(next.messages.map((message) => message.id), ['msg:ui:sent-before-append']);
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
    }, 'New group', 'session:group:root', 12_345),
    {
      customName: 'New group',
      groupId: 'session:group:root',
      groupSpaceId: 'session:group:root',
      groupNameUpdatedAtMs: 12_345,
      titleSource: 'manual',
      sessionTitleSource: 'manual',
      extra: 'kept',
    },
  );
});

test('session rename notice text names the actor, scope, and new title', () => {
  assert.equal(
    sessionRenameNoticeText('Kordi User 4', 'HIHIHI', 'session'),
    'Kordi User 4 changed the session name to HIHIHI',
  );
  assert.equal(
    sessionRenameNoticeText('Kordi User 4', 'Atestgroup', 'group'),
    'Kordi User 4 changed the group name to Atestgroup',
  );
});

test('group invite title uses the shared root name instead of a stale child name', () => {
  const state = {
    sessions: [
      {
        id: 'session:group:root',
        title: 'thefirsttestgroup',
        metadata: { customName: 'thefirsttestgroup', groupSpaceId: 'session:group:root' },
      },
      {
        id: 'session:group:child',
        title: 'main',
        metadata: { customName: 'viewer-local stale name', groupSpaceId: 'session:group:root' },
      },
    ],
  } as CanonicalSessionState;

  assert.equal(canonicalGroupInviteTitleForSession(state, 'session:group:child'), 'thefirsttestgroup');
});

test('group invite title never promotes a child session title to the shared group name', () => {
  const state = {
    sessions: [
      {
        id: 'session:group:root',
        title: 'main',
        metadata: { groupSpaceId: 'session:group:root' },
      },
      {
        id: 'session:group:child',
        title: 'planning',
        metadata: { groupSpaceId: 'session:group:root' },
      },
    ],
  } as CanonicalSessionState;

  assert.equal(canonicalGroupInviteTitleForSession(state, 'session:group:child'), null);
});

test('group session sync context carries the exact child session and group space without message history', () => {
  const state = {
    profile: { humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Testuser2', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'kd_me', humanId: 'kh_me', avatarKey: 'me' },
      { id: 'human:maya', kind: 'human', displayName: 'Maya', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'kd_maya', humanId: 'kh_maya', avatarKey: 'maya' },
    ],
    sessions: [
      {
        id: 'session:group:root',
        title: 'thefirsttestgroup',
        createdByIdentityId: 'human:maya',
        metadata: { customName: 'thefirsttestgroup', groupSpaceId: 'session:group:root' },
      },
      {
        id: 'session:group:child',
        title: 'New session',
        metadata: { groupSpaceId: 'session:group:root', adminIdentityIds: ['human:me'] },
      },
    ],
    participants: [
      { sessionId: 'session:group:child', identityId: 'human:me', role: 'admin', state: 'active' },
      { sessionId: 'session:group:child', identityId: 'human:maya', role: 'person', state: 'active' },
    ],
    messages: [
      {
        id: 'msg:1',
        sessionId: 'session:group:child',
        senderIdentityId: 'human:me',
        senderRole: 'user',
        messageKind: 'text',
        contentText: 'Should not be attached to a pure session-created update',
        content: { sender: 'Testuser2', timeLabel: '13:04' },
        sequenceNum: 1,
        createdAtMs: 1_000,
      },
    ],
  } as CanonicalSessionState;

  assert.deepEqual(canonicalGroupSessionSyncContextForSession(state, 'session:group:child', 'session:group:fallback'), {
    parentSessionTitle: 'New session',
    parentGroupSpaceId: 'session:group:root',
    parentSessionParticipants: [
      { identityId: 'human:me', displayName: 'Testuser2', role: 'person', sourceIdentityId: 'kd_me', humanId: 'kh_me', agentId: null, avatarKey: 'me', profileImageUrl: null },
      { identityId: 'human:maya', displayName: 'Maya', role: 'admin', sourceIdentityId: 'kd_maya', humanId: 'kh_maya', agentId: null, avatarKey: 'maya', profileImageUrl: null },
    ],
    parentSessionMessages: [],
  });
});

test('group invite context carries the child session title fallback, participants, and history', () => {
  const state = {
    profile: { humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Testuser2', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'kd_me', humanId: 'kh_me', avatarKey: 'me' },
      { id: 'human:maya', kind: 'human', displayName: 'Maya', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'kd_maya', humanId: 'kh_maya', avatarKey: 'maya' },
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
      { sessionId: 'session:group:child', identityId: 'human:maya', role: 'person', state: 'active' },
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
      { identityId: 'human:me', displayName: 'Testuser2', role: 'admin', sourceIdentityId: 'kd_me', humanId: 'kh_me', agentId: null, avatarKey: 'me', profileImageUrl: null },
      { identityId: 'human:maya', displayName: 'Maya', role: 'person', sourceIdentityId: 'kd_maya', humanId: 'kh_maya', agentId: null, avatarKey: 'maya', profileImageUrl: null },
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
      { id: 'human:maya', displayName: 'Maya' },
      { id: 'agent:kordi', displayName: 'Kordi' },
    ],
    sessions: [{ id: 'session:group:child', title: 'Group', metadata: {} }],
    messages: [
      {
        id: 'msg:2',
        sessionId: 'session:group:child',
        senderIdentityId: 'human:maya',
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
    { role: 'person', sender: 'Maya', text: 'Earlier reply', timeLabel: '13:05', index: 1 },
  ]);
});
