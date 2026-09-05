import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { conversation, baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('WorkspaceSidebar keeps group child host rows mounted across parent refreshes', () => {
  const source = readFileSync(new URL('../src/pages/workspaceSidebar.contactRows.tsx', import.meta.url), 'utf8');

  assert.match(source, /function ParticipantSpaceSessionRow\(\{/);
  assert.match(source, /const row = model\.allSidebarSessionRowsById\.get\(descriptor\.sessionId\);/);
  assert.match(source, /<ParticipantSpaceSessionRow[\s\S]*session=\{row\.session\}[\s\S]*space=\{row\.space\}/);
});

test('WorkspaceSidebar aligns child session hashtags and shows only the latest-message preview', () => {
  const chatConversations = [
    conversation({
      id: 'session:group-duplicate-preview',
      canonicalSessionId: 'session:group-duplicate-preview',
      name: 'Dinner plans',
      subtitle: 'Dinner plans',
      messages: [{ role: 'person', sender: 'Alice', text: 'Dinner plans', time: '16:02' }],
      participants: ['Me', 'Alice', 'Bob'],
      canonicalMessageCount: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-duplicate-preview',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));
  const shellCss = readDesktopShellCss();

  assert.doesNotMatch(markup, /pl-\[3\.25rem\]/);
  assert.match(markup, /# Dinner plans/);
  assert.match(markup, /data-session-preview-line="Dinner plans"/);
  assert.doesNotMatch(markup, /data-session-message-count/);
  assert.doesNotMatch(markup, /Dinner plans · 1 message/);
  assert.doesNotMatch(markup, /Group •/);
  assert.match(markup, /data-session-id-label="Group chat"/);
  assert.doesNotMatch(markup, /Session ID: session:group-duplicate-preview/);
  assert.match(markup, /app-participant-space-session-preview/);
  assert.match(markup, /app-participant-space-session-title/);
  assert.match(markup, /app-participant-space-session-side/);
  assert.doesNotMatch(markup, /app-participant-space-session-fork/);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\s*{[^}]*display:\s*grid/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-main\s*{[^}]*min-width:\s*0/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-side\s*{[^}]*display:\s*inline-flex/s);
  assert.match(shellCss, /\.app-participant-space-session-title\s*{[^}]*color:\s*var\(--app-sidebar-title-text\);[^}]*font-weight:\s*600/s);
});

test('WorkspaceSidebar names group spaces from people and hides agents from the participant row', () => {
  const chatConversations = [
    conversation({
      id: 'session:group-with-agent',
      canonicalSessionId: 'session:group-with-agent',
      name: 'hi taylor',
      subtitle: 'session:bridge:humans:8e32e6b4-b8e7-4591-a412-8613ad09fe25',
      messages: [],
      participants: ['Me', 'member1', 'member2', 'Helper Kordi'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:member1', name: 'member1', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'member1' },
        { id: 'human:member2', name: 'member2', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'member2' },
        { id: 'agent:helper-kordi', name: 'Helper Kordi', kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'helper-kordi' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-with-agent',
  }) as never));

  assert.match(markup, /member1, member2/);
  assert.match(markup, /aria-label="Collapse member1, member2"/);
  assert.match(markup, /aria-label="Create session in member1, member2"/);
  assert.doesNotMatch(markup, /Group • 3 people • 1 session/);
  assert.doesNotMatch(markup, /Helper Kordi/);
  assert.doesNotMatch(markup, /session:bridge:humans/);
});
