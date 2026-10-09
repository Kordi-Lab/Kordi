import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useChatMessageActions } from '../src/features/chat/messageActions/chatMessages';
import type { UseChatMessageActionsArgs } from '../src/features/chat/messageActions/types';
import type { CanonicalSessionState, DesktopChatState, QueuedDesktopChatMessage } from '../src/kordi-app/types';

const sessionId = 'synthetic-hosted-chat';
const route = { model: 'openai/gpt-6-sol', thinking: 'medium', authProvider: 'openai-codex', authChoice: 'cloud-login:synthetic' };
const noop = () => undefined;

function queued(id: string, text: string): QueuedDesktopChatMessage {
  return { id, createdAtMs: Date.now(), sessionId, scope: 'chat', text, time: '09:24', attachments: [], runtimeRoute: route };
}

function agentResponse(requestId: string, status: 'processing' | 'complete' | 'failed' | 'cancelled') {
  return {
    id: `synthetic-response:${requestId}`, sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: status === 'complete' ? 'Done.' : '', status,
    content: { requestId, replyToMessageId: requestId, deliveryState: status }, parentMessageId: requestId,
    createdAtMs: Date.now(), updatedAtMs: Date.now(), sequenceNum: 2, sourceTransport: 'cloud-self-agent',
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

async function settle() {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
}

for (const terminal of ['complete', 'failed', 'cancelled'] as const) test(`queued hosted messages wait for the previous run to be ${terminal}`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  const session = { id: sessionId, kind: 'self-agent', status: 'active', title: 'hiiii',
    primaryIdentityId: 'agent:me', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 };
  const initialCanonical = { profile: { id: 'synthetic', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me' },
    identities: [{ id: 'human:me', kind: 'human' }, { id: 'agent:me', kind: 'agent' }], sessions: [session],
    participants: [{ sessionId, identityId: 'human:me', state: 'active' }], messages: [],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as unknown as CanonicalSessionState;
  const desktop = { activeSessionId: sessionId, activeSession: { id: sessionId, messages: [], messageCount: 0, title: 'hiiii' },
    sessions: [], projects: [] } as unknown as DesktopChatState;
  const dispatched: string[] = [];
  const errors: string[] = [];
  mockIPC((command, payload) => {
    if (command === 'desktop_chat_session_active_turn') return null;
    if (command === 'desktop_canonical_upsert_message_fast') {
      const request = (payload as { request: Record<string, unknown> }).request;
      const content = request.content as Record<string, unknown> | null;
      if (request.status === 'sent' && content?.agentRuntimeRoute) dispatched.push(String(request.id));
      return { ...request, sequenceNum: 1, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    }
    if (command === 'desktop_chat_start_message') throw new Error('Hosted requests must use leased admission');
    throw new Error('Unexpected IPC: ' + command);
  });
  let setCanonical!: React.Dispatch<React.SetStateAction<CanonicalSessionState | null>>;
  function Harness() {
    const [canonical, setCanonicalState] = useState<CanonicalSessionState | null>(initialCanonical);
    const [queue, setQueue] = useState<Record<string, QueuedDesktopChatMessage[]>>({
      [sessionId]: [queued('queued-first', 'dhqidhqio'), queued('queued-second', 'dhqhiqiq')],
    });
    setCanonical = setCanonicalState;
    useChatMessageActions({
      activeConvId: sessionId, activeConvCanonicalSessionId: sessionId,
      activeConversationUsesCollaboration: false, activeConvCollaborationTarget: null, activeConvMentionScope: null,
      activeConvMessages: [], chatConversations: [], isNativeShell: true, hasAnyDesktopAuth: true, hasConfiguredProviderAuth: true,
      canonicalHumanIdentityId: 'human:me', canonicalSessionState: canonical, desktopChatState: desktop,
      desktopCollaborationState: null, desktopLiveTurn: null, queuedDesktopMessagesBySession: queue,
      composerDrafts: { chat: '', project: '' }, composerSelections: { chat: { mode: 'agent', model: route.model, thinking: route.thinking } },
      chatComposerAttachments: [], selectedChatAgentMentionRef: { current: null }, localChatSendInFlightRef: localChatSendInFlight,
      shouldAutoFollowChatRef: { current: false }, attachmentSummaryText: (text: string) => text,
      resolveChatRuntimeRoute: () => route, sendCloudCollaborationMessage: async () => { throw new Error('No collaboration send'); },
      handleLocalSlashCommand: async () => false, setComposerDrafts: noop, setActiveConvId: noop,
      setCanonicalSessionState: setCanonicalState, setChatComposerAttachments: noop, setCloudCollaborationState: noop,
      setDesktopChatError: (error: string | null) => { if (error) errors.push(error); },
      setDesktopChatState: noop, setDesktopLiveTurnsBySession: noop, setIsDesktopChatSending: noop, setOpenComposerSelector: noop,
      setPendingUserChatMessage: noop, setQueuedDesktopMessagesBySession: setQueue,
    } as unknown as UseChatMessageActionsArgs);
    return null;
  }
  const localChatSendInFlight = { current: null };
  const respond = (requestId: string, status: 'processing' | 'complete' | 'failed' | 'cancelled') => act(async () => {
    setCanonical((current) => current && ({
      ...current,
      messages: [...current.messages.filter(message => message.id !== `synthetic-response:${requestId}`),
        agentResponse(requestId, status) as unknown as CanonicalSessionState['messages'][number]],
    }));
  });
  try {
    await act(async () => root.render(<Harness />));
    await waitFor(() => dispatched.length > 0);
    assert.deepEqual(dispatched, ['queued-first']);
    await settle();
    assert.deepEqual(dispatched, ['queued-first'], 'the second queued message waits while the first hosted run is active');

    await respond('queued-first', 'processing');
    await settle();
    assert.deepEqual(dispatched, ['queued-first'], 'a streaming response is not a terminal state');

    await respond('queued-first', terminal);
    await waitFor(() => dispatched.length > 1);
    assert.deepEqual(dispatched, ['queued-first', 'queued-second']);
    assert.deepEqual(errors, []);
  } finally {
    await act(async () => root.unmount());
    clearMocks(); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
