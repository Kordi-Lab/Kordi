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
} from '../src/features/cloud/cloudAgentMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { publishCloudSelfAgentExecutionClaim } from '../src/features/cloud/cloudSelfAgentForwardExecution';
import {
  cloudSelfAgentExecutionCanStart,
  cloudSelfAgentHasTerminalResponse,
  cloudSelfAgentTerminalResponseRequestIds,
  omitTerminalCloudSelfAgentLocalTurns,
  pendingCloudSelfAgentExecutionRequests,
} from '../src/features/cloud/useCloudSelfAgentExecution';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

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

test('self-agent desktop claim elects one Mac through the stable Cloud client message id', async () => {
  const messagesByClientId = new Map<string, CloudMessage>();
  const client = {
    async sendMessage(
      _token: string,
      accountId: string,
      body: string,
      options: {
        sessionId?: string | null;
        clientCreatedAt?: string | null;
        clientMessageId?: string | null;
      },
    ): Promise<CloudMessage> {
      const clientMessageId = options.clientMessageId ?? '';
      const existing = messagesByClientId.get(clientMessageId);
      if (existing) return existing;
      const created = message('claim-message', body);
      messagesByClientId.set(clientMessageId, created);
      return created;
    },
  };
  const execution = {
    phase: 'preparing' as const,
    summary: 'Preparing the response',
    steps: [],
    updatedAtMs: 1_000,
    completed: false,
  };
  const claim = (claimId: string) => publishCloudSelfAgentExecutionClaim({
    accountId: account.accountId,
    claimId,
    client,
    cloudRequestMessageId: 'request-1',
    execution,
    nowMs: 1_000,
    sessionId: 'session:self-agent:mobile',
    token: 'token',
  });

  const first = await claim('mac-a');
  const second = await claim('mac-b');

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(messagesByClientId.size, 1);
});
