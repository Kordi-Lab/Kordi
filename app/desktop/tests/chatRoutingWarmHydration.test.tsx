import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  applyCanonicalHydrationPlaceholder,
  useWorkspaceViewModels,
} from '../src/app/useWorkspaceViewModels';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';

test('canonical history hydration keeps an already visible latest message in place', () => {
  const selected = {
    id: 'session:group:warm-history',
    canonicalSessionId: 'session:group:warm-history',
    canonicalMessageCount: 239,
    name: 'main',
    type: 'owned-agent' as const,
    subtitle: 'Latest synced message',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: ['Me', 'Alice'],
    messages: [{
      role: 'user' as const,
      isOwnMessage: true,
      text: 'latest message stays visible',
      time: '10:45',
    }],
  };

  const loading = applyCanonicalHydrationPlaceholder(selected, 'loading');

  assert.equal(loading, selected);
  assert.deepEqual(loading.messages.map((message) => message.text), ['latest message stays visible']);
});

test('desktop runtime selection shows a loading notice until its transcript cache is ready', () => {
  const selected = {
    id: 'local-runtime-session',
    name: 'Agent session',
    type: 'owned-agent' as const,
    subtitle: 'Previous summary',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Agent chat',
    participants: ['Me', 'My Kordi'],
    messages: [{ role: 'system' as const, text: 'Session ready', time: '10:00' }],
    desktopRuntimeBacked: true,
    desktopRuntimeTranscriptLoaded: false,
  };

  const loading = applyCanonicalHydrationPlaceholder(selected, undefined);

  assert.deepEqual(loading.messages.map((message) => message.text), ['Loading chat history…']);
  assert.equal(loading.messages[0]?.detail, 'transcript-loading');
});

test('desktop runtime hydration keeps a newly sent request ahead of its live response', () => {
  const selected = {
    id: 'session:direct-agent:stock-trader',
    name: 'US Stock Paper Trader',
    type: 'owned-agent' as const,
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Agent chat',
    participants: ['Me', 'US Stock Paper Trader'],
    messages: [
      { role: 'user' as const, isOwnMessage: true, text: 'who are you', time: '13:08', statusChips: ['sending'] },
      { role: 'owned-agent' as const, sender: 'US Stock Paper Trader', text: 'I am US Stock Paper Trader.', time: '13:08' },
    ],
    desktopRuntimeBacked: true,
    desktopRuntimeTranscriptLoaded: false,
  };

  const loading = applyCanonicalHydrationPlaceholder(selected, 'loading');

  assert.equal(loading, selected);
  assert.deepEqual(loading.messages.map((message) => message.text), [
    'who are you',
    'I am US Stock Paper Trader.',
  ]);
});

test('selected Agent cache is remapped with current identity metadata before native session loading settles', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;

  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        activeSessionId: 'session-a',
        sessions: [
          { id: 'session-a', title: 'First', subtitle: '', updatedAtLabel: '10:00', updatedAtMs: 1, messageCount: 0, draft: false },
          { id: 'session-b', title: 'Second', subtitle: '', updatedAtLabel: '10:01', updatedAtMs: 2, messageCount: 1, draft: false },
        ],
        projects: [],
        activeSession: {
          id: 'session-a',
          title: 'First',
          subtitle: '',
          updatedAtLabel: '10:00',
          updatedAtMs: 1,
          messageCount: 0,
          draft: false,
          project: null,
          messages: [],
        },
        localAgent: { label: 'My Kordi' },
      } as never,
      desktopCollaborationState: null,
      canonicalSessionState: {
        storagePath: '/tmp/canonical.sqlite3',
        profile: {
          id: 'profile:me',
          displayName: 'Me',
          humanIdentityId: 'human:me',
          activeAgentIdentityId: 'agent:me',
          storageRoot: '/tmp',
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        identities: [],
        sessions: [{
          id: 'session-b',
          kind: 'self-agent',
          title: 'Second',
          status: 'active',
          createdByIdentityId: 'human:me',
          metadata: { cloudAgentId: 'agent:research', cloudAgentName: 'Research Kordi' },
          createdAtMs: 1,
          updatedAtMs: 2,
          lastMessageAtMs: 2,
        }],
        participants: [],
        messages: [],
        delegatedExchanges: [],
        presence: [],
        contextSnapshots: [],
      },
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'session-b',
      activeProjectId: '',
      activeProjectSessionId: '',
      chatSearch: '',
      projectSearch: '',
      contactSearch: '',
      activeContactId: '',
      activeAgentId: '',
      cachedChatSessionMessages: {
        'session-b': [{ id: 'cached-row', role: 'owned-agent', sender: 'Kordi', text: 'Stable answer', time: '10:01' }],
      },
      cachedProjectSessionMessages: {},
      cachedDesktopSessionSourceMessages: {
        'session-b': [{
          role: 'assistant',
          text: 'Stable answer',
          sender: 'Kordi',
          timeLabel: '10:01',
          timestampMs: 2,
          transcriptRenderId: 'cached-row',
        }],
      },
      localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: {},
      mapDesktopMessages: (sessionId, messages, context) => (
        mapDesktopMessagesForTranscript(sessionId, messages, undefined, context)
      ),
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.equal(viewModels?.activeConv.id, 'session-b');
  assert.equal(viewModels?.activeConv.messages[0]?.sender, 'Research Kordi');
  assert.equal(viewModels?.activeConv.messages[0]?.text, 'Stable answer');
});
