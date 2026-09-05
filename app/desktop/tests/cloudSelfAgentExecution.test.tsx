import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CloudAccount,
  CloudMessage,
} from '../src/features/cloud/authClient';
import {
  encodeCloudAgentCancel,
  encodeCloudAgentResponse,
  parseCloudAgentResponse,
} from '../src/features/cloud/cloudAgentMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { acquireDesktopExecutionLease } from '../src/features/cloud/cloudDesktopExecutionLease';
import {
  cloudSelfAgentExecutionCanStart,
  cloudSelfAgentHasTerminalResponse,
  cloudSelfAgentTerminalResponseRequestIds,
  omitTerminalCloudSelfAgentLocalTurns,
  pendingCloudSelfAgentExecutionRequests,
  localSelfAgentRequestClientMessageIds,
} from '../src/features/cloud/useCloudSelfAgentExecution';

import { cloudSelfAgentRuntimeSessionId } from '../src/features/cloud/cloudAgentRuntime';
import { cloudAgentExecutionSnapshotFromTurn } from '../src/features/cloud/cloudAgentExecutionTrace';

test('cross-device self-agent execution uses the canonical desktop session id', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  assert.equal(cloudSelfAgentRuntimeSessionId(sessionId), sessionId);
  assert.equal(cloudSelfAgentRuntimeSessionId('  '), null);
});

