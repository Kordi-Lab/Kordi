import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { conversation, baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('WorkspaceSidebar auto-expands an active space without replacing its other sessions', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:wrong',
      canonicalSessionId: 'session:group:wrong',
      name: 'Wrong group',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 3,
    }),
    conversation({
      id: 'session:self-agent:old-note',
      canonicalSessionId: 'session:self-agent:old-note',
      name: 'Old note',
      type: 'owned-agent',
      subtitle: 'Remember this',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [{ role: 'person', sender: 'Me', text: 'Remember this', time: '09:00' }],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:self-agent:selected-reviewer',
      canonicalSessionId: 'session:self-agent:selected-reviewer',
      name: 'Reviewer',
      type: 'owned-agent',
      subtitle: 'New session',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [],
      _updatedAtMs: 4,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:self-agent:selected-reviewer',
    initialSelectedParticipantSpaceId: null,
  }) as never));

  assert.match(markup, /My chats/);
  assert.match(markup, /aria-label="Expand My chats"/);
  assert.match(markup, /# Reviewer/);
  assert.match(markup, /# Old note/);
});

test('WorkspaceSidebar auto-expanded group keeps every sibling session visible', () => {
  const sharedParticipants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self' as const, source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const, avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const, avatarKey: 'bob' },
  ];
  const chatConversations = [
    conversation({
      id: 'session:group:testtest',
      canonicalSessionId: 'session:group:testtest',
      name: 'testtest',
      subtitle: '7 messages',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: sharedParticipants,
      messages: [{ role: 'person', sender: 'Alice', text: 'testtest', time: '10:00' }],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:group:hiiiii',
      canonicalSessionId: 'session:group:hiiiii',
      name: 'hiiiii',
      subtitle: '34 messages',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: sharedParticipants,
      messages: [{ role: 'person', sender: 'Bob', text: 'hiiiii', time: '09:00' }],
      _updatedAtMs: 1,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group:testtest',
    initialSelectedParticipantSpaceId: null,
  }) as never));

  assert.match(markup, /# testtest/);
  assert.match(markup, /# hiiiii/);
});

test('WorkspaceSidebar explicit expansion shows all sessions in the active My chats space', () => {
  const chatConversations = [
    conversation({
      id: 'session:self-agent:old-note',
      canonicalSessionId: 'session:self-agent:old-note',
      name: 'Old note',
      type: 'owned-agent',
      subtitle: 'Remember this',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [{ role: 'person', sender: 'Me', text: 'Remember this', time: '09:00' }],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:self-agent:selected-reviewer',
      canonicalSessionId: 'session:self-agent:selected-reviewer',
      name: 'Reviewer',
      type: 'owned-agent',
      subtitle: 'New session',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [],
      _updatedAtMs: 4,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const notesSpace = participantSpaces.find((space) => space.kind === 'self');
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:self-agent:selected-reviewer',
    initialSelectedParticipantSpaceId: notesSpace?.id,
  }) as never));

  assert.match(markup, /aria-label="Collapse My chats"/);
  assert.match(markup, /# Reviewer/);
  assert.match(markup, /# Old note/);
});

test('WorkspaceSidebar expanded group space keeps contextual create on the first-page row and rich child previews', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:old',
      canonicalSessionId: 'session:group:old',
      name: 'Old group thread',
      subtitle: 'Old group preview',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:new',
      canonicalSessionId: 'session:group:new',
      name: 'New group thread',
      subtitle: 'New group preview',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      messages: [{ role: 'person', sender: 'Alice', text: 'New group preview', time: '10:00' }],
      updatedAtLabel: '10:00',
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.doesNotMatch(markup, /Page 2/);
  assert.doesNotMatch(markup, /Back to chats/);
  assert.match(markup, /data-participant-space-row-actions="true"/);
  assert.match(markup, /aria-label="Create session in Alice, Bob"/);
  assert.match(markup, /data-participant-space-context-create="true"/);
  assert.match(markup, /data-session-preview="New group preview"/);
  assert.match(markup, /data-session-updated-at="10:00"/);
});

test('WorkspaceSidebar grays and disables group create while a blank New chat already exists', () => {
  const renderCreateButton = (hasMessage: boolean) => {
    const chatConversations = [conversation({
      id: 'session:group:new-chat',
      canonicalSessionId: 'session:group:new-chat',
      canonicalMessageCount: hasMessage ? 1 : 0,
      name: 'New chat',
      subtitle: hasMessage ? 'Start the topic' : '',
      messages: hasMessage
        ? [{ role: 'person', sender: 'Me', text: 'Start the topic', time: '16:05' }]
        : [],
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    })];
    const participantSpaces = buildParticipantSpaces(chatConversations);
    const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
      chatConversations,
      participantSpaces,
      contactParticipantSpaces: participantSpaces,
      activeConvId: 'session:group:new-chat',
      initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
    }) as never));
    const marker = markup.indexOf('data-participant-space-context-create="true"');
    const buttonStart = markup.lastIndexOf('<button', marker);
    return markup.slice(buttonStart, markup.indexOf('</button>', marker));
  };

  const disabledButton = renderCreateButton(false);
  const enabledButton = renderCreateButton(true);
  const shellCss = readDesktopShellCss();

  assert.match(disabledButton, /disabled=""/);
  assert.match(disabledButton, /aria-label="New session unavailable in Alice, Bob: a blank chat already exists"/);
  assert.doesNotMatch(enabledButton, /disabled=""/);
  assert.match(shellCss, /\.app-participant-space-context-create:disabled[\s\S]*?cursor:\s*not-allowed;[\s\S]*?opacity:\s*0\.38;/);
});

test('WorkspaceSidebar selected group header exposes details and hashtag child sessions', () => {
  const chatConversations = [conversation({
    id: 'session:group-selected',
    canonicalSessionId: 'session:group-selected',
    name: 'Hi taylor',
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-selected',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));
  const sessionRowStart = markup.indexOf('data-testid="participant-space-session-row"');
  const sessionRowMarkup = markup.slice(sessionRowStart, markup.indexOf('</button>', sessionRowStart));

  assert.match(markup, /aria-label="Open group management"/);
  assert.ok(markup.indexOf('aria-label="Open group management"') < markup.indexOf('aria-label="Create session in Alice, Bob"'));
  assert.match(markup, /data-participant-space-row-actions="true"/);
  assert.match(markup, /# Hi taylor/);
  assert.match(sessionRowMarkup, /data-session-id-label="Group chat"/);
  assert.doesNotMatch(sessionRowMarkup, /app-participant-space-session-id/);
  assert.doesNotMatch(sessionRowMarkup, />Group chat<\//);
});

test('WorkspaceSidebar group child titles avoid native tooltips that destabilize hover', () => {
  const chatConversations = [conversation({
    id: 'session:group-hover-stable',
    canonicalSessionId: 'session:group-hover-stable',
    name: 'Stable hover',
    type: 'group',
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-hover-stable',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));
  const sessionRowStart = markup.indexOf('data-testid="participant-space-session-row"');
  const sessionRowMarkup = markup.slice(sessionRowStart, markup.indexOf('</button>', sessionRowStart));

  assert.match(sessionRowMarkup, /app-participant-space-session-title[^>]*># Stable hover<\/span>/);
  assert.doesNotMatch(sessionRowMarkup, /app-participant-space-session-title[^>]*\stitle=/);
});
