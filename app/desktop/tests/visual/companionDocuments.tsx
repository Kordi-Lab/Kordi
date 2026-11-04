import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { __setSessionBackendForTests } from '../../src/features/cloud/session';
import { setMessageLayout } from '../../src/app/messageLayoutPreference';
import { INTERFACE_ZOOM_EVENT } from '../../src/app/interfaceZoom';
import { mockNativeHttpInvoke } from '../helpers/nativeHttp';
import type { CanonicalSessionState, CanonicalSessionMessage } from '../../src/kordi-app/types';
import '../../src/index.css';
import './companionDocuments.css';
import { openCompanionDocument } from '../../src/features/documents/companionDocument';
import { setAvatarOverride } from '../../src/kordi-app/components/avatarOverrides';
const sampleAvatar = (initials: string, color: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="24" fill="${color}"/><text x="48" y="60" text-anchor="middle" font-family="system-ui" font-size="32" fill="#fff">${initials}</text></svg>`);
setAvatarOverride('layout-alex', sampleAvatar('AM', '#53776b'));
setAvatarOverride('layout-maya', sampleAvatar('MC', '#98705b'));
setAvatarOverride('synthetic-assistant', sampleAvatar('RA', '#6f7d95'));
const params = new URLSearchParams(location.search);
localStorage.setItem('kordi.chatTheme.v2', 'quiet');
localStorage.setItem('kordi.themeMode.v1', params.get('theme') === 'dark' ? 'dark' : 'light');
localStorage.setItem('kordi.syntheticThreadsInitialized.v1', '1');

// The complete app runs with in-memory sample data. Native window operations
// remain native; account, provider, agent, and network operations stay offline.
if (!import.meta.env.DEV) throw new Error('Synthetic preview requires development mode.');
const now = Date.now();
const sessionId = 'session:agent:synthetic-layout';
const sideId = 'session:agent:synthetic-side';
let sideCreated = false;
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
  const date = new Date(now);
  date.setHours(sequenceNum <= 3 ? 10 : 9, sequenceNum, 0, 0);
  if (sequenceNum <= 3) date.setDate(date.getDate() - 1);
  const timestamp = date.getTime();
  return { id, sessionId, senderIdentityId: sender, senderRole: sender === selfId ? 'user' : sender === agentId ? 'owned-agent' : 'person', messageKind: 'text', contentText: text, content: { deliveryState: 'sent', ...content }, status: 'sent', sequenceNum, createdAtMs: timestamp, updatedAtMs: timestamp };
}
const sourceText = 'Can we review the document tabs beside this conversation?';
state.messages.push(sample('synthetic-source', mayaId, sourceText));
state.messages.push(sample('synthetic-quote', selfId, 'Yes. Keep the conversation visible while I compare the release notes and the configuration.'));
state.messages.push(sample('synthetic-formatting', agentId, 'I have prepared three sample documents for the review. The notes include a deliberately long line so we can check wrapping at a narrow pane width.'));
state.messages.push(sample('synthetic-code', mayaId, 'The important part is keeping filenames readable and making it easy to move between open files.'));
state.messages.push(sample('synthetic-ready', selfId, 'Let us start with notes.txt.'));
state.messages.push(sample('synthetic-file', mayaId, 'Synthetic documents for this UI review.', { attachments: [{ kind: 'file', name: 'notes.txt', localPath: 'notes.txt', sizeBytes: 1860 }] }));

const avatar = { version: 1, seed: 'layout-alex', source: 'generated', imageUrl: null, assetId: null };
const account = { accountId: 'synthetic-alex', kordiId: '704218563', displayName: 'Alex Morgan', primaryEmail: 'alex@example.test', avatarUrl: null, avatar, nodeId: 'synthetic-node', passwordSet: true, memoryVersion: 3 };
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
  if (url.pathname.endsWith('/agent-provider-auth/snapshots')) return response({ snapshots: [] });
  if (url.pathname.endsWith('/calendar/events')) return response({ events: [] });
  if (url.pathname.endsWith('/digest')) return response({ accountId: account.accountId, status: 'ready', updatedAt: new Date(now).toISOString(), partial: false, revision: 1, sources: [], feedback: [], snapshot: { claims: [{ id: 'sample-brief', title: 'Tab review', text: 'Synthetic digest for the shared pane.', sourceIds: [], kind: 'claim' }], commitments: [], suggestions: [], calendarCandidates: [] } });
  if (url.pathname.endsWith('/auth/me')) return response(account);
  if (url.pathname.endsWith('/auth/capabilities')) return response({ password: false, oauthProviders: [], memoryVersion: 3 });
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
const detail = (id = sessionId) => ({ id, cwd: '', title: id === sideId ? 'Private review' : 'Design review', subtitle: 'Synthetic conversation', provider: 'openai', providerLabel: 'OpenAI', model, modelLabel: 'GPT-5.4', thinking: 'medium', thinkingLabel: 'Medium', thinkingLevels: ['medium'], updatedAtLabel: 'Now', updatedAtMs: now, messageCount: id === sideId ? 0 : state.messages.length, draft: false, contextWindowText: '', contextWindowStatus: { contextWindow: 128000, usedTokens: 0, usedPercent: 0, autoCompaction: false, compactionThresholdPercent: 90 }, messages: [] });
const chatState = (id = sessionId) => ({ cwd: '', activeSessionId: id, sessions: [{ ...detail(), mode: 'chat' }, ...(sideCreated ? [{ ...detail(sideId), mode: 'chat' }] : [])], projects: [], activeSession: detail(id), localAgent: { label: 'Research assistant', systemPrompt: '', loadedSkills: [], loadedTools: [], loadedPlugins: [], identityFiles: [], defaultProvider: 'openai', defaultModel: model, workspaceRoot: '', lastActivities: [] }, modelOptions: [{ value: model, label: 'GPT-5.4', provider: 'openai', thinkingLevels: ['medium'] }], slashCommands: [] });
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
  if (command === 'desktop_canonical_session_messages') return { sessionId: args.sessionId, messages: args.sessionId === sideId ? [] : state.messages, oldestSequenceNum: 1, newestSequenceNum: state.messages.length, hasOlder: false };
  if (command === 'desktop_canonical_session_state') return state;
  if (command === 'cloud_account_storage_activate') return { storageRoot: '', requiresReload: false };
  if (command === 'desktop_auth_state') return { providers: [provider], authPath: '', hasAnyAuth: true };
  if (command === 'desktop_chat_new_session') { sideCreated = true; return chatState(sideId); }
  if (command === 'desktop_chat_state') return chatState(typeof args.activeSessionId === 'string' ? args.activeSessionId : sessionId);
  if (command === 'desktop_chat_session_detail') return detail(typeof args.sessionId === 'string' ? args.sessionId : sessionId);
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
  if (command === 'plugin:window|inner_size') return { width: innerWidth * devicePixelRatio, height: (innerHeight - 40) * devicePixelRatio };
  if (command === 'plugin:window|scale_factor') return devicePixelRatio;
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

const samples = [
  ['notes.txt', 'DOCUMENT TAB REVIEW\nSynthetic document · preview only\n\n1. Keep the conversation in view\nThe parallel pane should feel like part of the same workspace, with a consistent header height and a clear boundary before the document begins.\n\n2. Make the active document easy to find\nUse a quiet surface, a small active indicator, and enough room for the filename. Keep the close action separate from selecting the tab.\n\n3. Handle long lines deliberately\nThis is a deliberately long plain-text line for evaluating the Wrap lines control: it should remain readable when the document pane is narrow, and turning wrapping off should preserve the original line and allow horizontal scrolling.\n\n4. Keep the details intact\nTab switching preserves scroll position. Closing the last tab returns the space to the conversation.'],
  ['release-notes-november-document-review.txt', 'RELEASE REVIEW\nSynthetic document · preview only\n\nThe complete filename stays available in the document picker and on keyboard focus.\n\nReview checklist\n- Light and dark themes\n- Narrow and wide pane widths\n- Multiple open documents\n- Keyboard navigation and closing'],
  ['workspace.config.json', '{\n  "preview": true,\n  "documents": ["notes.txt", "release-notes-november-document-review.txt"],\n  "layout": { "conversation": "visible", "documentPane": "parallel", "preserveScrollPosition": true }\n}'],
  ['meeting-actions.txt', 'MEETING ACTIONS\nSynthetic document\n\nReview the proposed document strip.\nCompare the narrow and wide layouts.'],
  ['research-summary.txt', 'RESEARCH SUMMARY\nSynthetic document\n\nKeep labels readable. Preserve access to every open document.'],
  ['implementation-checklist.txt', 'IMPLEMENTATION CHECKLIST\nSynthetic document\n\nConfirm the visual direction before implementing product changes.'],
];
samples.push(...['design-decisions.txt', 'api-response.json', 'test-results.txt', 'project-roadmap.txt', 'accessibility-review.txt', 'handoff-notes.txt'].map(name => [name, 'Synthetic review document\n\n' + name + '\n\nUse the tab strip or search open documents to switch files.']));
function openSample(index: number) {
  const [name, content] = samples[index];
  openCompanionDocument({ artifact: { id: 'sample-' + index, name, path: name, kind: 'file', summary: '' }, sourceView: true, readLocally: false, preview: { path: name, truncated: false, lines: content.split('\n').map((text, i) => ({ number: i + 1, text })) } });
}
Object.assign(window, { openSampleDocument: openSample });
const review = document.createElement('div');
review.className = 'companion-documents-fixture-label';
review.textContent = 'Document pane review · offline synthetic documents';
document.body.append(review);
const ready = window.setInterval(() => {
  if (!document.querySelector('.app-chat-destination-tabs')) return;
  clearInterval(ready);
  for (const prefix of ['', 'human:']) {
    setAvatarOverride(prefix + 'layout-alex', sampleAvatar('AM', '#53776b'));
    setAvatarOverride(prefix + 'layout-maya', sampleAvatar('MC', '#98705b'));
  }
  setAvatarOverride('agent:synthetic-assistant', sampleAvatar('RA', '#6f7d95'));

  const count = Math.min(samples.length, Math.max(1, Number(params.get('tabs') || '12')));
  for (let index = 0; index < count; index++) openSample(index);
  openSample(0);
}, 300);
