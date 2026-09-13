import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { effectiveSessionUnread, sessionsForGlobalAttention, totalVisibleUnread } from '../src/features/chat/unreadCounts';
import { buildWorkspaceChatListViewModels } from '../src/app/workspaceChatListViewModels';
import { newMessageAttentionEvents } from '../src/features/notifications/messageAttentionPolicy';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('visible unread totals exclude muted sessions', () => {
  const sessions = [
    { id: 'active', unread: 4 },
    { id: 'muted', unread: 3 },
    { id: 'manual', unread: 0 },
  ];
  const muted = new Set(['muted']);
  const markedUnread = new Set(['manual']);

  assert.equal(effectiveSessionUnread(sessions[1], muted, markedUnread), 0);
  assert.equal(totalVisibleUnread(sessions, muted, markedUnread), 5);
});

test('group, channel, navigation, and native totals ignore muted and archived channels', () => {
  const participants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self' as const, source: 'local', avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person' as const, source: 'cloud', avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person' as const, source: 'cloud', avatarKey: 'bob' },
  ];
  const active = conversation({
    id: 'session:group:alignment', canonicalSessionId: 'session:group:alignment', name: 'Alignment', unread: 4,
    canonicalParticipants: participants, metadata: { groupSpaceId: 'session:group:alignment' },
  });
  const muted = conversation({
    id: 'session:group:alignment-muted', canonicalSessionId: 'session:group:alignment-muted', name: 'Muted channel', unread: 3,
    canonicalParticipants: participants, metadata: { groupSpaceId: 'session:group:alignment' },
  });
  const conversations = [active, muted];
  const spaces = buildParticipantSpaces(conversations);
  const archivedSpaces = buildParticipantSpaces([
    conversation({ id: 'archived', canonicalSessionId: 'archived', unread: 8 }),
  ]);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations: conversations,
    participantSpaces: spaces,
    contactParticipantSpaces: spaces,
    archivedParticipantSpaces: archivedSpaces,
    mutedSessionIds: new Set([muted.id]),
    activeConvId: '',
  }) as never));

  assert.equal(totalVisibleUnread(conversations, new Set([muted.id]), new Set()), 4);
  assert.match(markup, /data-unread-scope="channel-tab" data-unread-count="4"/);
  assert.match(markup, /data-unread-scope="participant-space" data-unread-count="4"/);
});

test('opening an archived conversation preserves its unread state without global badges or attention', () => {
  const archived = conversation({
    id: 'archived-ui', canonicalSessionId: 'archived-session', name: 'Archived chat', unread: 2,
    messages: [{ id: 'archived-message', role: 'person', sender: 'Alice', text: 'Hello', time: '' }],
  });
  for (const archivedId of [archived.id, archived.canonicalSessionId!]) {
    const archivedIds = new Set([archivedId]);
    const model = buildWorkspaceChatListViewModels({
      activeConversationId: archived.id,
      allConversations: [archived],
      archivedSessionIds: archivedIds,
      hiddenSessionIds: archivedIds,
      localAgentReachoutSessionIds: new Set(),
      avatarSeed: 'test', chatSearch: '',
    });
    assert.equal(model.chatConversations[0]?.unread, 2);
    assert.equal(model.archivedParticipantSpaces.flatMap(space => space.sessions)[0]?.unread, 2);
    assert.equal(model.participantSpaces.flatMap(space => space.sessions).length, 0);
    const attention = sessionsForGlobalAttention(model.chatConversations, archivedIds);
    assert.equal(totalVisibleUnread(attention, new Set(), new Set([archivedId])), 0);
    assert.deepEqual(newMessageAttentionEvents({ previous: {}, conversations: attention }), []);

    const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
      chatConversations: model.chatConversations,
      participantSpaces: model.participantSpaces,
      contactParticipantSpaces: model.contactParticipantSpaces,
      archivedParticipantSpaces: model.archivedParticipantSpaces,
      activeConvId: archived.id,
      unreadSessionIds: new Set([archivedId]),
    }) as never));
    assert.doesNotMatch(markup, /data-unread-count="2"/);
    const chatButton = markup.match(/<button[^>]*aria-label="Chats"[^>]*>[\s\S]*?<\/button>/)?.[0];
    assert.ok(chatButton);
    assert.doesNotMatch(chatButton, />2<\/span>/);

    const restored = sessionsForGlobalAttention(model.chatConversations, new Set());
    assert.equal(totalVisibleUnread(restored, new Set(), new Set()), 2);
    assert.equal(newMessageAttentionEvents({ previous: {}, conversations: restored }).length, 1);
  }
});
