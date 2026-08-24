import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  setCloudGroupRequestPlaceholderProcessing,
  upsertCanonicalRequestIntoLocalState,
  type CloudAgentRequestCandidate,
} from '../src/features/cloud/cloudAgentRequestState';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';

const requestMessage: CanonicalSessionMessage = {
  id: 'request:one',
  sessionId: 'group:one',
  senderIdentityId: 'human:sender',
  senderRole: 'person',
  messageKind: 'text',
  contentText: '@Agent help',
  status: 'sent',
  sequenceNum: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const candidate: CloudAgentRequestCandidate = {
  requestMessage,
  targetAccountId: 'account:agent',
  targetHumanDisplayName: 'Agent owner',
  targetAgentDisplayName: 'Agent',
};

function responseMessage(
  status: 'processing' | 'complete' | 'failed' | 'cancelled',
): CanonicalSessionMessage {
  return {
    id: 'msg:cloud-agent-processing:request:one:account:agent',
    sessionId: requestMessage.sessionId,
    senderIdentityId: 'agent:cloud:account:agent',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: status === 'complete' ? 'Finished answer' : `${status}...`,
    content: {
      deliveryState: status,
      requestId: requestMessage.id,
      replyToMessageId: requestMessage.id,
    },
    parentMessageId: requestMessage.id,
    status,
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:response',
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
    messages: [requestMessage, message],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('availability reconciliation preserves a completed stable response slot', () => {
  const terminal = responseMessage('complete');
  const state = stateWith(terminal);

  const next = setCloudGroupRequestPlaceholderProcessing(
    state,
    candidate,
    terminal.id,
  );

  assert.equal(next, state);
  assert.equal(next?.messages[1], terminal);
  assert.equal(next?.messages[1]?.contentText, 'Finished answer');
});

test('local request upsert cannot replace a failed stable response with processing', () => {
  const failed = responseMessage('failed');
  const state = stateWith(failed);

  const next = upsertCanonicalRequestIntoLocalState(state, {
    id: failed.id,
    sessionId: failed.sessionId,
    senderIdentityId: failed.senderIdentityId,
    senderRole: failed.senderRole,
    messageKind: failed.messageKind,
    contentText: 'processing...',
    content: { deliveryState: 'processing', requestId: requestMessage.id },
    parentMessageId: requestMessage.id,
    status: 'processing',
    createdAtMs: 20,
    sourceTransport: failed.sourceTransport,
    sourceEventId: failed.sourceEventId,
  });

  assert.equal(next, state);
  assert.equal(next?.messages[1], failed);
});

test('availability reconciliation can keep an existing processing slot processing', () => {
  const processing = {
    ...responseMessage('processing'),
    contentText: 'Processing..',
  };
  const state = stateWith(processing);

  const next = setCloudGroupRequestPlaceholderProcessing(
    state,
    candidate,
    processing.id,
  );

  assert.equal(next, state);
});
