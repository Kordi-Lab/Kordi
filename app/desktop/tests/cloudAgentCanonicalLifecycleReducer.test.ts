import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mergeCanonicalMessageDeliveryDelta,
  mergeCanonicalMessageRow,
} from '../src/features/canonical/canonicalStateReducers';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';

function agentTurn(
  state: 'processing' | 'complete' | 'failed',
  updatedAtMs: number,
): CanonicalSessionMessage {
  return {
    id: 'msg:stable-agent-slot',
    sessionId: 'session:one',
    senderIdentityId: 'agent:cloud:acct_me',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: state === 'complete' ? 'Finished answer' : 'processing...',
    content: { deliveryState: state, requestId: 'request:one' },
    parentMessageId: 'request:one',
    delegatedExchangeId: null,
    status: state,
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:stable-slot',
  };
}

function stateWith(message: CanonicalSessionMessage): CanonicalSessionState {
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
    participants: [],
    messages: [message],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('message rows advance processing to terminal and reject stale replay', () => {
  const processing = agentTurn('processing', 1);
  const complete = agentTurn('complete', 10);
  const initial = stateWith(processing);

  const terminal = mergeCanonicalMessageRow(initial, complete);
  const replayed = mergeCanonicalMessageRow(
    terminal,
    agentTurn('processing', 20),
  );

  assert.notEqual(terminal, initial);
  assert.equal(terminal?.messages[0], complete);
  assert.equal(replayed, terminal);
  assert.equal(replayed?.messages[0], complete);
});

test('newer delivery deltas cannot roll terminal turns back to processing', () => {
  const complete = agentTurn('complete', 100);
  const state = stateWith(complete);
  const next = mergeCanonicalMessageDeliveryDelta(state, {
    messageId: complete.id,
    sessionId: complete.sessionId,
    status: 'processing',
    deliveryState: 'processing',
    deliveredRecipientIds: [],
    pendingRecipientIds: [],
    exhaustedRecipientIds: [],
    updatedAtMs: 200,
    contentHash: 'stale-processing',
    sessionUpdatedAtMs: 200,
    sessionLastMessageAtMs: 200,
  });

  assert.equal(next, state);
  assert.equal(next?.messages[0], complete);
});

test('unknown agent status cannot bypass a terminal lifecycle lock', () => {
  const complete = agentTurn('complete', 100);
  const malformedReplay = {
    ...complete,
    status: 'sent',
    contentText: '',
    content: { deliveryState: 'sent', requestId: 'request:one' },
    updatedAtMs: 200,
  };
  const state = stateWith(complete);
  const next = mergeCanonicalMessageRow(state, malformedReplay);

  assert.equal(next, state);
  assert.equal(next?.messages[0], complete);
});

test('a successful owner reply upgrades a failed fallback without allowing regression', () => {
  const failed = agentTurn('failed', 100);
  const complete = agentTurn('complete', 200);
  const upgraded = mergeCanonicalMessageRow(stateWith(failed), complete);
  const regressed = mergeCanonicalMessageRow(
    upgraded,
    agentTurn('failed', 300),
  );

  assert.equal(upgraded?.messages[0], complete);
  assert.equal(regressed, upgraded);
  assert.equal(regressed?.messages[0], complete);
});
