import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useChatMessageActions } from '../src/features/chat/messageActions/chatMessages';
import type { UseChatMessageActionsArgs } from '../src/features/chat/messageActions/types';
import type { CanonicalSessionState, Conversation, DesktopChatState } from '../src/kordi-app/types';
import type { ChatSyncConversation, CloudAccount, CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudSelfAgentForwardSync } from '../src/features/cloud/useCloudSelfAgentForwardSync';
import { saveCloudSelfAgentForwardCutoff } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { cloudDirectMessageAgentRuntimeRoute, cloudDirectMessageDisplayText } from '../src/features/cloud/cloudDirectMessages';

const panelSessionId = 'synthetic-panel-new-chat';
const mainSessionId = 'synthetic-main-chat';
const route = { model: 'openai/gpt-6-sol', thinking: 'medium', authProvider: 'openai-codex', authChoice: 'cloud-login:synthetic' };
const noop = () => undefined;

// Models the Ask Agent panel: the native side-session command already wrote the
// canonical row, but the frontend catalog was loaded before it existed.
test('a new Ask Agent panel chat forwards its first and second hosted sends', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  const mainSession = { id: mainSessionId, kind: 'self-agent', status: 'active', title: 'Main chat',
    primaryIdentityId: 'agent:me', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 };
  const panelSession = { ...mainSession, id: panelSessionId, title: 'New chat',
    metadata: { source: 'ask-agent-new-chat', createdFrom: 'chat-create-flow' } };
  const identities = [{ id: 'human:me', kind: 'human' }, { id: 'agent:me', kind: 'agent' }];
  const initialCanonical = { profile: { id: 'synthetic', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me' },
    identities, sessions: [mainSession],
    participants: [{ sessionId: mainSessionId, identityId: 'human:me', state: 'active' }], messages: [],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as unknown as CanonicalSessionState;
  const panelDesktop = { activeSessionId: panelSessionId, activeSession: { id: panelSessionId, messages: [], messageCount: 0, title: 'New chat' },
    sessions: [], projects: [] } as unknown as DesktopChatState;
  const mainDesktop = { activeSessionId: mainSessionId, activeSession: { id: mainSessionId, messages: [], messageCount: 0, title: 'Main chat' },
    sessions: [], projects: [] } as unknown as DesktopChatState;
  const errors: string[] = [];
  const sent: string[] = [];
  const commands: string[] = [];
  const conversationFor = (id: string, latest = 0) => ({ id: `conversation:${id}`, kind: 'ai', legacy_session_id: id,
    latest_message_sequence: latest, created_at: new Date().toISOString() }) as ChatSyncConversation;
  // The panel chat has no cloud conversation yet; the forward sync creates it.
  const conversations = [conversationFor(mainSessionId)];
  const persisted = new Map<string, Record<string, unknown>>();
  const remote: { id: string; conversation_id: string; client_message_id: string }[] = [];
  mockIPC((command, payload) => {
    commands.push(command);
    if (command === 'desktop_chat_session_active_turn') return null;
    if (command === 'desktop_chat_state') {
      const requested = (payload as { activeSessionId?: string }).activeSessionId;
      assert.equal(requested, panelSessionId);
      return panelDesktop;
    }
    if (command === 'desktop_canonical_session_catalog') return { ...initialCanonical, sessions: [panelSession, mainSession],
      participants: [...initialCanonical.participants, { sessionId: panelSessionId, identityId: 'human:me', state: 'active' },
        { sessionId: panelSessionId, identityId: 'agent:me', state: 'active' }], summaries: [] };
    if (command === 'desktop_canonical_append_message_fast' || command === 'desktop_canonical_upsert_message_fast') {
      const request = (payload as { request: Record<string, unknown> }).request;
      const id = String(request.messageId ?? request.id);
      const sequenceNum = (persisted.get(id)?.sequenceNum as number | undefined) ?? persisted.size + 1;
      const row = { ...persisted.get(id), ...request, id, status: request.status ?? 'sending', sequenceNum,
        createdAtMs: request.createdAtMs ?? Date.now(), updatedAtMs: Date.now() };
      persisted.set(id, row);
      return row;
    }
    if (command === 'desktop_chat_sync_conversations') return conversations;
    if (command === 'desktop_chat_sync_message_refs') return [];
    if (command === 'desktop_canonical_session_messages') {
      const requested = (payload as { sessionId: string }).sessionId;
      return { messages: [...persisted.values()].filter(row => row.sessionId === requested), hasOlder: false, oldestSequenceNum: null };
    }
    throw new Error('Unexpected IPC: ' + command);
  });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'me', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  saveCloudSelfAgentForwardCutoff('me', Date.now() - 1_000);
  const sideTarget = { id: panelSessionId, canonicalSessionId: panelSessionId, name: 'New chat', type: 'owned-agent', trust: 'Owned',
    directness: 'Agent chat', messages: [], desktopRuntimeBacked: true, desktopRuntimeTranscriptLoaded: false,
    metadata: { source: 'ask-agent-new-chat' } } as unknown as Conversation;
  const client = {
    ensureChatConversation: async (_token: string, input: { sessionId: string }) => {
      const created = conversationFor(input.sessionId);
      conversations.push(created);
      return created;
    },
    listChatConversationHistoryPage: async (_token: string, conversationId: string) => ({
      messages: remote.filter(message => message.conversation_id === conversationId), hasMore: false, nextBeforeSequence: null }),
    sendMessage: async (_token: string, _peer: string, body: string, options: { sessionId?: string; clientMessageId?: string } = {}) => {
      sent.push(body);
      const conversation = conversations.find(item => item.legacy_session_id === options.sessionId);
      if (conversation) {
        conversation.latest_message_sequence += 1;
        remote.push({ id: 'synthetic-wire-' + sent.length, conversation_id: conversation.id, client_message_id: options.clientMessageId ?? '' });
      }
      return { messageId: 'synthetic-wire-' + sent.length };
    },
  } as unknown as CloudAuthClient;
  const account = { accountId: 'me' } as CloudAccount;
  const followMain = { current: false };
  let latestDesktop: DesktopChatState | null = mainDesktop;
  const localChatSendInFlightRef = { current: null };
  let actions!: ReturnType<typeof useChatMessageActions>;
  let latestCanonical: CanonicalSessionState | null = initialCanonical;
  let setLatestCanonical!: React.Dispatch<React.SetStateAction<CanonicalSessionState | null>>;
  function App() {
    const [canonical, setCanonical] = useState<CanonicalSessionState | null>(initialCanonical);
    setLatestCanonical = setCanonical;
    const [desktop, setDesktop] = useState<DesktopChatState | null>(mainDesktop);
    latestCanonical = canonical;
    latestDesktop = desktop;
    actions = useChatMessageActions({
      activeConvId: mainSessionId, activeConvCanonicalSessionId: mainSessionId,
      activeConversationUsesCollaboration: false, activeConvCollaborationTarget: null, activeConvMentionScope: null,
      activeConvMessages: [], chatConversations: [sideTarget], isNativeShell: true, hasAnyDesktopAuth: true, hasConfiguredProviderAuth: true,
      canonicalHumanIdentityId: 'human:me', canonicalSessionState: canonical, desktopChatState: desktop,
      desktopCollaborationState: null, desktopLiveTurn: null, queuedDesktopMessagesBySession: {},
      composerDrafts: { chat: '', project: '' }, composerSelections: { chat: { mode: 'agent', model: route.model, thinking: route.thinking } },
      chatComposerAttachments: [], selectedChatAgentMentionRef: { current: null }, localChatSendInFlightRef,
      shouldAutoFollowChatRef: followMain, attachmentSummaryText: (text: string) => text,
      resolveChatRuntimeRoute: () => route,
      handleLocalSlashCommand: async () => false, setComposerDrafts: noop, setActiveConvId: noop,
      setCanonicalSessionState: setCanonical, setChatComposerAttachments: noop, setCloudCollaborationState: noop,
      setDesktopChatError: (error: string | null) => { if (error) errors.push(error); },
      setDesktopChatState: setDesktop, setDesktopLiveTurnsBySession: noop, setIsDesktopChatSending: noop, setOpenComposerSelector: noop,
      setPendingUserChatMessage: noop, setQueuedDesktopMessagesBySession: noop,
    } as unknown as UseChatMessageActionsArgs);
    useCloudSelfAgentForwardSync({ account, canonicalState: canonical, canonicalStateRef: { current: canonical },
      initialMessagesSettled: true, client, cancelledRef: { current: false }, processedRequestIdsRef: { current: new Set() },
      mergeMessage: noop, syncCloudCollaborationDiff: async () => {},
      reportWarning: (_message, error) => { errors.push(String(error)); } });
    return null;
  }
  const requests = (text: string) => sent.filter(body => cloudDirectMessageDisplayText(body) === text);
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && errors.length === 0 && Date.now() < deadline) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
  };
  try {
    await act(async () => root.render(<App />));
    // Let the mounted forward sync settle its baseline before the panel send.
    await waitFor(() => commands.includes('desktop_chat_sync_message_refs'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    await act(async () => { await actions.handleSendChatMessage('First panel question', panelSessionId); });
    await waitFor(() => requests('First panel question').length > 0);
    assert.deepEqual(errors, []);
    assert.equal(latestCanonical?.messages.find(message => message.contentText === 'First panel question')?.status, 'sent');
    assert.equal(latestCanonical?.sessions.some(session => session.id === panelSessionId), true,
      'the panel session must be in the frontend catalog that the forward sync reads');
    assert.equal(requests('First panel question').length, 1);
    assert.deepEqual(cloudDirectMessageAgentRuntimeRoute(requests('First panel question')[0]), route);

    // The second send would wait in the queue while the first hosted run is active.
    const firstRequestId = latestCanonical?.messages.find(message => message.contentText === 'First panel question')?.id ?? '';
    await act(async () => setLatestCanonical(current => current && ({ ...current, messages: [...current.messages, {
      id: 'synthetic-first-reply', sessionId: panelSessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent',
      messageKind: 'agent-turn', contentText: 'Answer', status: 'complete', parentMessageId: firstRequestId,
      content: { requestId: firstRequestId, deliveryState: 'complete' }, createdAtMs: Date.now(), updatedAtMs: Date.now(),
      sequenceNum: 99, sourceTransport: 'cloud-self-agent',
    } as unknown as CanonicalSessionState['messages'][number]] })));
    await act(async () => { await actions.handleSendChatMessage('Second panel question', panelSessionId); });
    await waitFor(() => requests('Second panel question').length > 0);
    assert.deepEqual(errors, []);
    assert.equal(requests('Second panel question').length, 1);
    assert.deepEqual(cloudDirectMessageAgentRuntimeRoute(requests('Second panel question')[0]), route);
    assert.equal(requests('First panel question').length, 1, 'the first request is not forwarded twice');
    assert.equal(commands.includes('desktop_chat_start_message'), false, 'hosted accounts do not start a native turn');
    assert.equal(latestDesktop?.activeSessionId, mainSessionId, 'a panel send keeps the main pane selection');
  } finally {
    await act(async () => root.unmount());
    clearMocks(); __setSessionBackendForTests(null); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