test('native queue admission is preserved in the cross-device execution snapshot', () => {
  const execution = cloudAgentExecutionSnapshotFromTurn({
    id: 'turn-queued', sessionId: 'canonical-session', prompt: 'Next request',
    status: 'queued', message: 'Queued next', assistantText: '', thinkingText: '',
    tools: [], completed: false, succeeded: false, transcriptRefreshRequired: false,
  });
  const response = parseCloudAgentResponse(encodeCloudAgentResponse({
    requestId: 'request-queued', text: 'processing...', deliveryState: 'processing', execution,
  }));
  assert.equal(response?.execution?.phase, 'queued');
  assert.equal(response?.execution?.completed, false);
});
import type {
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Owner',
  primaryEmail: 'owner@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

function message(
  messageId: string,
  body: string,
  createdAt = '2026-08-16T12:00:00.000Z',
): CloudMessage {
  return {
    messageId,
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body,
    sessionId: 'session:self-agent:mobile',
    createdAt,
    deliveredAt: null,
    readAt: null,
  };
}

test('self-agent desktop execution keeps processing requests pending and stops at terminal state', () => {
  const request = message('request-1', 'Check disk usage');
  const processing = message('progress-1', encodeCloudAgentResponse({
    requestId: request.messageId,
    text: 'processing...',
    deliveryState: 'processing',
  }));
  const processingIndex = buildCloudMessageIndex(account.accountId, {
    [account.accountId]: [request, processing],
  });

  assert.deepEqual(
    pendingCloudSelfAgentExecutionRequests({
      account,
      messageIndex: processingIndex,
      nowMs: Date.parse(request.createdAt) + 1_000,
    }).map((candidate) => candidate.messageId),
    [request.messageId],
  );

  const terminal = message('response-1', encodeCloudAgentResponse({
    requestId: request.messageId,
    text: 'Done',
    deliveryState: 'complete',
  }));
  const completedMessages = [request, processing, terminal];
  const completedIndex = buildCloudMessageIndex(account.accountId, {
    [account.accountId]: completedMessages,
  });
  assert.equal(
    cloudSelfAgentHasTerminalResponse(request.messageId, completedMessages),
    true,
  );
  assert.equal(
    pendingCloudSelfAgentExecutionRequests({
      account,
      messageIndex: completedIndex,
      nowMs: Date.parse(request.createdAt) + 1_000,
    }).length,
    0,
  );
  assert.deepEqual(
    [...cloudSelfAgentTerminalResponseRequestIds(completedMessages)],
    [request.messageId],
  );
});

test('self-agent desktop execution ignores cancelled and stale requests', () => {
  const nowMs = Date.parse('2026-08-16T12:20:00.000Z');
  const stale = message(
    'request-stale',
    'Old request',
    '2026-08-16T12:00:00.000Z',
  );
  const cancelled = message(
    'request-cancelled',
    'Stop this request',
    '2026-08-16T12:19:00.000Z',
  );
  const cancel = message('cancel-1', encodeCloudAgentCancel({
    requestId: cancelled.messageId,
  }));
  const index = buildCloudMessageIndex(account.accountId, {
    [account.accountId]: [stale, cancelled, cancel],
  });

  assert.equal(
    pendingCloudSelfAgentExecutionRequests({
      account,
      messageIndex: index,
      nowMs,
    }).length,
    0,
  );

  const history = {
    ...message('request-history', 'Already answered'),
    messageKind: 'canonical-history-user',
  };
  assert.equal(
    pendingCloudSelfAgentExecutionRequests({
      account,
      messageIndex: buildCloudMessageIndex(account.accountId, {
        [account.accountId]: [history],
      }),
      nowMs,
    }).length,
    0,
  );
});

test('a local request blocks its mirrored Cloud request before a second execution starts', () => {
  const sessionId = 'session:self-agent:local-complete';
  const canonicalState = {
    sessions: [{ id: sessionId, kind: 'self-agent', title: 'Local', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 3 }],
    identities: [], participants: [],
    profile: { id: 'profile', humanIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'local-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Check this image', status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'desktop-chat-ui' },
    ],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as CanonicalSessionState;
  const ignoredClientMessageIds = localSelfAgentRequestClientMessageIds(canonicalState);
  const mirroredRequest = {
    ...message('cloud-request', 'Check this image'),
    sessionId,
    clientMessageId: [...ignoredClientMessageIds][0],
  };

  assert.equal(ignoredClientMessageIds.size, 1);
  assert.equal(pendingCloudSelfAgentExecutionRequests({
    account,
    messageIndex: buildCloudMessageIndex(account.accountId, {
      [account.accountId]: [mirroredRequest],
    }),
    ignoredClientMessageIds,
    nowMs: Date.parse(mirroredRequest.createdAt) + 1_000,
  }).length, 0);
});

test('cross-device requests wait until desktop authentication finishes loading', () => {
  assert.equal(cloudSelfAgentExecutionCanStart({
    account,
    initialMessagesSettled: true,
    runtimeReady: false,
  }), false);
  assert.equal(cloudSelfAgentExecutionCanStart({
    account,
    initialMessagesSettled: true,
    runtimeReady: true,
  }), true);
});

test('terminal Cloud responses remove completed local turns after a reload', () => {
  const retainedTurn = {
    id: 'turn-retained',
  } as DesktopChatTurnSnapshot;
  const terminalTurn = {
    id: 'turn-terminal',
  } as DesktopChatTurnSnapshot;
  const current = {
    'request-retained': retainedTurn,
    'request-terminal': terminalTurn,
  };

  const next = omitTerminalCloudSelfAgentLocalTurns(
    current,
    new Set(['request-terminal']),
  );

  assert.deepEqual(next, {
    'request-retained': retainedTurn,
  });
  assert.equal(
    omitTerminalCloudSelfAgentLocalTurns(
      next,
      new Set(['request-terminal']),
    ),
    next,
  );
});

test('desktop execution uses server admission and the fenced publication endpoint', async () => {
  let claimed = false;
  const actions: string[] = [];
  const client = {
    async desktopAgentExecution<T>(_token: string, action: string, _input: unknown): Promise<T> {
      actions.push(action);
      const acquired = !claimed;
      if (action === 'claim') claimed = true;
      return (action === 'claim' ? { runId: 'run-a', acquired } : message('progress', 'complete')) as T;
    },
  };
  const input = { requestMessageId: 'request-1', sessionId: 'session:self-agent:mobile', ownerAccountId: 'owner', requesterAccountId: 'owner', prompt: 'Test', idempotencyKey: 'request-1' };
  const first = await acquireDesktopExecutionLease(client, 'token', input);
  try {
    assert.ok(first);
    assert.equal(await acquireDesktopExecutionLease(client, 'token', input), null);
    await first.publisher.sendMessage('token', 'owner', 'response', { clientMessageId: 'response-id' });
    assert.deepEqual(actions, ['claim', 'claim', 'run-a/progress']);
  } finally { first?.dispose(); }
});
