import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  mergeCanonicalMessageRow,
  mergeCanonicalReadCursorDelta,
} from '../src/features/canonical/canonicalStateReducers';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';

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
