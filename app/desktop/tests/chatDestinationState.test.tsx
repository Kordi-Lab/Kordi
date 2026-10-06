import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWorkspaceController } from '../src/app/useWorkspaceController';
import { useKordiLocalUiState } from '../src/app/useKordiLocalUiState';
import { chatNavigationIndex } from '../src/features/chat/chatNavigation';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { useWorkspaceChatSidebarModel } from '../src/pages/workspaceSidebar.chatModel';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { installDom } from './support/virtualSidebarHarness';

const agent = conversation({
  id: 'agent-session', canonicalSessionId: 'agent-session', type: 'owned-agent', name: 'Review navigation',
  canonicalParticipants: [
    { id: 'me', name: 'Me', kind: 'human', role: 'self', source: 'local' },
    { id: 'agent', name: 'Kordi', kind: 'agent', role: 'owned-agent', source: 'local' },
  ],
});
const person = conversation({ id: 'person-session', canonicalSessionId: 'person-session' });
const conversations = [agent, person];
const index = chatNavigationIndex(conversations);
const sidebarProps = baseSidebarProps({ chatConversations: conversations, participantSpaces: buildParticipantSpaces(conversations) });

let root: Root | null = null;

test.before(() => {
  installDom();
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
});
test.afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

test('the actual hooks keep search, archive visibility, and selection separate for each destination', async () => {
  let current: {
    navigation: ReturnType<typeof useWorkspaceController>;
    localUi: ReturnType<typeof useKordiLocalUiState>;
    sidebar: ReturnType<typeof useWorkspaceChatSidebarModel>;
  };
  function Harness() {
    const navigation = useWorkspaceController({ initialProjects: [], isNativeShell: true });
    const localUi = useKordiLocalUiState(navigation.activeNav);
    const sidebar = useWorkspaceChatSidebarModel({
      ...sidebarProps.chats,
      chatSearch: localUi.chatsUi.chatSearch,
      activeConvId: navigation.activeConvId,
    }, { chatChannel: navigation.activeNav === 'chats' ? 'contact' : 'agent' });
    const updateIndex = navigation.updateChatNavigationIndex;
    useEffect(() => updateIndex(index), [updateIndex]);
    current = { navigation, localUi, sidebar };
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));

  await act(async () => {
    current.navigation.setActiveConvId(agent.id);
    current.localUi.chatsUi.setChatSearch('navigation');
    current.sidebar.setShowArchived(true);
  });
  await act(async () => current.navigation.setActiveNav('chats'));
  assert.equal(current!.navigation.activeConvId, person.id);
  assert.equal(current!.localUi.chatsUi.chatSearch, '');
  assert.equal(current!.sidebar.showArchived, false);
  await act(async () => current.localUi.chatsUi.setChatSearch('person'));

  await act(async () => current.navigation.setActiveNav('agent-chats'));
  assert.equal(current!.navigation.activeConvId, agent.id);
  assert.equal(current!.localUi.chatsUi.chatSearch, 'navigation');
  assert.equal(current!.sidebar.showArchived, true);
  await act(async () => current.navigation.setActiveNav('chats'));
  assert.equal(current!.localUi.chatsUi.chatSearch, 'person');
  assert.equal(current!.sidebar.showArchived, false);
});
