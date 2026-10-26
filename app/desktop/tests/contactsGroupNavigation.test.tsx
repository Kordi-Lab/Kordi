import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { ContactsPage } from '../src/kordi-app/contacts/ContactsPage';
import type { ParticipantSpaceViewModel } from '../src/kordi-app/types';
import { useWorkspaceChatSidebarModel } from '../src/pages/workspaceSidebar.chatModel';
import { contactsPageProps } from './helpers/contactsPageFixtures';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';

test('Contacts offers channels before navigating and opens the chosen nonfirst channel', async () => {
  const environment = installDom();
  const conversations = ['main', 'planning', 'other'].map((name) => conversation({
    id: `session:${name}`, canonicalSessionId: `session:${name}`, name, type: 'group',
    participantSpaceId: name === 'other' ? 'group:other' : 'group:team',
    metadata: { customName: name === 'other' ? 'Other group' : 'Team' },
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
  const calls: string[] = [];
  const shell = assembleMainContentSlot({
    activeNav: 'contacts', composerProviderOptions: [],
    setActiveNav: (nav: string) => calls.push(`nav:${nav}`),
    handleSelectChatSession: async (id: string) => { calls.push(`select:${id}`); },
  } as never) as unknown as {
    props: { contactsPageProps: { onOpenGroup: (space: ParticipantSpaceViewModel, sessionId: string) => void } };
  };
  let model!: ReturnType<typeof useWorkspaceChatSidebarModel>;
  function Harness() {
    model = useWorkspaceChatSidebarModel(chats);
    return <ContactsPage {...contactsPageProps({ groupSpaces: spaces, onOpenGroup: shell.props.contactsPageProps.onOpenGroup })} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const groupRow = () => [...host.querySelectorAll<HTMLButtonElement>('.app-group-row')]
    .find((button) => button.textContent?.includes(target.title))!;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const dialogButton = (text: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(text))!;
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      model.setParticipantSpaceExpanded(target.id, false);
      model.setParticipantSpaceExpanded(other.id, false);
    });
    groupRow().focus();
    await act(async () => groupRow().click());
    assert.deepEqual(calls, [], 'opening the group must not select its first channel');
    assert.ok(dialog()?.textContent?.includes('Choose a channel'));
    assert.ok(dialogButton('# main'));
    assert.ok(dialogButton('# planning'));
    assert.equal(model.isParticipantSpaceExpanded(target), false);

    await act(async () => dialogButton('Back to Contacts').click());
    assert.equal(dialog(), null);
    assert.equal(document.activeElement, groupRow());
    assert.deepEqual(calls, []);
    await act(async () => groupRow().click());
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(dialog(), null);
    assert.deepEqual(calls, [], 'dismissal does not navigate');

    await act(async () => groupRow().click());
    await act(async () => dialogButton('# planning').click());
    assert.equal(dialog(), null);
    assert.deepEqual(calls, ['nav:chats', 'select:session:planning']);
    assert.equal(model.isParticipantSpaceExpanded(target), true);
    assert.equal(model.isParticipantSpaceExpanded(other), false);
    assert.deepEqual(model.contactSidebarRows.flatMap((row) => row.kind === 'session' ? [row.sessionId] : []), [
      'session:main', 'session:planning',
    ]);

    await act(async () => model.setParticipantSpaceExpanded(target.id, false));
    await act(async () => root.render(<Harness />));
    assert.equal(model.isParticipantSpaceExpanded(target), false, 'ordinary refresh preserves manual collapse');
    await act(async () => groupRow().click());
    await act(async () => dialogButton('# main').click());
    assert.equal(model.isParticipantSpaceExpanded(target), true, 'choosing the already active channel also expands its group');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    environment.restore();
  }
});
