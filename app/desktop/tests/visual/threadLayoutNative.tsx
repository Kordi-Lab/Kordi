import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { __setSessionBackendForTests } from '../../src/features/cloud/session';
import { setMessageLayout } from '../../src/app/messageLayoutPreference';
import { INTERFACE_ZOOM_EVENT } from '../../src/app/interfaceZoom';
import { mockNativeHttpInvoke } from '../helpers/nativeHttp';
import type { CanonicalSessionState, CanonicalSessionMessage } from '../../src/kordi-app/types';
import '../../src/index.css';

// The complete app runs with in-memory sample data. Native window operations
// remain native; account, provider, agent, and network operations stay offline.
if (!import.meta.env.DEV) throw new Error('Synthetic preview requires development mode.');
const now = Date.now();
const sessionId = 'session:agent:synthetic-layout';
const selfId = 'human:synthetic-alex';
const agentId = 'agent:synthetic-assistant';
const mayaId = 'human:synthetic-maya';
const state: CanonicalSessionState = {
  storagePath: '',
  profile: { id: 'synthetic-profile', displayName: 'Alex Morgan', humanIdentityId: selfId, activeAgentIdentityId: agentId, storageRoot: '', createdAtMs: now, updatedAtMs: now },
  identities: [
    { id: selfId, kind: 'human', displayName: 'Alex Morgan', source: 'local', humanId: 'synthetic-alex', avatarKey: 'layout-alex', createdAtMs: now, updatedAtMs: now },
    { id: agentId, kind: 'agent', displayName: 'Research assistant', ownerIdentityId: selfId, source: 'local', agentId: 'synthetic-assistant', avatarKey: 'layout-assistant', createdAtMs: now, updatedAtMs: now },
    { id: mayaId, kind: 'human', displayName: 'Maya Chen', source: 'imported', humanId: 'synthetic-maya', avatarKey: 'layout-maya', createdAtMs: now, updatedAtMs: now },
  ],
  sessions: [{ id: sessionId, kind: 'self-agent', title: 'Design review', status: 'active', createdByIdentityId: selfId, primaryIdentityId: agentId, metadata: { titleSource: 'manual' }, createdAtMs: now, updatedAtMs: now, lastMessageAtMs: now }],
  participants: [
    { sessionId, identityId: selfId, role: 'self', state: 'active', addedAtMs: now },
    { sessionId, identityId: agentId, role: 'owned-agent', state: 'active', addedAtMs: now },
    { sessionId, identityId: mayaId, role: 'person', state: 'active', addedAtMs: now },
  ],
  messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
};
function sample(id: string, sender: string, text: string, content: object = {}): CanonicalSessionMessage {
  const sequenceNum = state.messages.length + 1;
  const timestamp = now - (9 - sequenceNum) * 60_000;
  return { id, sessionId, senderIdentityId: sender, senderRole: sender === selfId ? 'user' : sender === agentId ? 'owned-agent' : 'person', messageKind: 'text', contentText: text, content: { deliveryState: 'sent', ...content }, status: 'sent', sequenceNum, createdAtMs: timestamp, updatedAtMs: timestamp };
}
const sourceText = 'What is the cleanest way to keep replies easy to follow?';
state.messages.push(sample('synthetic-source', mayaId, sourceText));
state.messages.push(sample('synthetic-quote', selfId, 'Keep the quoted message above the reply. Everything stays together in the conversation.', {
  messageAction: { schemaVersion: 1, kind: 'quote', source: { sourceSessionId: sessionId, sourceMessageId: 'synthetic-source', senderLabel: 'Maya Chen', textPreview: sourceText, attachmentCount: 0 } },
}));
state.messages.push(sample('synthetic-formatting', agentId, 'The layout uses a continuous reading surface. Avatars, names, and timestamps make each message easy to scan.\n\n**Existing chat actions remain available:** quote, open discussion, forward, edit, pin, and select.'));
state.messages.push(sample('synthetic-code', mayaId, 'Rich text and code still work:\n\n```swift\nlet layout = MessageLayout.threads\n```'));
state.messages.push(sample('synthetic-reply-two', mayaId, 'Quoted replies stay in the main conversation. Open discussion is a separate action.', {
  messageAction: { schemaVersion: 1, kind: 'quote', source: { sourceSessionId: sessionId, sourceMessageId: 'synthetic-quote', senderLabel: 'Alex Morgan', textPreview: state.messages[1].contentText, attachmentCount: 0 } },
}));
state.messages.push(sample('synthetic-ready', selfId, 'This feels much easier to read. Let us keep Chat as an option in Appearance settings.'));
state.messages.push(sample('synthetic-file', mayaId, 'Here are the notes for the next review.', {
  attachments: [{ kind: 'file', name: 'layout-notes.md', sizeBytes: 2048, downloadUrl: '/tests/visual/message-layout-notes.md' }],
}));

