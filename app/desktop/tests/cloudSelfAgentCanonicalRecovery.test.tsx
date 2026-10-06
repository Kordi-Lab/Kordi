import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type {
  AppendCanonicalMessageRequest, CanonicalSessionMessage,
  CanonicalSessionState, OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
} from '../src/kordi-app/types';
import type { ChatSyncConversation, ChatSyncMessage, CloudAccount } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudMessageFromChatSync, chatTextContent } from '../src/features/cloud/chatSyncMapping';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { useCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudSelfAgentCanonicalSync';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const account: CloudAccount = {
  accountId: 'acct_recovery', displayName: 'Recovery test',
  primaryEmail: 'recovery@example.test', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'synthetic', passwordSet: true,
};
const sessionId = 'session:self-agent:recovery';
const conversation = {
  id: 'conversation-recovery', kind: 'ai', legacy_session_id: sessionId,
  latest_message_sequence: 2, members: [],
  preferences: { account_id: account.accountId },
} as ChatSyncConversation;

function wireMessage(sequence: number, response = false): ChatSyncMessage {
  const text = response
    ? encodeCloudAgentResponse({ requestId: 'wire-1', text: 'Hello!', deliveryState: 'complete' })
    : `Request ${sequence}`;
  return {
    id: `wire-${sequence}`, client_message_id: `client-${sequence}`,
    conversation_id: conversation.id, conversation_sequence: sequence,
    sender_account_id: account.accountId, kind: 'text', content: chatTextContent(text, []),
    attachment_ids: [], version: 1, created_at: new Date(sequence * 1000).toISOString(),
    edited_at: null, deleted_at: null,
  } as ChatSyncMessage;
}

function initialState(): CanonicalSessionState {
  return {
    storagePath: '/tmp/synthetic-recovery',
    profile: {
      id: 'synthetic', humanIdentityId: 'human:recovery', displayName: 'Recovery test',
      storageRoot: '/tmp/synthetic-recovery', createdAtMs: 1, updatedAtMs: 1,
    },
    identities: [{
      id: `agent:cloud-self:${account.accountId}`, kind: 'agent', displayName: 'Kordi',
      createdAtMs: 1, updatedAtMs: 1,
    }],
    sessions: [], messages: [], participants: [], delegatedExchanges: [],
    presence: [], contextSnapshots: [],
  };
}

