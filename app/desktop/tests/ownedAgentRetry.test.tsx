import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useChatMessageActions } from '../src/features/chat/messageActions/chatMessages';
import { retiredFailedCanonicalRequest } from '../src/features/chat/messageActions/retriedOwnedAgentRequest';
import type { UseChatMessageActionsArgs } from '../src/features/chat/messageActions/types';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { canonicalMessageCountsAsReadable } from '../src/features/canonical/readModel/messageVisibility';
import type { CanonicalSessionMessage, CanonicalSessionState, DesktopChatState, Message } from '../src/kordi-app/types';

const sessionId = 'synthetic-owned-agent-session';
const failedMessageId = 'msg:ui:synthetic-failed';
const failedText = 'Summarize the release notes';
const noop = () => undefined;

function failedCanonicalMessage(): CanonicalSessionMessage {
  return {
    id: failedMessageId, sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text',
    contentText: failedText, content: { sender: 'Me', timeLabel: '09:00', deliveryState: 'failed', detail: 'Network unavailable' },
    parentMessageId: null, delegatedExchangeId: null, status: 'failed', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1,
    contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: `desktop-chat-ui:${sessionId}:1`,
  } as CanonicalSessionMessage;
}

type RetryScenario = { activeTurn?: boolean; collaboration?: boolean };