const avatar = { version: 1, seed: 'layout-alex', source: 'generated', imageUrl: null, assetId: null };
const account = { accountId: 'synthetic-alex', kordiId: '704218563', displayName: 'Alex Morgan', primaryEmail: 'alex@example.test', avatarUrl: null, avatar, nodeId: 'synthetic-node', passwordSet: true };
__setSessionBackendForTests({ load: async () => ({ token: 'offline-synthetic-preview', accountId: account.accountId, expiresAt: '2099-01-01T00:00:00Z' }), save: async () => {}, clear: async () => {} });
if (!localStorage.getItem('kordi.syntheticThreadsInitialized.v1')) {
  setMessageLayout('threads');
  localStorage.setItem('kordi.themeMode.v1', 'light');
  localStorage.setItem('kordi.syntheticThreadsInitialized.v1', '1');
}

const calls: string[] = [];
Object.assign(window, { syntheticPreviewCalls: calls, syntheticPreviewState: state });
const visibility = { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [], pinnedSessionIds: [], mutedSessionIds: [], pinnedGroupSpaceIds: [] };
const cloudConversation = { id: 'synthetic-conversation', kind: 'ai', shared_title: 'Design review', version: 1, created_by_account_id: account.accountId, legacy_session_id: sessionId, latest_message_sequence: state.messages.length, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), members: [], preferences: { conversation_id: 'synthetic-conversation', account_id: account.accountId, personal_title: 'Design review', version: 1 } };
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.protocol === 'ipc:' || url.hostname === 'ipc.localhost') return originalFetch(input, init);
  if (url.origin === location.origin && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/v2/')) return originalFetch(input, init);
  calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname.endsWith('/auth/me')) return response(account);
  if (url.pathname.endsWith('/auth/capabilities')) return response({ password: false, oauthProviders: [] });
  if (url.pathname.endsWith('/sessions/visibility')) return response(visibility);
  if (url.pathname.endsWith('/sync/bootstrap')) return response({ protocol_version: 2, conversations: [], latest_messages: [], session_visibility: visibility, next_cursor: 'synthetic-cursor', last_stream_seq: 1, server_time: new Date(now).toISOString() });
  if (url.pathname.endsWith('/chat/sync')) return response({ protocol_version: 2, events: [], next_cursor: 'synthetic-cursor', last_stream_seq: 1, has_more: false, server_time: new Date(now).toISOString() });
  if (url.pathname.endsWith('/chat/conversations')) return response({ conversation: cloudConversation });
  if (url.pathname.endsWith('/preferences')) return response({ preferences: cloudConversation.preferences });
  if (url.pathname.includes('/presence')) return response({ accountId: account.accountId, desktopOnline: true, status: 'online', accounts: [] });
  if (url.pathname.endsWith('/messages')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array));
      return response({ message: { id: body.client_message_id, client_message_id: body.client_message_id, conversation_id: cloudConversation.id, conversation_sequence: ++cloudConversation.latest_message_sequence, sender_account_id: account.accountId, kind: body.kind, content: body.content, reply_to_message_id: null, attachment_ids: [], version: 1, generation_status: null, provider_response_id: null, created_at: new Date(now).toISOString(), edited_at: null, deleted_at: null } });
    }
    return response({ messages: [], has_more: false, next_before_sequence: null });
  }
  if (url.pathname.endsWith('/threads/read')) return response({ reads: [] });
  if (url.pathname.includes('/contacts/requests')) return response([]);
  if (url.pathname.endsWith('/contacts')) return response([]);
  if (url.pathname.includes('/agent-subsessions')) return response({ sessions: [], nextCursor: null });
  if (url.pathname.includes('/pins') || url.pathname.includes('/pin-history')) return response({ sessionId, sharedMessageIds: [], privateMessageIds: [], effectiveMessageIds: [], sharedMessageId: null, privateMessageId: null, effectiveMessageId: null });
  return response([], 200);
};
// No realtime transport is opened by an offline preview.
Object.defineProperty(window, 'WebSocket', { value: undefined, configurable: true });

