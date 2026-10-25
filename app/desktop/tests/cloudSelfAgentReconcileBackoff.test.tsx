import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { CloudAccount, CloudAuthClient, ChatSyncConversation } from '../src/features/cloud/authClient';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudSelfAgentForwardSync } from '../src/features/cloud/useCloudSelfAgentForwardSync';
import { saveCloudSelfAgentForwardBaseline, saveCloudSelfAgentForwardCutoff } from '../src/features/cloud/cloudSelfAgentForwardSync';

// Issue #2026: a reconcile that keeps failing (here a request the server
// rejects, as a server without object storage rejects an upload) must not hold
// a newly sent message until the 30-second reconcile retry.

const sessionId = 'session:agent:reconcile-backoff';
const conversation = {
  id: 'conversation-backoff', kind: 'ai', legacy_session_id: sessionId,
  latest_message_sequence: 0, created_at: '2026-01-01T00:00:00Z',
} as ChatSyncConversation;
const startedAtMs = Date.now();
const userMessage = (id: string, text: string, offsetMs: number): CanonicalSessionMessage => ({
  id, sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: text,
  content: { deliveryState: 'sent' }, parentMessageId: null, delegatedExchangeId: null, status: 'sent',
  sequenceNum: offsetMs, createdAtMs: startedAtMs + offsetMs, updatedAtMs: startedAtMs + offsetMs,
  sourceTransport: 'desktop-chat-ui', sourceEventId: id,
});
const stuck = userMessage('msg:ui:stuck', 'Synthetic request the server rejects', 1_000);
const fresh = userMessage('msg:ui:fresh', 'Synthetic request sent after the failure', 2_000);
const stateWith = (messages: CanonicalSessionMessage[]) => ({
  sessions: [{ id: sessionId, kind: 'self-agent', status: 'active', title: 'Synthetic chat' }],
  identities: [], participants: [], profile: { id: 'synthetic' }, messages,
}) as unknown as CanonicalSessionState;

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  return condition();
}

test('a failing reconcile does not hold a newly sent message until its retry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  saveCloudSelfAgentForwardCutoff('me', startedAtMs);
  saveCloudSelfAgentForwardBaseline('me');
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic', accountId: 'me', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  mockIPC((command) => {
    if (command === 'desktop_chat_sync_conversations') return [conversation];
    if (command === 'desktop_chat_sync_message_refs') return [];
    if (command === 'desktop_canonical_session_messages') return {
      messages: args.canonicalState.messages, hasOlder: false, oldestSequenceNum: 1,
    };
    throw new Error('Unexpected IPC: ' + command);
  });
  const attempts: string[] = [];
  const sent: string[] = [];
  const errors: unknown[] = [];
  const client = {
    listChatConversationHistoryPage: async () => ({ messages: [], hasMore: false, nextBeforeSequence: null }),
    sendMessage: async (_token: string, _peer: string, body: string) => {
      attempts.push(body);
      if (body === stuck.contentText) throw new Error('Object storage is not configured on this server.');
      sent.push(body);
      return { messageId: 'wire-' + attempts.length };
    },
  } as unknown as CloudAuthClient;
  const args = {
    account: { accountId: 'me' } as CloudAccount, canonicalState: stateWith([stuck]),
    canonicalStateRef: { current: stateWith([stuck]) as CanonicalSessionState | null }, initialMessagesSettled: true,
    client, cancelledRef: { current: false }, processedRequestIdsRef: { current: new Set<string>() },
    mergeMessage: () => {}, syncCloudCollaborationDiff: async () => {},
    reportWarning: (_message: string, error: unknown) => { errors.push(error); },
  };
  function Harness() { useCloudSelfAgentForwardSync(args); return null; }
  const root = createRoot(document.getElementById('root')!);
  const render = async (messages: CanonicalSessionMessage[]) => {
    args.canonicalState = stateWith(messages);
    args.canonicalStateRef.current = args.canonicalState;
    await act(async () => { root.render(<Harness />); });
  };
  try {
    await render([stuck]);
    assert.ok(await waitFor(() => errors.length === 1), 'the first reconcile fails');
    // The owner sends another message well inside the 30-second retry window.
    await render([stuck, fresh]);
    assert.ok(await waitFor(() => sent.includes(fresh.contentText)), 'the new message is forwarded at once ' + JSON.stringify({attempts, errors: errors.map(String)}));
    // A state change with nothing new to send still waits out the retry window.
    const stuckAttempts = attempts.filter((body) => body === stuck.contentText).length;
    await render([stuck, fresh]);
    await waitFor(() => false, 200);
    assert.equal(attempts.filter((body) => body === stuck.contentText).length, stuckAttempts, 'the failing reconcile keeps its backoff');
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
});