function nativeFixture(messages = [wireMessage(1), wireMessage(2, true)], seed = initialState(), durable = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let historyReady = true;
  let settled = 0;
  let coverageReads = 0;
  const warnings: unknown[] = [];
  const pageRequests: Array<{ afterSequence: number; limit: number }> = [];
  const stored = new Map<string, CanonicalSessionMessage>(seed.messages.map((message) => [message.id, message]));
  let state = seed;
  const currentConversation = { ...conversation, latest_message_sequence: messages.length };
  const latest = messages.length ? [cloudMessageFromChatSync(messages.at(-1)!, currentConversation, account.accountId)] : [];
  const head = { [account.accountId]: latest };
  const empty = {};
  const index = buildCloudMessageIndex(account.accountId, head);
  const forks = {};
  const titles = {};
  const onSettled = () => { settled += 1; };
  const reportWarning = (_message: string, error: unknown) => { warnings.push(error); };
  mockIPC((command, payload) => {
    if (command === 'desktop_chat_sync_conversations') return historyReady && messages.length ? [currentConversation] : [];
    if (command === 'desktop_chat_sync_coverage') {
      coverageReads += 1;
      return historyReady && messages.length ? [{
        conversationId: conversation.id, earliestSequence: 1,
        latestSequence: messages.length, messageCount: messages.length,
      }] : [];
    }
    if (command === 'desktop_chat_sync_recovery_message_ids') {
      return { conversationId: conversation.id, messageIds: messages.map(message => message.id) };
    }
    if (command === 'desktop_canonical_existing_message_sources') return durable
      ? messages.map((message) => ({ sourceTransport: 'cloud-self-agent', sourceEventId: message.id })) : [];
    if (command === 'desktop_chat_sync_messages_page') {
      const afterSequence = Number(payload?.afterSequence ?? 0);
      const limit = Number(payload?.limit);
      pageRequests.push({ afterSequence, limit });
      const page = messages.filter(message => message.conversation_sequence > afterSequence).slice(0, limit);
      const nextAfterSequence = page.at(-1)?.conversation_sequence ?? null;
      return {
        conversationId: conversation.id, messages: page, nextAfterSequence,
        hasMore: nextAfterSequence !== null && nextAfterSequence < messages.length,
      };
    }
    if (command === 'desktop_canonical_upsert_identity_fast') {
      const request = payload?.request as UpsertCanonicalIdentityRequest;
      return { ...request, createdAtMs: 1, updatedAtMs: 1 };
    }
    if (command === 'desktop_canonical_open_or_create_session_fast') {
      const request = payload?.request as OpenCanonicalSessionRequest;
      return { session: { ...request, status: 'active', createdAtMs: 1, updatedAtMs: 1 }, participants: [] };
    }
    if (command === 'desktop_canonical_upsert_message_fast') {
      const request = payload?.request as AppendCanonicalMessageRequest;
      assert.ok(request.id);
      const message = {
        ...request, id: request.id, status: request.status ?? 'sent',
        createdAtMs: request.createdAtMs ?? 1, updatedAtMs: request.createdAtMs ?? 1,
        sequenceNum: stored.get(request.id)?.sequenceNum ?? stored.size + 1,
      } as CanonicalSessionMessage;
      stored.set(message.id, message);
      return message;
    }
    if (command === 'desktop_canonical_reconcile_message_mirror') return false;
    throw new Error(`Unexpected synthetic IPC: ${command}`);
  });
  const root = createRoot(document.getElementById('root')!);
  function Harness({ bootstrapped, showHead }: { bootstrapped: boolean; showHead: boolean }) {
    const [current, setCurrent] = useState<CanonicalSessionState | null>(seed);
    state = current!;
    useCloudSelfAgentCanonicalSync({
      account, agentDisplayName: 'Kordi', canonicalState: current, setCanonicalState: setCurrent,
      messagesByPeer: showHead ? head : empty, messageIndex: index,
      forksBySessionId: forks, titlesBySessionId: titles,
      headMessagesReady: showHead || bootstrapped,
      authoritativeMessagesReady: bootstrapped, onSettled, reportWarning,
    });
    return null;
  }
  return {
    get state() { return state; },
    get settled() { return settled; },
    get coverageReads() { return coverageReads; },
    warnings, pageRequests, stored,
    setHistoryReady(ready: boolean) { historyReady = ready; },
    async render(bootstrapped: boolean, showHead = true) {
      await act(async () => { root.render(<Harness bootstrapped={bootstrapped} showHead={showHead} />); });
    },
    async close() {
      await act(async () => { root.unmount(); });
      clearMocks();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

test('a compact assistant reply cannot block recovery of its earlier user request', async () => {
  const view = nativeFixture();
  try {
    await view.render(true);
    await waitForReactCondition(() => view.settled > 0, 'Full history did not settle after importing the reply');
    assert.deepEqual(view.warnings, []);
    assert.equal(view.state.messages.filter(message => message.senderRole === 'user').length, 1);
    assert.equal(view.state.messages.filter(message => message.senderRole === 'owned-agent').length, 1);
    assert.equal(view.pageRequests.length, 1);
  } finally { await view.close(); }
});

test('cached heads remain interactive but history recovery waits for authoritative bootstrap', async () => {
  const view = nativeFixture();
  try {
    await view.render(false);
    await waitForReactCondition(() => view.state.messages.length === 1, 'Cached reply was not imported');
    assert.equal(view.settled, 0);
    assert.equal(view.coverageReads, 0);
    await view.render(true);
    await waitForReactCondition(() => view.settled > 0, 'Recovery did not resume after bootstrap');
    assert.deepEqual(view.warnings, []);
    assert.equal(view.state.messages.filter(message => message.senderRole === 'user').length, 1);
  } finally { await view.close(); }
});

test('an empty cold cache cannot settle recovery before synchronized history arrives', async () => {
  const view = nativeFixture();
  try {
    view.setHistoryReady(false);
    await view.render(false, false);
    assert.equal(view.settled, 0);
    assert.equal(view.coverageReads, 0);
    view.setHistoryReady(true);
    await view.render(true);
    await waitForReactCondition(() => view.settled > 0, 'Cold history did not recover after bootstrap');
    assert.deepEqual(view.warnings, []);
    assert.equal(view.state.messages.length, 2);
  } finally { await view.close(); }
});

test('authoritative empty history settles without polling forever', async () => {
  const view = nativeFixture([]);
  try {
    await view.render(true);
    await waitForReactCondition(() => view.settled > 0, 'Authoritative empty history did not settle');
    assert.deepEqual(view.warnings, []);
    assert.equal(view.state.messages.length, 0);
    assert.equal(view.pageRequests.length, 0);
  } finally { await view.close(); }
});

test('durable history still repairs a project reply whose request link was lost', async () => {
  const seed = initialState();
  seed.sessions = [{ id: sessionId, kind: 'project', title: 'Task', projectId: 'project', projectName: 'Project', status: 'active', createdAtMs: 1, updatedAtMs: 1 }];
  seed.messages = [
    { id: 'request-local', sessionId, senderIdentityId: 'human:recovery', senderRole: 'user', messageKind: 'text', contentText: 'Request 1', content: { desktopEntryId: 'wire-1' }, sourceTransport: 'desktop-chat-ui', status: 'sent', sequenceNum: 1, createdAtMs: 1000, updatedAtMs: 1000 },
    { id: 'msg:cloud:self:response:wire-1', sessionId, senderIdentityId: `agent:cloud-self:${account.accountId}`, senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello!', content: { cloudRequestMessageId: 'wire-1' }, sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-2', parentMessageId: null, status: 'complete', sequenceNum: 2, createdAtMs: 2000, updatedAtMs: 2000 },
  ];
  const view = nativeFixture(undefined, seed, true);
  try {
    await view.render(true, false);
    await waitForReactCondition(() => view.settled > 0, 'Durable reply recovery did not settle');
    assert.deepEqual(view.warnings, []);
    assert.equal(view.pageRequests.length, 1, 'Durability alone must not skip causal repair');
    const reply = view.state.messages.find((message) => message.senderRole === 'owned-agent')!;
    assert.equal(reply.parentMessageId, 'request-local');
    assert.equal(reply.createdAtMs, 1001);
    assert.equal(view.state.sessions[0].kind, 'project');
  } finally { await view.close(); }
});

test('recovery after a compact reply imports the first request across bounded history pages', async () => {
  const messages = Array.from({ length: 205 }, (_, index) => wireMessage(index + 1, index === 204));
  const view = nativeFixture(messages);
  try {
    await view.render(true);
    await waitForReactCondition(() => view.settled > 0, 'Paged history did not settle');
    assert.deepEqual(view.warnings, []);
    assert.equal(view.state.messages.length, messages.length);
    assert.ok(view.state.messages.some(message => message.sourceEventId === 'wire-1'));
    assert.ok(view.pageRequests.every(request => request.limit === 200));
    assert.equal(view.stored.size, messages.length);
  } finally { await view.close(); }
});