const model = 'openai/gpt-5.4';
const provider = { id: 'openai', label: 'OpenAI', statusSummary: 'Sample provider', loginHint: '', envVar: '', helpUrl: '', supportsOAuth: false, supportsApiKey: true, configured: true, preferredModel: model, options: [{ value: 'api-key', method: 'api-key', source: 'synthetic', label: 'Sample account', active: true }] };
const detail = () => ({ id: sessionId, cwd: '', title: 'Design review', subtitle: 'Synthetic conversation', provider: 'openai', providerLabel: 'OpenAI', model, modelLabel: 'GPT-5.4', thinking: 'medium', thinkingLabel: 'Medium', thinkingLevels: ['medium'], updatedAtLabel: 'Now', updatedAtMs: now, messageCount: state.messages.length, draft: false, contextWindowText: '', contextWindowStatus: { contextWindow: 128000, usedTokens: 0, usedPercent: 0, autoCompaction: false, compactionThresholdPercent: 90 }, messages: [] });
const chatState = () => ({ cwd: '', activeSessionId: sessionId, sessions: [{ ...detail(), mode: 'chat' }], projects: [], activeSession: detail(), localAgent: { label: 'Research assistant', systemPrompt: '', loadedSkills: [], loadedTools: [], loadedPlugins: [], identityFiles: [], defaultProvider: 'openai', defaultModel: model, workspaceRoot: '', lastActivities: [] }, modelOptions: [{ value: model, label: 'GPT-5.4', provider: 'openai', thinkingLevels: ['medium'] }], slashCommands: [] });
const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
const originalInvoke = native?.invoke.bind(native);
async function previewInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (command === 'desktop_set_window_backdrop') Object.assign(window, { syntheticBackdrop: args });
  if (originalInvoke && (command.startsWith('plugin:window|') || command.startsWith('plugin:event|') || command.startsWith('plugin:deep-link|') || ['desktop_set_auth_window_surface', 'desktop_set_window_backdrop', 'desktop_set_menu_bar_unread_count'].includes(command))) return originalInvoke(command, args);
  calls.push(command);
  if (command === 'desktop_canonical_session_catalog') {
    const { messages, contextSnapshots: _snapshots, ...catalog } = state;
    return { ...catalog, summaries: state.sessions.map(session => ({ sessionId: session.id, messageCount: messages.length, latestMessage: messages.at(-1) ?? null, contextSnapshotCount: 0 })) };
  }
  if (command === 'desktop_canonical_session_messages') return { sessionId: args.sessionId, messages: state.messages, oldestSequenceNum: 1, newestSequenceNum: state.messages.length, hasOlder: false };
  if (command === 'desktop_canonical_session_state') return state;
  if (command === 'cloud_account_storage_activate') return { storageRoot: '', requiresReload: false };
  if (command === 'desktop_auth_state') return { providers: [provider], authPath: '', hasAnyAuth: true };
  if (command === 'desktop_chat_state') return chatState();
  if (command === 'desktop_chat_session_detail') return detail();
  if (command === 'desktop_chat_session_active_turn') return null;
  if (command === 'desktop_chat_sync_load') return { accountId: account.accountId, cursor: 'synthetic-cursor', lastStreamSeq: 1, conversations: [], messages: [], visibility, pinCacheReady: true };
  if (command === 'desktop_chat_sync_apply') return { accountId: account.accountId, cursor: 'synthetic-cursor', lastStreamSeq: 1, changedConversationHeads: [] };
  if (command === 'desktop_chat_start_message') return { id: `synthetic-turn-${crypto.randomUUID()}`, sessionId, prompt: args.text, status: 'done', message: '', assistantText: 'Your sample message was added to this conversation.', thinkingText: '', tools: [], completed: true, succeeded: true };
  if (command === 'desktop_collaboration_state') return { hosts: [], contacts: [], conversations: [], messages: [], requests: [], agents: [] };
  if (command === 'desktop_notification_permission_state') return 'denied';
  if (command === 'desktop_canonical_adopt_cloud_profile_identity') return { profile: state.profile, identity: state.identities[0], previousIdentityId: null, groupSelfSessionIds: [] };
  if (command === 'desktop_canonical_mark_session_read') return null;
  if (command === 'desktop_canonical_update_session_metadata') return state;
  if (command === 'desktop_canonical_upsert_identity_fast') return state.identities.find(identity => identity.id === (args.request as { id?: string })?.id) ?? state.identities[0];
  if (command === 'desktop_canonical_append_message_fast' || command === 'desktop_canonical_upsert_message_fast') {
    const request = args.request as Partial<CanonicalSessionMessage>;
    const message = { ...sample(request.id ?? `synthetic-${crypto.randomUUID()}`, request.senderIdentityId ?? selfId, request.contentText ?? '', request.content as object ?? {}), ...request } as CanonicalSessionMessage;
    state.messages = [...state.messages.filter(existing => existing.id !== message.id), message];
    return message;
  }
  if (command === 'desktop_canonical_append_message' || command === 'desktop_canonical_upsert_message') {
    await previewInvoke(command + '_fast', args);
    return state;
  }
  if (command === 'desktop_canonical_update_message_delivery') return null;
  if (command === 'plugin:event|listen') return 1;
  if (command === 'plugin:window|theme') return 'light';
  if (command === 'plugin:window|inner_size') return { width: 1440, height: 920 };
  if (command === 'plugin:window|scale_factor') return 1;
  if (command.startsWith('plugin:')) return null;
  return [];
}
const invoke = mockNativeHttpInvoke(window.fetch, previewInvoke);
Object.assign(window, { syntheticPreviewInvoke: invoke });
if (!native) {
  mockIPC(invoke);
  mockWindows('main');
}

