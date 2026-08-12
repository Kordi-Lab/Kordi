import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  OpenCanonicalSessionFastResult,
} from '../src/kordi-app/types';
import {
  mergeCloudSelfAgentCanonicalSyncBatch,
} from '../src/features/cloud/cloudCanonicalStateMerge';
import {
  cloudSelfAgentCanonicalSyncPlanSignature,
  persistCloudSelfAgentCanonicalSyncPlan,
} from '../src/features/cloud/cloudSelfAgentCanonicalSyncExecution';
import type {
  CloudSelfAgentCanonicalSyncPlan,
} from '../src/features/cloud/cloudSelfAgentCanonicalSync';

const identity: CanonicalIdentity = {
  id: 'agent:cloud-self:acct_me',
  kind: 'agent',
  displayName: 'My Kordi',
  ownerIdentityId: 'human:acct_me',
  source: 'local',
  avatarKey: 'cloud-self:acct_me',
  createdAtMs: 1,
  updatedAtMs: 1,
};

const sessionResult: OpenCanonicalSessionFastResult = {
  session: {
    id: 'session:self-agent:one',
    kind: 'self-agent',
    title: 'Hello',
    status: 'active',
    createdByIdentityId: 'human:acct_me',
    primaryIdentityId: identity.id,
    createdAtMs: 1,
    updatedAtMs: 2,
    lastMessageAtMs: 2,
  },
  participants: [],
};

const restoredMessage: CanonicalSessionMessage = {
  id: 'msg:cloud:self:request',
  sessionId: sessionResult.session.id,
  senderIdentityId: 'human:acct_me',
  senderRole: 'user',
  messageKind: 'text',
  contentText: 'Hello',
  status: 'sent',
  sequenceNum: 1,
  createdAtMs: 2,
  updatedAtMs: 2,
  sourceTransport: 'cloud-self-agent',
  sourceEventId: 'request',
};

const plan: CloudSelfAgentCanonicalSyncPlan = {
  agentIdentityRequest: {
    id: identity.id,
    kind: 'agent',
    displayName: identity.displayName,
  },
  sessionRequests: [{
    id: sessionResult.session.id,
    kind: 'self-agent',
    title: sessionResult.session.title,
    createdByIdentityId: sessionResult.session.createdByIdentityId,
    primaryIdentityId: identity.id,
    participantIdentityIds: [],
  }],
  messageRequests: [{
    id: restoredMessage.id,
    sessionId: restoredMessage.sessionId,
    senderIdentityId: restoredMessage.senderIdentityId,
    senderRole: restoredMessage.senderRole,
    messageKind: restoredMessage.messageKind,
    contentText: restoredMessage.contentText,
    status: restoredMessage.status,
    createdAtMs: restoredMessage.createdAtMs,
    sourceTransport: restoredMessage.sourceTransport,
    sourceEventId: restoredMessage.sourceEventId,
  }],
  mirrorReconciliations: [],
};

