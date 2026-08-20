import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  cloudAgentExecutionFingerprint,
  cloudAgentExecutionSnapshotFromTurn,
} from '../src/features/cloud/cloudAgentExecutionTrace';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import {
  buildCloudDesktopCollaborationState,
  cloudMessageToCollaborationMessage,
} from '../src/features/cloud/cloudCollaborationState';

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Mayas', primaryEmail: 'taylor@example.com',
  avatarUrl: null,
    avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};

test('owner execution snapshots stream the real redacted trajectory to the owners devices', () => {
  const execution = cloudAgentExecutionSnapshotFromTurn({
    id: 'turn_1', sessionId: 'session:self', prompt: 'private prompt', status: 'tool',
    message: '', assistantText: '', thinkingText: 'private model reasoning',
    tools: [{
      id: 'tool_1', name: 'web_search', status: 'running', arguments: '{"secret":"query"}',
      liveOutput: 'private search output', isError: false,
    }],
    completed: false, succeeded: false, startedAtMs: 1_000,
  }, 2_000);
  const encoded = encodeCloudAgentResponse({
    requestId: 'msg_request', text: 'processing...', deliveryState: 'processing', execution,
  });
  assert.deepEqual(parseCloudAgentResponse(encoded)?.execution, execution);
  assert.equal(encoded.includes('private prompt'), false);
  assert.equal(execution.thinkingText, 'private model reasoning');
  assert.equal(execution.tools?.[0]?.liveOutput, 'private search output');
  assert.equal(execution.tools?.[0]?.arguments, '{"secret":"[redacted]"}');
  assert.equal(execution.summary, 'Searching');
  assert.deepEqual(execution.steps.map((step) => step.label), ['private model reasoning', 'Searching']);
});

test('owner execution snapshots include a redacted command summary', () => {
  const execution = cloudAgentExecutionSnapshotFromTurn({
    id: 'turn_command', sessionId: 'session:self', prompt: '', status: 'tool',
    message: '', assistantText: '', thinkingText: 'provider reasoning',
    tools: [{
      id: 'tool_shell', name: 'Bash', status: 'running',
      arguments: JSON.stringify({ command: 'TOKEN=top-secret df -h /System/Volumes/Data' }),
      liveOutput: '', isError: false,
    }],
    completed: false, succeeded: false, startedAtMs: 1_000,
  }, 2_000);
  assert.equal(execution.steps[0]?.label, 'provider reasoning');
  assert.match(execution.steps[1]?.label ?? '', /Running command:/);
  assert.equal(JSON.stringify(execution).includes('top-secret'), false);
});

test('owner execution progress changes when partial assistant output grows', () => {
  const execution = cloudAgentExecutionSnapshotFromTurn({
    id: 'turn_writing', sessionId: 'session:self', prompt: '', status: 'writing',
    message: '', assistantText: 'First', thinkingText: '', tools: [],
    completed: false, succeeded: false, startedAtMs: 1_000,
  }, 2_000);

  assert.notEqual(
    cloudAgentExecutionFingerprint(execution, 'First'),
    cloudAgentExecutionFingerprint(execution, 'First and second'),
  );
});

test('synced execution timeline renders only for the owning self-agent account', () => {
  const execution = cloudAgentExecutionSnapshotFromTurn({
    id: 'turn_1', sessionId: 'session:self', prompt: '', status: 'thinking', message: '',
    assistantText: '', thinkingText: 'provider reasoning', tools: [], completed: false, succeeded: false,
  }, 2_000);
  const body = encodeCloudAgentResponse({
    requestId: 'msg_request', text: 'processing...', deliveryState: 'processing', execution,
  });
  const message = (fromAccountId: string, sessionId: string) => cloudMessageToCollaborationMessage(account, {
    messageId: `msg_${fromAccountId}`, fromAccountId, toAccountId: 'acct_me', body,
    createdAt: '2026-05-11T10:00:01Z', deliveredAt: null, readAt: null,
    direction: fromAccountId === 'acct_me' ? 'outgoing' : 'incoming', sessionId,
  });
  assert.equal(message('acct_me', 'session:self').localTurn?.thinkingText, 'provider reasoning');
  assert.equal(message('acct_peer', 'session:direct').localTurn, null);
});

test('desktop owner view replaces earlier processing rows with the latest streamed execution snapshot', () => {
  const nowMs = Date.now();
  const request: CloudMessage = {
    messageId: 'msg_request', fromAccountId: account.accountId, toAccountId: account.accountId,
    body: 'Check the latest rollout status', createdAt: new Date(nowMs - 4_000).toISOString(),
    deliveredAt: null, readAt: null, direction: 'outgoing', sessionId: 'session:self-stream',
  };
  const response = (
    messageId: string, createdAt: string, summary: string, phase: 'analyzing' | 'using-tool',
    text = 'processing...',
  ): CloudMessage => ({
    ...request, messageId, createdAt,
    body: encodeCloudAgentResponse({
      requestId: request.messageId, text, deliveryState: 'processing',
      execution: {
        phase, summary, steps: [{
          id: phase === 'analyzing' ? 'analysis' : 'tool:web-search', label: summary, state: 'running',
        }],
        updatedAtMs: Date.parse(createdAt), completed: false,
      },
    }),
  });
  const state = buildCloudDesktopCollaborationState({
    account, contacts: [], messagesByPeer: { [account.accountId]: [
      request,
      response('msg_execution_1', new Date(nowMs - 3_000).toISOString(), 'Analyzing the request', 'analyzing'),
      response(
        'msg_execution_2',
        new Date(nowMs - 2_000).toISOString(),
        'Using Web Search',
        'using-tool',
        'The rollout is nearly ready.',
      ),
      response(
        'msg_execution_3',
        new Date(nowMs - 1_000).toISOString(),
        'Using Web Search',
        'using-tool',
        'The rollout',
      ),
    ] },
  });
  const executionRows = state.conversations[0]?.messages.filter(
    (message) => message.requestId === request.messageId && message.direction === 'outbound-response',
  ) ?? [];
  assert.equal(executionRows.length, 1);
  assert.equal(executionRows[0]?.id, 'msg_execution_2');
  assert.equal(executionRows[0]?.text, 'The rollout is nearly ready.');
  assert.equal(
    executionRows[0]?.localTurn?.assistantText,
    'The rollout is nearly ready.',
  );
  assert.equal(executionRows[0]?.localTurn?.message, 'Using Web Search');
});