const { default: App } = await import('../../src/App.jsx');
createRoot(document.getElementById('root')!).render(<App />);
if (native) {
  const report = () => {
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
    };
    void originalFetch('/__synthetic-preview-ready', { method: 'POST', body: JSON.stringify({ native: true, layout: localStorage.getItem('kordi.messageLayout.v1'), messages: document.querySelectorAll('.app-thread-message-row').length, composer: Boolean(document.querySelector('[contenteditable="true"]')), quotedReply: document.body.textContent?.includes(sourceText) ?? false, zoom: document.documentElement.dataset.kordiInterfaceZoom, viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio }, workspaceTracks: getComputedStyle(document.querySelector('.app-shell-layout-grid')!).gridTemplateColumns, inlineTracks: (document.querySelector('.app-shell-layout-grid') as HTMLElement).style.gridTemplateColumns, canvas: bounds('.app-native-viewport'), shell: bounds('.app-shell'), titlebar: bounds('.app-native-titlebar'), headerPane: bounds('.app-native-titlebar-workspace'), toggle: bounds('.app-native-titlebar-navigation button'), title: bounds('.app-native-titlebar-title'), sidebar: bounds('.app-workspace-sidebar'), tabs: bounds('.app-chat-destination-tabs'), editor: bounds('[contenteditable="true"]'), backdrop: (window as unknown as { syntheticBackdrop?: unknown }).syntheticBackdrop }) });
  };
  window.addEventListener(INTERFACE_ZOOM_EVENT, () => { window.setTimeout(report, 250); window.setTimeout(report, 1500); });
  import.meta.hot?.on('synthetic-preview-zoom', ({ key }: { key: string }) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }));
  });
  import.meta.hot?.on('synthetic-preview-sidebar', ({ collapsed }: { collapsed: boolean }) => {
    const toggle = document.querySelector<HTMLButtonElement>('.app-native-titlebar-navigation button');
    if (toggle?.getAttribute('aria-expanded') === String(collapsed)) toggle.click();
    window.setTimeout(report, 500);
  });
  window.setTimeout(async () => {
    await originalInvoke?.('plugin:window|show', { label: 'main' });
    await originalInvoke?.('plugin:window|unminimize', { label: 'main' });
    await originalInvoke?.('plugin:window|set_focus', { label: 'main' });
    report();
  }, 3000);
}
