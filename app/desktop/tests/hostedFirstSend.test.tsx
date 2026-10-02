import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useChatMessageActions } from '../src/features/chat/messageActions/chatMessages';
import type { UseChatMessageActionsArgs } from '../src/features/chat/messageActions/types';
import type { CanonicalSessionState, DesktopChatState } from '../src/kordi-app/types';
import type { ChatSyncConversation, CloudAccount, CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudSelfAgentForwardSync } from '../src/features/cloud/useCloudSelfAgentForwardSync';
import { saveCloudSelfAgentForwardCutoff } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { cloudDirectMessageDisplayText, cloudDirectMessageAgentRuntimeRoute } from '../src/features/cloud/cloudDirectMessages';

const sessionId = 'synthetic-new-chat';
const route = { model: 'openai/gpt-6-sol', thinking: 'medium', authProvider: 'openai-codex', authChoice: 'cloud-login:synthetic' };
const noop = () => undefined;

async function sendFirstMessage(existingSession = false, blankNativeSession = false, missingCatalog = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  const session = { id: sessionId, kind: 'self-agent', status: 'active', title: 'New chat',
    primaryIdentityId: 'agent:me', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 };
  const retainedSession = { ...session, id: 'synthetic-retained-chat', title: 'Existing history' };
  const retainedMessage = { id: 'synthetic-retained-message', sessionId: retainedSession.id, senderIdentityId: 'human:me',
    senderRole: 'user', messageKind: 'text', contentText: 'Keep the existing history', status: 'sent',
    createdAtMs: 1, updatedAtMs: 1, sequenceNum: 1, sourceTransport: 'desktop-chat-ui' };
  let canonical = { profile: { id: 'synthetic', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me' },
    identities: [{ id: 'human:me', kind: 'human' }, { id: 'agent:me', kind: 'agent' }],
    sessions: existingSession ? [retainedSession, session] : [retainedSession],
    participants: [{ sessionId: retainedSession.id, identityId: 'human:me', state: 'active' }], messages: [retainedMessage],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as unknown as CanonicalSessionState;
  const desktop = { activeSessionId: sessionId, activeSession: { id: sessionId, messages: [], messageCount: 0, title: 'New chat' },
    sessions: [], projects: [] } as unknown as DesktopChatState;
  const errors: string[] = [];
  const commands: string[] = [];
  const sent: string[] = [];
  const conversation = { id: 'synthetic-conversation', kind: 'ai', legacy_session_id: sessionId,
    latest_message_sequence: 1, created_at: new Date().toISOString() } as ChatSyncConversation;
  mockIPC((command, payload) => {
    commands.push(command);
    if (command === 'desktop_chat_new_session') return desktop;
    if (command === 'desktop_chat_session_active_turn') return null;
    if (command === 'desktop_canonical_session_catalog') return missingCatalog ? null : { ...canonical,
      sessions: blankNativeSession ? [] : [session], participants: [{ sessionId, identityId: 'human:me', state: 'active' }], summaries: [] };
    if (command === 'desktop_canonical_open_or_create_session_fast') {
      const request = (payload as { request: Record<string, unknown> }).request;
      assert.equal(request.id, sessionId);
      assert.equal(request.primaryIdentityId, 'agent:me');
      return { session, participants: [{ sessionId, identityId: 'human:me', state: 'active' }] };
    }
    if (command === 'desktop_canonical_append_message_fast' || command === 'desktop_canonical_upsert_message_fast') {
      const request = (payload as { request: Record<string, unknown> }).request;
      return { ...request, sequenceNum: 1, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    }
    if (command === 'desktop_chat_sync_conversations') return [conversation, { ...conversation, id: 'retained-conversation', legacy_session_id: retainedSession.id }];
    if (command === 'desktop_chat_sync_message_refs') return [];
    if (command === 'desktop_canonical_session_messages') return { messages: canonical.messages, hasOlder: false, oldestSequenceNum: 1 };
    throw new Error('Unexpected IPC: ' + command);
  });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'me', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  saveCloudSelfAgentForwardCutoff('me', Date.now() - 1_000);
  const args = {
    activeConvId: existingSession ? sessionId : 'draft:local-chat', activeConvCanonicalSessionId: existingSession ? sessionId : null,
    activeConversationUsesCollaboration: false, activeConvCollaborationTarget: null, activeConvMentionScope: null,
    activeConvMessages: [], chatConversations: [], isNativeShell: true, hasAnyDesktopAuth: true, hasConfiguredProviderAuth: true,
    canonicalHumanIdentityId: 'human:me', canonicalSessionState: canonical, desktopChatState: existingSession ? desktop : null,
    desktopCollaborationState: null, desktopLiveTurn: null, queuedDesktopMessagesBySession: {},
    composerDrafts: { chat: 'Which model are you using?', project: '' }, composerSelections: { chat: { mode: 'agent', model: route.model, thinking: route.thinking } },
    chatComposerAttachments: [], selectedChatAgentMentionRef: { current: null }, localChatSendInFlightRef: { current: null },
    shouldAutoFollowChatRef: { current: false }, attachmentSummaryText: (text: string) => text, resolveChatRuntimeRoute: () => route,
    handleLocalSlashCommand: async () => false, setComposerDrafts: noop, setActiveConvId: noop,
    setCanonicalSessionState: (update: React.SetStateAction<CanonicalSessionState | null>) => { canonical = (typeof update === 'function' ? update(canonical) : update) ?? canonical; },
    setChatComposerAttachments: noop, setCloudCollaborationState: noop, setDesktopChatError: (error: string | null) => { if (error) errors.push(error); },
    setDesktopChatState: noop, setDesktopLiveTurnsBySession: noop, setIsDesktopChatSending: noop, setOpenComposerSelector: noop,
    setPendingUserChatMessage: noop, setQueuedDesktopMessagesBySession: noop,
  } as unknown as UseChatMessageActionsArgs;
  let actions!: ReturnType<typeof useChatMessageActions>;
  function SendHarness() { actions = useChatMessageActions(args); return null; }
  const client = {
    listChatConversationHistoryPage: async () => ({ messages: [], hasMore: false, nextBeforeSequence: null }),
    sendMessage: async (_token: string, _peer: string, body: string) => { sent.push(body); return { messageId: 'synthetic-wire-' + sent.length }; },
  } as unknown as CloudAuthClient;
  function ForwardHarness() {
    useCloudSelfAgentForwardSync({ account: { accountId: 'me' } as CloudAccount, canonicalState: canonical,
      canonicalStateRef: { current: canonical }, initialMessagesSettled: true, client, cancelledRef: { current: false },
      processedRequestIdsRef: { current: new Set() }, mergeMessage: noop, syncCloudCollaborationDiff: async () => {},
      reportWarning: (_message, error) => { errors.push(String(error)); } });
    return null;
  }
  try {
    await act(async () => root.render(<SendHarness />));
    await act(async () => { await actions.handleSendChatMessage(); });
    await act(async () => { root.render(<ForwardHarness />); await new Promise(resolve => setTimeout(resolve, 50)); });
    return { canonical, sent, errors, commands };
  } finally {
    await act(async () => root.unmount());
    clearMocks(); __setSessionBackendForTests(null); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

for (const existingSession of [false, true]) {
  test(`${existingSession ? 'existing' : 'new'} hosted chat forwards its first request without a model change`, async () => {
    const result = await sendFirstMessage(existingSession);
    assert.deepEqual(result.errors, []);
    assert.equal(result.canonical.sessions.some(session => session.id === sessionId), true, 'the sent request must have a session in the frontend catalog');
    const requests = result.sent.filter(body => cloudDirectMessageDisplayText(body) === 'Which model are you using?');
    assert.equal(requests.length, 1);
    assert.deepEqual(cloudDirectMessageAgentRuntimeRoute(requests[0]), route);
    assert.equal(result.commands.filter(command => command === 'desktop_canonical_session_catalog').length, existingSession ? 0 : 1);
    assert.equal(result.canonical.sessions.some(session => session.id === 'synthetic-retained-chat'), true);
    assert.equal(result.canonical.participants.some(participant => participant.sessionId === 'synthetic-retained-chat'), true);
    assert.equal(result.canonical.messages.find(message => message.id === 'synthetic-retained-message')?.contentText, 'Keep the existing history');
  });
}

test('a missing newly created session surfaces an error instead of silently stranding its first send', async () => {
  const result = await sendFirstMessage(false, false, true);
  assert.ok(result.errors.some(error => error.includes('new chat')));
  assert.deepEqual(result.sent, []);
});

test('a blank native chat creates its canonical shell on the first send and forwards immediately', async () => {
  const result = await sendFirstMessage(false, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.commands.filter(command => command === 'desktop_canonical_open_or_create_session_fast').length, 1);
  assert.equal(result.canonical.sessions.some(session => session.id === sessionId), true);
  assert.equal(result.sent.filter(body => cloudDirectMessageDisplayText(body) === 'Which model are you using?').length, 1);
});
