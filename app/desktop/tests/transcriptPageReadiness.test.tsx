import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyCanonicalHydrationPlaceholder } from '../src/app/viewModels/conversationSelection';
import { useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';
import type { Conversation } from '../src/kordi-app/types';

const conversation: Conversation = {
  id: 'session:group:synthetic', canonicalSessionId: 'session:group:synthetic',
  name: 'Synthetic chat', type: 'person', subtitle: 'Catalog summary', unread: 0,
  collaborationSources: ['Cloud'], trust: 'Cloud', directness: 'Group chat', participants: [],
  canonicalMessageCount: 100,
  messages: [{ id: 'head', role: 'person', text: 'Catalog head', time: '10:00' }],
};

test('page readiness distinguishes cold catalog heads from genuine one-message histories', () => {
  for (const hydration of ['cold', 'loading'] as const) {
    const pending = applyCanonicalHydrationPlaceholder(conversation, hydration);
    assert.equal(pending.messages[0].detail, 'transcript-loading');
    assert.equal(pending.messages[0].loadingPlaceholders, undefined);
    assert.equal(pending.subtitle, conversation.subtitle);
  }
  const single = { ...conversation, canonicalMessageCount: 1 };
  assert.equal(applyCanonicalHydrationPlaceholder(single, 'ready'), single);
  assert.equal(applyCanonicalHydrationPlaceholder(conversation, 'error'), conversation);
  const failedProjection = { ...single, canonicalProjectionPending: true };
  assert.equal(applyCanonicalHydrationPlaceholder(failedProjection, 'error'), failedProjection);
  assert.equal(applyCanonicalHydrationPlaceholder(conversation), conversation);
});

test('ready bounded pages stay visible even when older history remains', () => {
  const page = { ...conversation, messages: Array.from({ length: 50 }, (_, index) => ({
    id: `row-${index}`, role: 'person' as const, text: 'Synthetic row', time: '10:00',
  })) };
  assert.equal(applyCanonicalHydrationPlaceholder(page, 'ready'), page);
  for (const status of ['sending', 'pending_send']) {
    const pendingSend = { ...conversation, messages: [{ role: 'user' as const, text: 'New send', time: '10:00', statusChips: [status] }] };
    assert.equal(applyCanonicalHydrationPlaceholder(pendingSend, 'loading'), pendingSend);
  }
  const liveHead = { ...conversation, messages: [{ role: 'owned-agent' as const, text: 'Processing', time: '10:00', statusChips: ['processing'] }] };
  assert.equal(applyCanonicalHydrationPlaceholder(liveHead, 'loading').messages[0].detail, 'transcript-loading');
});

test('workspace selection consumes page readiness while retaining the sidebar summary', () => {
  let result!: ReturnType<typeof useWorkspaceViewModels>;
  function Probe({ ready }: { ready: boolean }) {
    result = useWorkspaceViewModels({
      isNativeShell: true, isDesktopChatLoading: false, desktopChatState: null,
      desktopCollaborationState: null, canonicalSessionState: null,
      transientChatConversations: [conversation],
      transcriptHydration: { [conversation.id]: ready ? 'ready' : 'loading' },
      hiddenSessionIds: new Set(), projectWorkspaces: [], projectSelectedSessionIds: {},
      activeNav: 'chats', activeConvId: conversation.id, activeProjectId: '', activeProjectSessionId: '',
      chatSearch: '', projectSearch: '', contactSearch: '', activeContactId: '', activeAgentId: '',
      cachedChatSessionMessages: {}, cachedProjectSessionMessages: {}, localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: {}, mapDesktopMessages: () => [],
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe, { ready: false }));
  assert.equal(result.activeConv.messages[0]?.detail, 'transcript-loading');
  assert.equal(result.chatConversations.find(row => row.id === conversation.id)?.messages[0]?.text, 'Catalog head');
  renderToStaticMarkup(createElement(Probe, { ready: true }));
  assert.equal(result.activeConv.messages[0]?.text, 'Catalog head');
});
