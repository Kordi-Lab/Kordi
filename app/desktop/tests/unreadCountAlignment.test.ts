import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { effectiveSessionUnread, totalVisibleUnread } from '../src/features/chat/unreadCounts';
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
