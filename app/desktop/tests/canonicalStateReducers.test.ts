import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  applyCanonicalProfileIdentityDelta,
  mergeCanonicalMessageDeliveryDelta,
  mergeCanonicalMessageRow,
  mergeCanonicalReadCursorDelta,
} from '../src/features/canonical/canonicalStateReducers';
import type {
  CanonicalIdentity,
  CanonicalProfileIdentityDelta,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';

function profileIdentityDelta(
  state: CanonicalSessionState,
  previousIdentityId = 'human:legacy',
  identityId = 'human:acct',
): CanonicalProfileIdentityDelta {
  return {
    profile: {
      ...state.profile,
      displayName: 'Cloud Name',
      humanIdentityId: identityId,
      updatedAtMs: 2,
    },
    identity: {
      id: identityId,
      kind: 'human',
      displayName: 'Cloud Name',
      ownerIdentityId: null,
      source: 'local',
      sourceHostId: null,
      bridgeNodeId: null,
      humanId: 'acct',
      agentId: null,
      avatarKey: 'acct',
      profileImageUrl: null,
      metadata: { accountId: 'acct', cloudProfileIdentity: true },
      createdAtMs: 2,
      updatedAtMs: 2,
    },
    previousIdentityId,
    groupSelfSessionIds: [],
  };
}

function applyProfileIdentityDelta(
  state: CanonicalSessionState,
  delta: CanonicalProfileIdentityDelta,
): CanonicalSessionState | null {
  return applyCanonicalProfileIdentityDelta(state, delta);
}

function fixtureState(): CanonicalSessionState {
  return {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [],
    participants: [{
      sessionId: 'session:one',
      identityId: 'human:me',
      role: 'self',
      state: 'active',
      addedByIdentityId: 'human:me',
      addedAtMs: 1,
      lastSeenAtMs: null,
      lastReadMessageId: null,
    }],
    messages: [messageRow('msg:one', 1)],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

function messageRow(id: string, sequenceNum: number): CanonicalSessionMessage {
  return {
    id,
    sessionId: 'session:one',
    senderIdentityId: 'human:me',
    senderRole: 'user',
    messageKind: 'text',
    contentText: id,
    content: null,
    parentMessageId: null,
    delegatedExchangeId: null,
    status: 'sent',
    sequenceNum,
    createdAtMs: sequenceNum,
    updatedAtMs: sequenceNum,
    contentHash: null,
    sourceTransport: 'desktop-chat-ui',
    sourceEventId: id,
  };
}

test('read cursor deltas update only the matching participant', () => {
  const state = fixtureState();
  const next = mergeCanonicalReadCursorDelta(state, {
    sessionId: 'session:one',
    identityId: 'human:me',
    lastSeenAtMs: 10,
    lastReadMessageId: 'msg:one',
  });

  assert.notEqual(next, state);
  assert.equal(next?.messages, state.messages);
  assert.equal(next?.participants[0]?.lastSeenAtMs, 10);
  assert.equal(next?.participants[0]?.lastReadMessageId, 'msg:one');
});

test('read cursor deltas preserve state when the participant is absent', () => {
  const state = fixtureState();
  const next = mergeCanonicalReadCursorDelta(state, {
    sessionId: 'session:missing',
    identityId: 'human:me',
    lastSeenAtMs: 10,
    lastReadMessageId: null,
  });

  assert.equal(next, state);
});

test('read cursor deltas cannot roll a newer local cursor backward', () => {
  const state = fixtureState();
  state.participants[0] = {
    ...state.participants[0],
    lastSeenAtMs: 20,
    lastReadMessageId: 'msg:newer',
  };
  const next = mergeCanonicalReadCursorDelta(state, {
    sessionId: 'session:one',
    identityId: 'human:me',
    lastSeenAtMs: 10,
    lastReadMessageId: 'msg:one',
  });

  assert.equal(next, state);
  assert.equal(next?.participants[0]?.lastReadMessageId, 'msg:newer');
});

test('message row deltas replace by id and append new persisted rows', () => {
  const state = fixtureState();
  const replacement = { ...messageRow('msg:one', 7), contentText: 'persisted' };
  const replaced = mergeCanonicalMessageRow(state, replacement);
  assert.equal(replaced?.messages.length, 1);
  assert.equal(replaced?.messages[0], replacement);

  const appendedRow = messageRow('msg:two', 8);
  const appended = mergeCanonicalMessageRow(replaced, appendedRow);
  assert.equal(appended?.messages.length, 2);
  assert.equal(appended?.messages[1], appendedRow);
});

test('message delivery deltas patch only the loaded target and preserve unrelated content', () => {
  const state = fixtureState();
  const target = {
    ...messageRow('msg:one', 1),
    status: 'sending',
    content: {
      deliveryState: 'sending',
      deliveredRecipientIds: [],
      pendingRecipientIds: ['acct:a', 'acct:b'],
      exhaustedRecipientIds: [],
      unrelated: { keep: true },
    },
  };
  const untouched = messageRow('msg:two', 2);
  state.messages = [target, untouched];

  const next = mergeCanonicalMessageDeliveryDelta(state, {
    messageId: target.id,
    sessionId: target.sessionId,
    status: 'delivered',
    deliveryState: 'partial',
    deliveredRecipientIds: ['acct:a'],
    pendingRecipientIds: [],
    exhaustedRecipientIds: ['acct:b'],
    updatedAtMs: 99,
  });

  assert.notEqual(next, state);
  assert.notEqual(next?.messages, state.messages);
  assert.equal(next?.messages[1], untouched);
  assert.equal(next?.messages[0]?.status, 'delivered');
  assert.equal(next?.messages[0]?.updatedAtMs, 99);
  assert.deepEqual(next?.messages[0]?.content, {
    deliveryState: 'partial',
    deliveredRecipientIds: ['acct:a'],
    pendingRecipientIds: [],
    exhaustedRecipientIds: ['acct:b'],
    unrelated: { keep: true },
  });
});

test('message delivery deltas preserve the exact state reference when the target is not loaded', () => {
  const state = fixtureState();
  const next = mergeCanonicalMessageDeliveryDelta(state, {
    messageId: 'msg:older-than-loaded-window',
    sessionId: 'session:one',
    status: 'delivered',
    deliveryState: 'delivered',
    deliveredRecipientIds: ['acct:a'],
    pendingRecipientIds: [],
    exhaustedRecipientIds: [],
    updatedAtMs: 99,
  });

  assert.equal(next, state);
  assert.equal(mergeCanonicalMessageDeliveryDelta(null, null), null);
});

test('profile identity deltas update the loaded profile without replacing message history', () => {
  const state = fixtureState();
  state.profile = { ...state.profile, humanIdentityId: 'human:legacy' };
  const next = applyProfileIdentityDelta(state, profileIdentityDelta(state));

  assert.equal(next?.profile.humanIdentityId, 'human:acct');
  assert.equal(next?.messages, state.messages);
});

test('profile identity deltas migrate loaded references, dedupe participants, and enforce group self roles', () => {
  const oldId = 'human:legacy';
  const stableId = 'human:acct';
  const state = fixtureState();
  state.profile = { ...state.profile, humanIdentityId: oldId };

  const oldIdentity: CanonicalIdentity = {
    id: oldId,
    kind: 'human',
    displayName: 'Legacy Me',
    ownerIdentityId: oldId,
    source: 'local',
    avatarKey: 'legacy',
    metadata: { exact: oldId },
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const existingStableIdentity: CanonicalIdentity = {
    id: stableId,
    kind: 'human',
    displayName: 'Cloud placeholder',
    source: 'bridge',
    avatarKey: 'acct',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const nestedMetadata = {
    exact: oldId,
    nested: [oldId, { partial: `prefix:${oldId}`, untouched: true }],
    untouched: { value: 'keep-reference' },
  };
  const ownedAgent: CanonicalIdentity = {
    id: 'agent:owned',
    kind: 'agent',
    displayName: 'Owned agent',
    ownerIdentityId: oldId,
    source: 'local',
    avatarKey: 'owned',
    metadata: nestedMetadata,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const untouchedIdentity: CanonicalIdentity = {
    id: 'human:remote',
    kind: 'human',
    displayName: 'Remote',
    source: 'bridge',
    avatarKey: 'remote',
    metadata: { partial: `prefix:${oldId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  state.identities = [oldIdentity, existingStableIdentity, ownedAgent, untouchedIdentity];

  const groupMetadata = {
    creator: oldId,
    nested: [oldId, { partial: `${oldId}:suffix` }],
    untouched: { value: 'keep-reference' },
  };
  const groupSession: CanonicalSessionState['sessions'][number] = {
    id: 'session:group',
    kind: 'group',
    title: 'Group',
    status: 'active',
    createdByIdentityId: oldId,
    primaryIdentityId: oldId,
    relationshipIdentityId: oldId,
    metadata: groupMetadata,
    createdAtMs: 1,
    updatedAtMs: 1,
    lastMessageAtMs: 1,
  };
  const untouchedSession: CanonicalSessionState['sessions'][number] = {
    id: 'session:untouched',
    kind: 'direct-person',
    title: 'Untouched',
    status: 'active',
    createdByIdentityId: 'human:remote',
    primaryIdentityId: 'human:remote',
    relationshipIdentityId: null,
    metadata: { partial: `prefix:${oldId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    lastMessageAtMs: 1,
  };
  state.sessions = [groupSession, untouchedSession];

  const migratedParticipant: CanonicalSessionState['participants'][number] = {
    sessionId: 'session:group',
    identityId: oldId,
    role: 'admin',
    state: 'active',
    addedByIdentityId: oldId,
    addedAtMs: 10,
    lastSeenAtMs: 10,
    lastReadMessageId: 'message:legacy',
    metadata: { source: 'migrated', exact: oldId },
  };
  const existingStableParticipant: CanonicalSessionState['participants'][number] = {
    sessionId: 'session:group',
    identityId: stableId,
    role: 'person',
    state: 'left',
    addedByIdentityId: oldId,
    addedAtMs: 20,
    lastSeenAtMs: 20,
    lastReadMessageId: 'message:stable',
    metadata: { source: 'stable', exact: oldId },
  };
  const remoteGroupSelf: CanonicalSessionState['participants'][number] = {
    sessionId: 'session:group',
    identityId: 'human:remote',
    role: 'self',
    state: 'active',
    addedByIdentityId: 'human:remote',
    addedAtMs: 30,
    lastSeenAtMs: null,
    lastReadMessageId: null,
  };
  const migratedOnlyParticipant: CanonicalSessionState['participants'][number] = {
    sessionId: 'session:direct',
    identityId: oldId,
    role: 'person',
    state: 'left',
    addedByIdentityId: oldId,
    addedAtMs: 40,
    lastSeenAtMs: 40,
    lastReadMessageId: 'message:direct',
    metadata: { exact: oldId },
  };
  const untouchedParticipant: CanonicalSessionState['participants'][number] = {
    sessionId: 'session:untouched',
    identityId: 'human:remote',
    role: 'person',
    state: 'active',
    addedByIdentityId: 'human:remote',
    addedAtMs: 50,
    lastSeenAtMs: null,
    lastReadMessageId: null,
  };
  state.participants = [
    migratedParticipant,
    existingStableParticipant,
    remoteGroupSelf,
    migratedOnlyParticipant,
    untouchedParticipant,
  ];

  const migratedMessage = {
    ...messageRow('message:migrated', 1),
    sessionId: 'session:group',
    senderIdentityId: oldId,
    content: { exact: oldId, partial: `prefix:${oldId}`, nested: [oldId] },
  };
  const untouchedMessage = {
    ...messageRow('message:untouched', 2),
    sessionId: 'session:untouched',
    senderIdentityId: 'human:remote',
    content: { partial: `prefix:${oldId}` },
  };
  state.messages = [migratedMessage, untouchedMessage];

  state.delegatedExchanges = [{
    id: 'exchange:one',
    sessionId: 'session:group',
    initiatorIdentityId: oldId,
    targetIdentityId: oldId,
    triggerMessageId: null,
    requestMessageId: null,
    responseMessageId: null,
    transport: 'local',
    bridgeHostId: null,
    bridgeConversationId: null,
    bridgeRequestId: null,
    contextPolicy: 'recent-window',
    status: 'complete',
    error: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  }];
  const oldPresence: CanonicalSessionState['presence'][number] = {
    identityId: oldId,
    status: 'online',
    sessionId: null,
    detail: null,
    updatedAtMs: 1,
    expiresAtMs: null,
  };
  const stablePresence: CanonicalSessionState['presence'][number] = {
    identityId: stableId,
    status: 'away',
    sessionId: null,
    detail: null,
    updatedAtMs: 2,
    expiresAtMs: null,
  };
  state.presence = [oldPresence, stablePresence];

  const contextSnapshot: CanonicalSessionState['contextSnapshots'][number] = {
    id: 'snapshot:one',
    profileId: state.profile.id,
    sessionId: 'session:group',
    agentIdentityId: oldId,
    provider: 'openai',
    model: 'gpt',
    promptHash: 'prompt',
    projectContextHash: null,
    participantHash: 'participants',
    uptoMessageId: null,
    messageRangeHash: 'messages',
    summaryText: null,
    summaryJson: { exact: oldId },
    tokenCount: null,
    createdAtMs: 1,
    invalidatedAtMs: null,
  };
  state.contextSnapshots = [contextSnapshot];

  const delta = profileIdentityDelta(state, oldId, stableId);
  delta.groupSelfSessionIds = ['session:group'];
  const next = applyProfileIdentityDelta(state, delta);
  assert.ok(next);

  assert.equal(next.profile, delta.profile);
  const retainedOldIdentity = next.identities.find((identity) => identity.id === oldId);
  assert.ok(retainedOldIdentity);
  assert.equal(retainedOldIdentity.ownerIdentityId, stableId);
  assert.deepEqual(retainedOldIdentity.metadata, { exact: stableId });
  assert.equal(next.identities.find((identity) => identity.id === stableId), delta.identity);
  const nextAgent = next.identities.find((identity) => identity.id === ownedAgent.id);
  assert.equal(nextAgent?.ownerIdentityId, stableId);
  assert.deepEqual(nextAgent?.metadata, {
    exact: stableId,
    nested: [stableId, { partial: `prefix:${oldId}`, untouched: true }],
    untouched: nestedMetadata.untouched,
  });
  assert.equal((nextAgent?.metadata as typeof nestedMetadata).untouched, nestedMetadata.untouched);
  assert.equal(next.identities.find((identity) => identity.id === untouchedIdentity.id), untouchedIdentity);

  const nextGroup = next.sessions.find((session) => session.id === groupSession.id);
  assert.equal(nextGroup?.createdByIdentityId, stableId);
  assert.equal(nextGroup?.primaryIdentityId, stableId);
  assert.equal(nextGroup?.relationshipIdentityId, stableId);
  assert.deepEqual(nextGroup?.metadata, {
    creator: stableId,
    nested: [stableId, { partial: `${oldId}:suffix` }],
    untouched: groupMetadata.untouched,
  });
  assert.equal((nextGroup?.metadata as typeof groupMetadata).untouched, groupMetadata.untouched);
  assert.equal(next.sessions.find((session) => session.id === untouchedSession.id), untouchedSession);

  const stableGroupRows = next.participants.filter((participant) => (
    participant.sessionId === 'session:group' && participant.identityId === stableId
  ));
  assert.equal(stableGroupRows.length, 1);
  assert.equal(stableGroupRows[0]?.role, 'self');
  assert.equal(stableGroupRows[0]?.state, 'active');
  assert.equal(stableGroupRows[0]?.addedByIdentityId, stableId);
  assert.equal(stableGroupRows[0]?.addedAtMs, existingStableParticipant.addedAtMs);
  assert.equal(stableGroupRows[0]?.lastReadMessageId, existingStableParticipant.lastReadMessageId);
  assert.deepEqual(stableGroupRows[0]?.metadata, { source: 'stable', exact: stableId });
  assert.equal(
    next.participants.find((participant) => participant.identityId === 'human:remote' && participant.sessionId === 'session:group')?.role,
    'person',
  );
  const migratedDirect = next.participants.find((participant) => participant.sessionId === 'session:direct');
  assert.equal(migratedDirect?.identityId, stableId);
  assert.equal(migratedDirect?.role, 'self');
  assert.equal(migratedDirect?.state, 'active');
  assert.equal(migratedDirect?.lastReadMessageId, migratedOnlyParticipant.lastReadMessageId);
  assert.deepEqual(migratedDirect?.metadata, { exact: stableId });
  assert.equal(next.participants.find((participant) => participant.sessionId === 'session:untouched'), untouchedParticipant);
  assert.equal(new Set(next.participants.map((participant) => `${participant.sessionId}\0${participant.identityId}`)).size, next.participants.length);
  assert.deepEqual(
    next.participants.map((participant) => (
      `${participant.sessionId}|${participant.addedAtMs}|${participant.identityId}`
    )),
    [
      'session:direct|40|human:acct',
      'session:group|20|human:acct',
      'session:group|30|human:remote',
      'session:untouched|50|human:remote',
    ],
  );

  assert.equal(next.messages[0]?.senderIdentityId, stableId);
  assert.deepEqual(next.messages[0]?.content, {
    exact: stableId,
    partial: `prefix:${oldId}`,
    nested: [stableId],
  });
  assert.equal(next.messages[1], untouchedMessage);
  assert.equal(next.delegatedExchanges[0]?.initiatorIdentityId, stableId);
  assert.equal(next.delegatedExchanges[0]?.targetIdentityId, stableId);
  assert.deepEqual(next.presence, [stablePresence]);
  assert.equal(next.presence[0], stablePresence);

  assert.equal(next.contextSnapshots, state.contextSnapshots);
  assert.equal(next.contextSnapshots[0], contextSnapshot);
  assert.equal(next.contextSnapshots[0]?.agentIdentityId, oldId);
  assert.deepEqual(next.contextSnapshots[0]?.summaryJson, { exact: oldId });
  assert.equal(
    next.identities.some((identity) => identity.id === next.contextSnapshots[0]?.agentIdentityId),
    true,
  );
});

test('profile identity deltas preserve unrelated inactive stable participants', () => {
  const state = fixtureState();
  state.profile = { ...state.profile, humanIdentityId: 'human:legacy' };
  const inactiveStableParticipant: CanonicalSessionState['participants'][number] = {
    sessionId: 'session:left',
    identityId: 'human:acct',
    role: 'person',
    state: 'left',
    addedByIdentityId: 'human:other',
    addedAtMs: 10,
    lastSeenAtMs: 10,
    lastReadMessageId: 'message:left',
    metadata: { reason: 'left' },
  };
  state.participants = [inactiveStableParticipant];

  const next = applyProfileIdentityDelta(state, profileIdentityDelta(state));

  assert.equal(next?.participants[0], inactiveStableParticipant);
  assert.equal(next?.participants[0]?.role, 'person');
  assert.equal(next?.participants[0]?.state, 'left');
});

test('profile identity delta payload stays bounded with 20,000 loaded messages', () => {
  const state = fixtureState();
  state.profile = { ...state.profile, humanIdentityId: 'human:legacy' };
  state.messages = Array.from({ length: 20_000 }, (_, index) => ({
    ...messageRow(`message:${index}`, index),
    senderIdentityId: 'human:other',
  }));
  const delta = profileIdentityDelta(state);

  assert.deepEqual(Object.keys(delta).sort(), [
    'groupSelfSessionIds',
    'identity',
    'previousIdentityId',
    'profile',
  ]);
  assert.equal('messages' in delta, false);
  assert.equal('sessions' in delta, false);
  assert.equal('contextSnapshots' in delta, false);
  assert.ok(JSON.stringify(delta).length < 2_048);

  const next = applyProfileIdentityDelta(state, delta);
  assert.equal(next?.messages, state.messages);
  assert.equal(next?.messages.length, 20_000);
});
