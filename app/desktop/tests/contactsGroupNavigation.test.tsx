import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { ParticipantSpaceViewModel } from '../src/kordi-app/types';
import { useWorkspaceChatSidebarModel } from '../src/pages/workspaceSidebar.chatModel';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { installDom } from './support/virtualSidebarHarness';

test('opening a collapsed group from Contacts reveals its channels, including when already active', async () => {
  installDom();
  const conversations = ['main', 'planning', 'other'].map((name) => conversation({
    id: `session:${name}`, canonicalSessionId: `session:${name}`, name, type: 'group',
    participantSpaceId: name === 'other' ? 'group:other' : 'group:team',
    _updatedAtMs: name === 'main' ? 3 : 2,
  }));
  const spaces = buildParticipantSpaces(conversations);
  const target = spaces.find((space) => space.id === 'group:team')!;
  const other = spaces.find((space) => space.id === 'group:other')!;
  assert.ok(target && other);
  const chats = baseSidebarProps({
    chatConversations: conversations, participantSpaces: spaces,
    contactParticipantSpaces: spaces, activeConvId: 'session:main',
  }).chats;
  let model!: ReturnType<typeof useWorkspaceChatSidebarModel>;
  function Harness() {
    model = useWorkspaceChatSidebarModel(chats);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: string[] = [];
  // Exercise the actual Contacts callback without mounting unrelated shell pages.
  const shell = assembleMainContentSlot({
    activeNav: 'contacts', composerProviderOptions: [],
    setActiveNav: (nav: string) => calls.push(`nav:${nav}`),
    handleSelectChatSession: async (id: string) => { calls.push(`select:${id}`); },
  } as never) as unknown as {
    props: { contactsPageProps: { onOpenGroup: (space: ParticipantSpaceViewModel) => void } };
  };
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      model.setParticipantSpaceExpanded(target.id, false);
      model.setParticipantSpaceExpanded(other.id, false);
    });
    assert.equal(model.isParticipantSpaceExpanded(target), false);
    assert.equal(model.contactSidebarRows.filter((row) => row.kind === 'session').length, 0);

    await act(async () => shell.props.contactsPageProps.onOpenGroup(target));
    assert.deepEqual(calls, ['nav:chats', 'select:session:main']);
    assert.equal(model.isParticipantSpaceExpanded(target), true);
    assert.equal(model.isParticipantSpaceExpanded(other), false);
    assert.deepEqual(model.contactSidebarRows.flatMap((row) => row.kind === 'session' ? [row.sessionId] : []), [
      'session:main', 'session:planning',
    ]);

    await act(async () => model.setParticipantSpaceExpanded(target.id, false));
    await act(async () => root.render(<Harness />));
    assert.equal(model.isParticipantSpaceExpanded(target), false, 'ordinary refresh preserves manual collapse');
    await act(async () => shell.props.contactsPageProps.onOpenGroup(target));
    assert.equal(model.isParticipantSpaceExpanded(target), true, 'each explicit open reveals the same active group again');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