async function retryFailedRequest({ activeTurn = false, collaboration = false }: RetryScenario = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  const session = { id: sessionId, kind: 'self-agent', status: 'active', title: 'Release notes',
    primaryIdentityId: 'agent:me', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 };
  let canonical = { profile: { id: 'synthetic', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me' },
    identities: [{ id: 'human:me', kind: 'human' }, { id: 'agent:me', kind: 'agent' }], sessions: [session],
    participants: [{ sessionId, identityId: 'human:me', state: 'active' }], messages: [failedCanonicalMessage()],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as unknown as CanonicalSessionState;
  const desktop = { activeSessionId: sessionId, activeSession: { id: sessionId, messages: [], messageCount: 1, title: 'Release notes' },
    sessions: [], projects: [] } as unknown as DesktopChatState;
  const errors: string[] = [];
  const appended: Array<Record<string, unknown>> = [];
  const upserted: Array<Record<string, unknown>> = [];
  const started: string[] = [];
  const queued: string[] = [];
  let composerCleared = false;
  mockIPC((command, payload) => {
    const request = (payload as { request?: Record<string, unknown> } | undefined)?.request ?? {};
    if (command === 'desktop_chat_session_active_turn') return activeTurn ? { id: 'turn:running', sessionId, completed: false } : null;
    if (command === 'desktop_canonical_append_message_fast') {
      appended.push(request);
      return { ...request, sequenceNum: 2, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    }
    if (command === 'desktop_canonical_upsert_message_fast') {
      upserted.push(request);
      if ((request.content as Record<string, unknown> | undefined)?.queuedMessage === true) queued.push(String(request.contentText));
      return { ...request, sequenceNum: 2, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    }
    // The running turn never settles here, so the queued retry stays queued for the assertions.
    if (command === 'desktop_chat_turn_state') return new Promise(noop);
    if (command === 'desktop_chat_start_message') {
      started.push(String((payload as { text?: string }).text ?? ''));
      return { id: 'turn:retry', sessionId, completed: false, succeeded: false, assistantText: '', status: 'running' };
    }
    throw new Error('Unexpected IPC: ' + command);
  });
  const args = {
    activeConvId: sessionId, activeConvCanonicalSessionId: sessionId,
    activeConversationUsesCollaboration: collaboration, activeConvCollaborationTarget: null, activeConvMentionScope: null,
    activeConvMessages: [], chatConversations: [], isNativeShell: true, hasAnyDesktopAuth: true, hasConfiguredProviderAuth: true,
    canonicalHumanIdentityId: 'human:me', canonicalSessionState: canonical, desktopChatState: desktop,
    desktopCollaborationState: null, desktopLiveTurn: null, queuedDesktopMessagesBySession: {},
    composerDrafts: { chat: 'An unsent draft', project: '' }, composerSelections: { chat: { mode: 'agent', model: 'synthetic-model', thinking: 'medium' } },
    chatComposerAttachments: [], selectedChatAgentMentionRef: { current: null }, localChatSendInFlightRef: { current: null },
    shouldAutoFollowChatRef: { current: false }, attachmentSummaryText: (text: string) => text, resolveChatRuntimeRoute: () => null,
    handleLocalSlashCommand: async () => false, refreshDesktopChat: async () => desktop, watchDesktopLiveTurn: async () => undefined,
    setComposerDrafts: () => { composerCleared = true; }, setActiveConvId: noop,
    setCanonicalSessionState: (update: React.SetStateAction<CanonicalSessionState | null>) => { canonical = (typeof update === 'function' ? update(canonical) : update) ?? canonical; },
    setChatComposerAttachments: () => { composerCleared = true; }, setCloudCollaborationState: noop,
    setDesktopChatError: (error: string | null) => { if (error) errors.push(error); },
    setDesktopChatState: noop, setDesktopLiveTurnsBySession: noop, setIsDesktopChatSending: noop, setOpenComposerSelector: noop,
    setPendingUserChatMessage: noop, setQueuedDesktopMessagesBySession: noop,
  } as unknown as UseChatMessageActionsArgs;
  let actions!: ReturnType<typeof useChatMessageActions>;
  function RetryHarness() { actions = useChatMessageActions(args); return null; }
  const failedRow = { id: failedMessageId, role: 'user', sender: 'Me', text: failedText, time: '09:00' } as unknown as Message;
  try {
    await act(async () => root.render(<RetryHarness />));
    await act(async () => { await actions.handleRetryChatMessage(failedRow); });
    return { canonical, errors, appended, upserted, started, queued, composerCleared };
  } finally {
    await act(async () => root.unmount());
    clearMocks(); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function isRetired(message: CanonicalSessionMessage | undefined) {
  return (message?.content as Record<string, unknown> | undefined)?.retiredByRetry === true;
}

test('retrying a failed owned-agent request sends it again and retires the failed row', async () => {
  const result = await retryFailedRequest();
  assert.equal(result.errors.some(error => error.includes('Retry is unavailable')), false);
  assert.deepEqual(result.errors, []);
  const resent = result.appended.filter(request => request.contentText === failedText);
  assert.equal(resent.length, 1, 'the retried request is stored once as a new message');
  assert.notEqual(resent[0].id, failedMessageId);
  assert.deepEqual(result.started, [failedText], 'the local agent receives the original text once');
  const failed = result.canonical.messages.find(message => message.id === failedMessageId);
  assert.equal(isRetired(failed), true, 'the failed row is retired locally');
  assert.equal(result.upserted.some(request => request.id === failedMessageId && isRetired(request as unknown as CanonicalSessionMessage)), true,
    'the retirement is stored so the failed row stays hidden after reload');
  assert.equal(result.canonical.messages.filter(message => message.contentText === failedText && !isRetired(message)).length, 1);
  assert.equal(result.composerCleared, false, 'a retry never clears the composer draft');
});

test('retrying while the session is running queues the request and retires the failed row', async () => {
  const result = await retryFailedRequest({ activeTurn: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.queued, [failedText]);
  assert.deepEqual(result.started, []);
  assert.equal(isRetired(result.canonical.messages.find(message => message.id === failedMessageId)), true);
  assert.equal(result.composerCleared, false);
});

test('a retired failed request is hidden from the transcript and unread counts', () => {
  const state = { messages: [failedCanonicalMessage()] } as unknown as CanonicalSessionState;
  const retired = retiredFailedCanonicalRequest(state, failedMessageId, 5);
  assert.ok(retired);
  assert.equal(retired.status, 'failed');
  const message = { ...failedCanonicalMessage(), content: retired.content };
  assert.equal(mapCanonicalMessage(message, new Map()), null);
  assert.equal(canonicalMessageCountsAsReadable(message), false);
  assert.notEqual(mapCanonicalMessage(failedCanonicalMessage(), new Map()), null);
});

test('only failed requests from this user can be retired', () => {
  const sent = { ...failedCanonicalMessage(), status: 'sent', content: { deliveryState: 'sent' } };
  const agent = { ...failedCanonicalMessage(), senderRole: 'owned-agent' };
  assert.equal(retiredFailedCanonicalRequest({ messages: [sent] } as unknown as CanonicalSessionState, failedMessageId), null);
  assert.equal(retiredFailedCanonicalRequest({ messages: [agent] } as unknown as CanonicalSessionState, failedMessageId), null);
});

test('a collaboration conversation without a retry path still reports that retry is unavailable', async () => {
  const result = await retryFailedRequest({ collaboration: true });
  assert.deepEqual(result.errors, ['Retry is unavailable for this conversation.']);
  assert.deepEqual(result.appended, []);
  assert.deepEqual(result.started, []);
  assert.equal(isRetired(result.canonical.messages.find(message => message.id === failedMessageId)), false);
});
