import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { CloudAccount, CloudAuthClient, ChatSyncConversation, ChatSyncMessage } from '../src/features/cloud/authClient';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudSelfAgentForwardSync } from '../src/features/cloud/useCloudSelfAgentForwardSync';
import { loadCloudSelfAgentRecoverySessionIds, loadCloudSelfAgentSyncLedger, saveCloudSelfAgentRecoverySessionIds } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { chatTextContent } from '../src/features/cloud/chatSyncMapping';

const sessionId = 'session:agent:history-replay';
const conversation = {
  id: 'conversation-history', kind: 'ai', legacy_session_id: sessionId,
  latest_message_sequence: 0, created_at: '2026-01-01T00:00:00Z',
} as ChatSyncConversation;
const request: CanonicalSessionMessage = {
  id: 'msg:cloud:self:old-request', sessionId, senderIdentityId: 'human:me',
  senderRole: 'user', messageKind: 'text', contentText: 'Synthetic old request',
  status: 'sent', sequenceNum: 1, createdAtMs: 1000, updatedAtMs: 1000,
  sourceTransport: 'cloud-self-agent', sourceEventId: 'old-request',
};
const remoteRequest = {
  id: 'old-request', client_message_id: 'original-upload-id',
  conversation_id: conversation.id, sender_account_id: 'me',
  kind: 'canonical-history-user', content: chatTextContent(request.contentText, []),
} as ChatSyncMessage;

async function runSync({
  localMessages, remoteMessages, failRead = false, passes = 1, pendingRecovery,
}: {
  localMessages: CanonicalSessionMessage[];
  remoteMessages: ChatSyncMessage[];
  failRead?: boolean;
  passes?: number;
  pendingRecovery?: 'removed' | 'archived';
}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const state = {
    sessions: [
      { id: sessionId, kind: 'self-agent', status: 'active', title: 'Synthetic history' },
      ...(pendingRecovery === 'archived' ? [{
        id: 'session:agent:obsolete', kind: 'self-agent', status: 'archived', title: 'Archived history',
      }] : []),
    ],
    identities: [], participants: [], profile: { id: 'synthetic' }, messages: localMessages,
  } as unknown as CanonicalSessionState;
  const sent: Array<{ body: string; options: unknown }> = [];
  const errors: unknown[] = [];
  let reads = 0;
  let finish!: () => void;
  if (pendingRecovery) {
    saveCloudSelfAgentRecoverySessionIds('me', new Set(['session:agent:obsolete']));
  }
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic', accountId: 'me', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  mockIPC((command) => {
    if (command === 'desktop_chat_sync_conversations') return [conversation];
    if (command === 'desktop_chat_sync_message_refs') return [];
    if (command === 'desktop_canonical_session_messages') return {
      messages: localMessages, hasOlder: false, oldestSequenceNum: 1,
    };
    throw new Error('Unexpected IPC: ' + command);
  });
  const client = {
    listChatConversationHistoryPage: async () => {
      reads += 1;
      if (failRead) throw new Error('Synthetic history failure');
      return { messages: remoteMessages, hasMore: false, nextBeforeSequence: null };
    },
    sendMessage: async (_token: string, _peer: string, body: string, options: unknown) => {
      sent.push({ body, options });
      return { messageId: 'new-' + sent.length };
    },
  } as unknown as CloudAuthClient;
  const args = {
    account: { accountId: 'me' } as CloudAccount, canonicalState: state,
    canonicalStateRef: { current: state }, initialMessagesSettled: true,
    client, cancelledRef: { current: false }, processedRequestIdsRef: { current: new Set<string>() },
    mergeMessage: () => {}, syncCloudCollaborationDiff: async () => { finish(); },
    reportWarning: (_message: string, error: unknown) => { errors.push(error); finish(); },
  };
  function Harness() { useCloudSelfAgentForwardSync(args); return null; }
  const root = createRoot(document.getElementById('root')!);
  try {
    for (let pass = 0; pass < passes; pass += 1) {
      const finished = new Promise<void>(resolve => { finish = resolve; });
      args.canonicalState = { ...state };
      await act(async () => { root.render(<Harness />); });
      await finished;
      await act(async () => {});
    }
    return {
      sent, reads, errors, ledger: loadCloudSelfAgentSyncLedger('me'),
      pending: loadCloudSelfAgentRecoverySessionIds('me'),
    };
  } finally {
    await act(async () => { root.unmount(); });
    clearMocks();
    __setSessionBackendForTests(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

test('full recovery verifies a stale zero head and does not resend an existing cloud request', async () => {
  const result = await runSync({ localMessages: [request], remoteMessages: [remoteRequest], passes: 2 });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sent, []);
  assert.equal(result.reads, 2);
  assert.equal(result.ledger[request.id]?.cloudMessageId, remoteRequest.id);
  assert.equal(result.pending.size, 0);
});

test('recovery retains the existing request as the parent of a missing historical response', async () => {
  const response: CanonicalSessionMessage = {
    ...request, id: 'local-response', senderRole: 'owned-agent', messageKind: 'agent-turn',
    contentText: 'Synthetic old response', parentMessageId: request.id, sequenceNum: 2,
    status: 'complete', sourceTransport: 'desktop-chat', sourceEventId: 'local-response',
  };
  const result = await runSync({ localMessages: [request, response], remoteMessages: [remoteRequest] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sent.length, 1);
  assert.equal(parseCloudAgentResponse(result.sent[0].body)?.requestId, remoteRequest.id);
});

test('canonical history metadata reconciles an older upload ID without comparing text', async () => {
  const local = { ...request, id: 'original-local-request', sourceTransport: 'desktop-chat', sourceEventId: 'local-event' };
  const remote = { ...remoteRequest, content: chatTextContent('Edited remotely', [], {
    localMessageId: local.id, originalCreatedAt: new Date(local.createdAtMs).toISOString(),
  }) };
  const result = await runSync({ localMessages: [local], remoteMessages: [remote] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sent, []);
  assert.equal(result.ledger[local.id]?.cloudMessageId, remote.id);
});

test('failed authoritative history read publishes nothing and leaves recovery pending', async () => {
  const result = await runSync({ localMessages: [request], remoteMessages: [], failRead: true });
  assert.equal(result.reads, 1);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.sent, []);
  assert.equal(result.pending.has(sessionId), true);
});

test('two intentional requests with identical text remain distinct during recovery', async () => {
  const second = { ...request, id: 'second-local-request', sourceTransport: 'desktop-chat',
    sourceEventId: 'second-send', createdAtMs: 2000, sequenceNum: 2 };
  const result = await runSync({ localMessages: [request, second], remoteMessages: [remoteRequest] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].body, request.contentText);
});

test('an authoritative empty history still recovers the missing local request', async () => {
  const result = await runSync({ localMessages: [request], remoteMessages: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.reads, 1);
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].body, request.contentText);
  assert.equal(result.pending.size, 0);
});

for (const pendingRecovery of ['removed', 'archived'] as const) {
  test(`unfinished recovery for ${pendingRecovery} sessions cannot block an active session`, async () => {
    const result = await runSync({ localMessages: [request], remoteMessages: [], pendingRecovery });
    assert.deepEqual(result.errors, []);
    assert.equal(result.reads, 1);
    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].body, request.contentText);
    assert.equal(result.pending.size, 0);
  });
}