function stateWithNewerHistory(): CanonicalSessionState {
  return {
    storagePath: '/tmp/kordi-test',
    profile: {
      id: 'profile',
      displayName: 'Me',
      humanIdentityId: 'human:acct_me',
      storageRoot: '/tmp/kordi-test',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [],
    participants: [],
    messages: [{
      id: 'msg:newer-local-page',
      sessionId: sessionResult.session.id,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'Loaded while sync was running',
      status: 'sent',
      sequenceNum: 2,
      createdAtMs: 3,
      updatedAtMs: 3,
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('self-agent canonical persistence returns one batch after ordered writes', async () => {
  const calls: string[] = [];
  const batch = await persistCloudSelfAgentCanonicalSyncPlan(plan, {
    persistence: {
      upsertIdentity: async () => {
        calls.push('identity');
        return identity;
      },
      openSession: async () => {
        calls.push('session');
        return sessionResult;
      },
      upsertMessage: async () => {
        calls.push('message');
        return restoredMessage;
      },
      reconcileMessageMirror: async () => {
        calls.push('reconcile');
        return true;
      },
    },
  });

  assert.deepEqual(calls, ['identity', 'session', 'message']);
  assert.deepEqual(batch, {
    identity,
    sessions: [sessionResult],
    messages: [restoredMessage],
    reconciledMessageMirrors: [],
  });
});

test('self-agent canonical batch merges into the latest state without replacing newer history', () => {
  const latest = stateWithNewerHistory();
  const merged = mergeCloudSelfAgentCanonicalSyncBatch(latest, {
    identity,
    sessions: [sessionResult],
    messages: [restoredMessage],
    reconciledMessageMirrors: [],
  });

  assert.ok(merged);
  assert.deepEqual(
    merged.messages.map((message) => message.id),
    ['msg:newer-local-page', restoredMessage.id],
  );
  assert.equal(merged.identities.some((row) => row.id === identity.id), true);
  assert.equal(merged.sessions.some((row) => row.id === sessionResult.session.id), true);
});

test('message mirror reconciliation repairs every local reference before removing the duplicate', () => {
  const preferredMessageId = 'message:local';
  const duplicateMessageId = 'message:cloud';
  const unchangedMessage: CanonicalSessionMessage = {
    ...restoredMessage,
    id: preferredMessageId,
    sourceTransport: 'desktop-chat-ui',
  };
  const duplicateMessage: CanonicalSessionMessage = {
    ...restoredMessage,
    id: duplicateMessageId,
    sourceTransport: 'cloud-self-agent',
  };
  const responseMessage: CanonicalSessionMessage = {
    ...restoredMessage,
    id: 'message:response',
    senderIdentityId: identity.id,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    parentMessageId: duplicateMessageId,
    contentHash: 'old-hash',
    content: {
      replyToMessageId: duplicateMessageId,
      requestMessageId: duplicateMessageId,
      cloudRequestMessageId: 'wire:cloud',
      text: duplicateMessageId,
      messageAction: {
        source: { sourceMessageId: duplicateMessageId },
      },
    },
  };
  const current: CanonicalSessionState = {
    ...stateWithNewerHistory(),
    identities: [identity],
    sessions: [{
      ...sessionResult.session,
      metadata: {
        sessionTitleGeneratedFromMessageId: duplicateMessageId,
        fork: {
          forkedFromMessageId: duplicateMessageId,
          forkedFromMessageAliases: [duplicateMessageId, 'entry:runtime'],
        },
      },
    }],
    participants: [{
      sessionId: sessionResult.session.id,
      identityId: 'human:acct_me',
      role: 'self',
      state: 'active',
      addedAtMs: 1,
      lastReadMessageId: duplicateMessageId,
    }],
    messages: [unchangedMessage, duplicateMessage, responseMessage],
    delegatedExchanges: [{
      id: 'exchange:one',
      sessionId: sessionResult.session.id,
      initiatorIdentityId: 'human:acct_me',
      targetIdentityId: identity.id,
      triggerMessageId: duplicateMessageId,
      requestMessageId: duplicateMessageId,
      responseMessageId: duplicateMessageId,
      transport: 'local',
      contextPolicy: 'recent-window',
      status: 'complete',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    contextSnapshots: [{
      id: 'context:one',
      profileId: 'profile',
      sessionId: sessionResult.session.id,
      agentIdentityId: identity.id,
      provider: 'openai',
      model: 'gpt-5',
      promptHash: 'prompt',
      participantHash: 'participants',
      uptoMessageId: duplicateMessageId,
      messageRangeHash: 'range',
      createdAtMs: 1,
    }],
  };

  const merged = mergeCloudSelfAgentCanonicalSyncBatch(current, {
    identity,
    sessions: [],
    messages: [],
    reconciledMessageMirrors: [{
      preferredMessageId,
      duplicateMessageId,
    }],
  });

  assert.ok(merged);
  assert.equal(merged.messages.includes(unchangedMessage), true);
  assert.equal(merged.messages.some((message) => message.id === duplicateMessageId), false);
  const response = merged.messages.find((message) => message.id === responseMessage.id);
  assert.equal(response?.parentMessageId, preferredMessageId);
  assert.equal(response?.contentHash, null);
  assert.deepEqual(response?.content, {
    replyToMessageId: preferredMessageId,
    requestMessageId: preferredMessageId,
    cloudRequestMessageId: 'wire:cloud',
    text: duplicateMessageId,
    messageAction: {
      source: { sourceMessageId: preferredMessageId },
    },
  });
  assert.equal(merged.participants[0]?.lastReadMessageId, preferredMessageId);
  assert.deepEqual(merged.sessions[0]?.metadata, {
    sessionTitleGeneratedFromMessageId: preferredMessageId,
    fork: {
      forkedFromMessageId: preferredMessageId,
      forkedFromMessageAliases: [preferredMessageId, 'entry:runtime'],
    },
  });
  assert.deepEqual(
    [
      merged.delegatedExchanges[0]?.triggerMessageId,
      merged.delegatedExchanges[0]?.requestMessageId,
      merged.delegatedExchanges[0]?.responseMessageId,
    ],
    [preferredMessageId, preferredMessageId, preferredMessageId],
  );
  assert.equal(merged.contextSnapshots[0]?.uptoMessageId, preferredMessageId);
  assert.equal(typeof merged.contextSnapshots[0]?.invalidatedAtMs, 'number');
});

test('equivalent self-agent canonical batch replay preserves the state reference', () => {
  const initial = mergeCloudSelfAgentCanonicalSyncBatch(stateWithNewerHistory(), {
    identity,
    sessions: [sessionResult],
    messages: [restoredMessage],
    reconciledMessageMirrors: [],
  });
  assert.ok(initial);

  const replayed = mergeCloudSelfAgentCanonicalSyncBatch(initial, {
    identity: structuredClone(identity),
    sessions: [structuredClone(sessionResult)],
    messages: [structuredClone(restoredMessage)],
    reconciledMessageMirrors: [],
  });

  assert.equal(replayed, initial);
});

test('self-agent canonical plan signatures change with persisted content', () => {
  const signature = cloudSelfAgentCanonicalSyncPlanSignature(plan);
  const changed = cloudSelfAgentCanonicalSyncPlanSignature({
    ...plan,
    messageRequests: [{
      ...plan.messageRequests[0],
      contentText: 'Changed',
    }],
  });
  assert.notEqual(signature, changed);
});

test('self-agent canonical persistence removes a proven mirror after repairing messages', async () => {
  const calls: string[] = [];
  const batch = await persistCloudSelfAgentCanonicalSyncPlan({
    ...plan,
    mirrorReconciliations: [{
      preferredMessageId: 'message:local',
      duplicateMessageId: 'message:cloud',
    }],
  }, {
    persistence: {
      upsertIdentity: async () => identity,
      openSession: async () => sessionResult,
      upsertMessage: async () => {
        calls.push('message');
        return restoredMessage;
      },
      reconcileMessageMirror: async (preferred, duplicate) => {
        calls.push(`${preferred}->${duplicate}`);
        return true;
      },
    },
  });

  assert.deepEqual(calls, [
    'message',
    'message:local->message:cloud',
  ]);
  assert.deepEqual(batch?.reconciledMessageMirrors, [{
    preferredMessageId: 'message:local',
    duplicateMessageId: 'message:cloud',
  }]);
});
