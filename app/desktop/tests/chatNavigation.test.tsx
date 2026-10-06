import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chatNavigationForConversation, chatNavigationIndex, conversationIdAfterRemoval, reconcileChatNavigation,
  selectChatConversation, selectChatNavigation, type ChatNavigationState,
} from '../src/features/chat/chatNavigation';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { buildParticipantSpaces, filterParticipantSpaces } from '../src/features/chat/participantSpaces';
import { conversation, baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '../src/features/chat/draftSessions';

const agent = conversation({
  id: 'agent-session', canonicalSessionId: 'canonical-agent', type: 'owned-agent',
  name: 'Review navigation', unread: 3,
  canonicalParticipants: [
    { id: 'me', name: 'Me', kind: 'human', role: 'self', source: 'local' },
    { id: 'agent', name: 'Kordi', kind: 'agent', role: 'owned-agent', source: 'local' },
  ],
});
const person = conversation({ id: 'person-session', canonicalSessionId: 'canonical-person', unread: 2 });
const group = conversation({ ...agent, id: 'group-session', canonicalSessionId: 'canonical-group', participantSpaceId: 'group-team', name: 'Team' });
const index = chatNavigationIndex([agent, person, group]);

test('direct agent conversations use Agent Chats; people and groups with agents use Chats', () => {
  assert.equal(chatNavigationForConversation(agent), 'agent-chats');
  assert.equal(chatNavigationForConversation(person), 'chats');
  assert.equal(chatNavigationForConversation(group), 'chats');
  assert.equal(index.get('canonical-agent'), 'agent-chats');
});

test('switching destinations restores each selected session', () => {
  const initial: ChatNavigationState = { activeNav: 'agent-chats', activeConvId: agent.id, selections: { chats: person.id, 'agent-chats': agent.id } };
  let state = selectChatNavigation(initial, 'chats', index);
  assert.equal(state.activeConvId, person.id);
  state = selectChatConversation(state, group.id, index);
  state = selectChatNavigation(state, 'agent-chats', index);
  assert.equal(state.activeConvId, agent.id);
  state = selectChatNavigation(state, 'chats', index);
  assert.equal(state.activeConvId, group.id);
});

test('notifications route known sessions immediately and resolve unknown sessions after hydration', () => {
  const initial: ChatNavigationState = { activeNav: 'chats', activeConvId: person.id, selections: { chats: person.id, 'agent-chats': '' } };
  assert.equal(selectChatConversation(initial, agent.id, index).activeNav, 'agent-chats');
  const pending = selectChatConversation(initial, 'canonical-agent', new Map());
  assert.equal(pending.activeConvId, 'canonical-agent');
  const hydrated = reconcileChatNavigation(pending, index);
  assert.equal(hydrated.activeConvId, 'canonical-agent');
  assert.equal(hydrated.activeNav, 'agent-chats');
});

test('an empty destination remains empty instead of selecting a conversation from the other tab', () => {
  const initial: ChatNavigationState = { activeNav: 'agent-chats', activeConvId: agent.id, selections: { chats: '', 'agent-chats': agent.id } };
  const state = selectChatNavigation(initial, 'chats', chatNavigationIndex([agent]));
  assert.equal(state.activeNav, 'chats');
  assert.equal(state.activeConvId, '');
});

test('removing a remembered session selects another session in the same destination', () => {
  const initial: ChatNavigationState = { activeNav: 'agent-chats', activeConvId: agent.id, selections: { chats: person.id, 'agent-chats': agent.id } };
  const remaining = chatNavigationIndex([agent, group]);
  const refreshed = reconcileChatNavigation(initial, remaining, index);
  assert.equal(selectChatNavigation(refreshed, 'chats', remaining).activeConvId, group.id);
});

test('archiving or deleting a session keeps the selection in its destination', () => {
  assert.equal(conversationIdAfterRemoval([agent, person, group], person.canonicalSessionId!, agent.id), group.id);
  assert.equal(conversationIdAfterRemoval([agent, person], person.id, agent.id), '');
  assert.equal(conversationIdAfterRemoval([agent, person], agent.id, person.id), LOCAL_DRAFT_CHAT_CONVERSATION_ID);
  assert.equal(conversationIdAfterRemoval([agent, person], 'pending-session', person.id), person.id);
});

test('the actual sidebar has separate navigation and unread badges with compact avatar-free agent rows', () => {
  const spaces = buildParticipantSpaces([agent, person]);
  const props = baseSidebarProps({
    activeNav: 'agent-chats', initialChatChannel: 'agent', activeConvId: agent.id,
    chatConversations: [agent, person], participantSpaces: spaces,
    agentParticipantSpaces: filterParticipantSpaces(spaces, '', 'agent'),
    contactParticipantSpaces: filterParticipantSpaces(spaces, '', 'contact'),
  });
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, props as never));
  assert.match(markup, /aria-label="Agent Chats, 3 unread messages"/);
  assert.match(markup, /aria-label="Chats, 2 unread messages"/);
  assert.match(markup, /data-agent-session-row="agent-session"/);
  assert.doesNotMatch(markup, /app-filter-tabs|agent-avatar|data-avatar-kind="agent"/);
});

test('navigation unread badges include sessions hidden by a search query', () => {
  const spaces = buildParticipantSpaces([agent, person]);
  const props = baseSidebarProps({
    activeNav: 'agent-chats', initialChatChannel: 'agent', chatSearch: 'no matching session',
    chatConversations: [agent, person], participantSpaces: spaces,
    agentParticipantSpaces: filterParticipantSpaces(spaces, '', 'agent'),
    contactParticipantSpaces: filterParticipantSpaces(spaces, '', 'contact'),
  });
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, props as never));
  assert.match(markup, /aria-label="Agent Chats, 3 unread messages"/);
  assert.match(markup, /aria-label="Chats, 2 unread messages"/);
  assert.doesNotMatch(markup, /data-agent-session-row="agent-session"/);
});
