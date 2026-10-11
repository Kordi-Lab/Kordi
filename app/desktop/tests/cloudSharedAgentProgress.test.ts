import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { buildCloudDesktopCollaborationState } from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { createCloudSharedAgentProgress } from '../src/features/cloud/cloudSharedAgentProgress';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const account: CloudAccount = {
  accountId: 'acct_owner', displayName: 'Owner', primaryEmail: 'owner@example.com',
  avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: 'node_owner', passwordSet: true,
};
const peer = cloudContactToContact({
  accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null,
  nodeId: 'node_peer', createdAt: '2026-10-09T00:00:00Z',
});

function wire(id: string, body: string, createdAtMs: number): CloudMessage {
  return {
    messageId: id, fromAccountId: 'acct_owner', toAccountId: 'acct_peer', body,
    createdAt: new Date(createdAtMs).toISOString(), deliveredAt: null, readAt: null,
    direction: 'outgoing',
  };
}

function rowsFor(requestId: string, messages: CloudMessage[]) {
  // Another Mac of the owner: no local turn, only synced rows.
  const state = buildCloudDesktopCollaborationState({
    account, contacts: [peer], messagesByPeer: { acct_peer: messages },
  });
  const ids = new Set(state.conversations[0].messages
    .filter((row) => row.requestId === requestId && row.id !== requestId).map((row) => row.id));
  return mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi')
    .messages.filter((row) => ids.has(row.id.split(':').at(-1) ?? ''));
}

test('a mention run in a person chat publishes processing at admission and the reply replaces it', async () => {
  const startMs = Date.now();
  let nowMs = startMs;
  const request = wire('msg_request', encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: '@Kordi what is the disk usage',
    targetCloudAgentId: 'cloud-agent:acct_owner', targetCloudAgentName: 'Kordi',
    targetCloudAgentOwnerAccountId: 'acct_owner',
  }), startMs);
  const published: CloudMessage[] = [];
  const clientMessageIds: string[] = [];
  const progress = createCloudSharedAgentProgress({
    requestId: request.messageId,
    publish: async (body, clientMessageId) => {
      clientMessageIds.push(clientMessageId);
      return wire(`msg_progress_${published.length}`, body, nowMs);
    },
    onPublished: (message) => { published.push(message); },
    onError: (error) => { throw error; },
    now: () => nowMs,
  });

  progress.start();
  nowMs += 6_000;
  progress.update({
    id: 'turn_1', sessionId: 'runtime', prompt: 'what is the disk usage', status: 'running',
    message: '', assistantText: '', thinkingText: 'Checking the volumes', tools: [],
    completed: false, succeeded: false, startedAtMs: startMs,
  } as DesktopChatTurnSnapshot);
  await progress.finish();

  assert.deepEqual(clientMessageIds, ['shared:msg_request:processing', 'shared:msg_request:execution:1']);
  const first = parseCloudAgentResponse(published[0].body);
  const second = parseCloudAgentResponse(published[1].body);
  assert.equal(first?.deliveryState, 'processing');
  assert.equal(first?.requestId, request.messageId);
  assert.equal(first?.execution?.phase, 'preparing');
  assert.equal(second?.execution?.phase, 'analyzing');
  assert.equal(second?.execution?.summary, 'Analyzing the request');
  // Shared chats never carry the owner's private trace.
  assert.equal(second?.execution?.thinkingText, undefined);
  assert.deepEqual(second?.execution?.steps, []);

  const whileRunning = rowsFor(request.messageId, [request, ...published]);
  assert.equal(whileRunning.length, 1);
  assert.equal(whileRunning[0].role, 'owned-agent');
  assert.equal(whileRunning[0].turn?.status, 'processing');

  const reply = wire('msg_reply', encodeCloudAgentResponse({
    requestId: request.messageId, text: 'About 40% used.', deliveryState: 'complete',
  }), nowMs + 1_000);
  const afterReply = rowsFor(request.messageId, [request, ...published, reply]);
  assert.equal(afterReply.length, 1);
  assert.match(afterReply[0].id, /:msg_reply$/);
  assert.equal(afterReply[0].turn?.assistantText, 'About 40% used.');
  assert.equal(afterReply[0].turn?.status, 'complete');
});

test('finished progress publishes nothing more', async () => {
  const calls: string[] = [];
  const progress = createCloudSharedAgentProgress({
    requestId: 'msg_done',
    publish: async (body, clientMessageId) => { calls.push(clientMessageId); return wire('x', body, Date.now()); },
    onPublished: () => undefined,
    onError: (error) => { throw error; },
  });
  progress.start();
  await progress.finish();
  progress.update({ id: 't', status: 'running', assistantText: 'Hi', thinkingText: '', tools: [], completed: false } as unknown as DesktopChatTurnSnapshot);
  await progress.finish();
  assert.deepEqual(calls, ['shared:msg_done:processing']);
});

test('direct mention execution publishes processing on admission, before the runtime starts', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudDirectAgentExecution.ts', import.meta.url), 'utf8');
  const admitted = source.indexOf('if (!await lease.admitted()) return;');
  const started = source.indexOf('progress.start();');
  const runtime = source.indexOf('await startDesktopSharedChatMessage(');
  assert.ok(admitted > 0 && admitted < started && started < runtime);
  assert.match(source, /lease\.onStopRequested\(/);
  assert.doesNotMatch(source, /if \(replyMessageAction\) \{\s*await lease\.publisher/);
});
