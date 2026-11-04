import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { buildParticipantSpaces, filterParticipantSpaces } from '../src/features/chat/participantSpaces';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';

const chatConversations = [conversation({
  id: 'session:group-synthetic', canonicalSessionId: 'session:group-synthetic',
  name: 'Synthetic picnic', participants: ['Me', 'Alice'],
  canonicalParticipants: [
    { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
  ],
})];
const spaces = buildParticipantSpaces(chatConversations);
const props = (chatSearch: string, setChatSearch = (_value: unknown) => {}) => baseSidebarProps({
  chatSearch, setChatSearch, chatConversations, participantSpaces: spaces, contactParticipantSpaces: filterParticipantSpaces(spaces, chatSearch, 'contact'),
});

test('a nonmatching conversation search offers clear search and restores existing conversations', async () => {
  const { restore } = installDom();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [query, setQuery] = useState('no-such-synthetic-title');
    return <WorkspaceSidebar {...props(query, setQuery) as never} />;
  }
  try {
    assert.match(renderToStaticMarkup(<WorkspaceSidebar {...props('picnic') as never} />), /Alice/);
    await act(async () => root.render(<Harness />));
    assert.match(host.textContent!, /No matching conversations/);
    assert.doesNotMatch(host.textContent!, /No conversations yet|Start a chat to see it here/);
    const clear = [...host.querySelectorAll('button')].find(button => button.textContent === 'Clear search');
    assert.ok(clear);
    await act(async () => clear.click());
    assert.match(host.textContent!, /Alice/);
    assert.doesNotMatch(host.textContent!, /No matching conversations/);
  } finally { await act(async () => root.unmount()); restore(); }
});

test('empty accounts keep their onboarding copy and agent search uses the same no-match state', () => {
  for (const channel of ['contact', 'agent']) {
    const render = (query: string) => renderToStaticMarkup(<WorkspaceSidebar {...baseSidebarProps({
      initialChatChannel: channel, activeNav: channel === 'agent' ? 'agent-chats' : 'chats',
      chatSearch: query, chatConversations: [], participantSpaces: [],
      contactParticipantSpaces: [], agentParticipantSpaces: [],
    }) as never} />);
    assert.match(render('not-a-match'), /No matching conversations/);
    assert.doesNotMatch(render('not-a-match'), /Start (a chat|one) to see it here/);
    assert.doesNotMatch(render('   '), /No matching conversations/);
    assert.match(render('   '), /No (agent )?conversations yet/);
  }
});
