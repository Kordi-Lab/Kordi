import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useWorkspaceController } from '../src/app/useWorkspaceController';
import { activeConversationForSelection } from '../src/app/viewModels/conversationSelection';
import { chatNavigationIndex } from '../src/features/chat/chatNavigation';
import { useDesktopSessionController } from '../src/features/chat/useDesktopSessionController';
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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const staleOutcome of ['success', 'failure'] as const) {
  test(`native Contacts selection commits before cloud loading and ignores stale ${staleOutcome}`, async () => {
    const environment = installDom();
    const conversations = ['main', 'planning'].map((name) => conversation({
      id: `session:group:team:${name}`, canonicalSessionId: `session:group:team:${name}`,
      name, type: 'group', participantSpaceId: 'group:team', metadata: { customName: 'Team' },
      messages: [{ role: 'person', sender: 'Member', text: `${name} transcript`, time: '09:00' }],
      _updatedAtMs: name === 'main' ? 2 : 1,
    }));
    const [main, planning] = conversations;
    const spaces = buildParticipantSpaces(conversations);
    const hydration = new Map(conversations.map(({ id }) => [id, deferred()]));
    const pins = new Map(conversations.map(({ id }) => [id, deferred()]));
    let workspace!: ReturnType<typeof useWorkspaceController>;
    let controller!: ReturnType<typeof useDesktopSessionController>;
    let currentError: string | null = null;
    function Harness() {
      workspace = useWorkspaceController({ initialProjects: [], isNativeShell: true });
      const [error, setError] = useState<string | null>(null);
      currentError = error;
      controller = useDesktopSessionController({
        isNativeShell: true, activeConversationUsesCollaboration: true,
        activeConvId: workspace.activeConvId, desktopChatState: null, desktopSessionRenameDraft: '',
        selectProjectSession: () => {}, refreshDesktopChat: async () => {},
        hydrateCanonicalSessionPage: (id) => hydration.get(id)!.promise,
        prepareCloudSessionPin: (id) => pins.get(id)!.promise,
        isDesktopSessionTranscriptCached: () => false, preloadDesktopSessionTranscript: async () => false,
        shouldAutoFollowChatRef: { current: false }, setActiveConvId: workspace.setActiveConvId,
        setPendingUserChatMessage: () => {}, setChatComposerAttachments: () => {},
        setDesktopChatError: setError, setDesktopChatState: () => {}, setComposerDrafts: () => {},
        setOpenComposerSelector: () => {}, setDesktopSessionRenameDraft: () => {},
        setIsEditingDesktopSessionTitle: () => {},
      });
      const shell = assembleMainContentSlot({
        activeNav: 'contacts', composerProviderOptions: [], setActiveNav: workspace.setActiveNav,
        handleSelectChatSession: controller.handleSelectChatSession,
      } as never) as unknown as {
        props: { contactsPageProps: { onOpenGroup: (space: ParticipantSpaceViewModel, id: string) => void } };
      };
      const selected = activeConversationForSelection(workspace.activeConvId, conversations, {
        isNativeShell: true, nativeChatPlaceholder: main,
      });
      return workspace.activeNav === 'contacts'
        ? <ContactsPage {...contactsPageProps({ groupSpaces: spaces, onOpenGroup: shell.props.contactsPageProps.onOpenGroup })} />
        : <div data-selected={selected.id}>{selected.name}: {selected.messages[0]?.text}</div>;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => {
        workspace.updateChatNavigationIndex(chatNavigationIndex(conversations));
        workspace.setActiveNav('chats');
        workspace.setActiveConvId(main.id);
      });
      await act(async () => workspace.setActiveNav('contacts'));
      await act(async () => host.querySelector<HTMLButtonElement>('.app-group-row')!.click());
      assert.equal(workspace.activeConvId, main.id, 'opening the chooser preserves the prior selection');
      const choices = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button');
      assert.ok(choices[1].textContent?.includes('planning'));
      await act(async () => choices[1].click());
      assert.equal(workspace.activeNav, 'chats');
      assert.equal(workspace.activeConvId, planning.id, 'selection must not wait for transcript or pin requests');
      assert.ok(host.textContent?.includes('planning transcript'));
      assert.ok(!host.textContent?.includes('main transcript'));
      if (staleOutcome === 'success') await act(async () => hydration.get(planning.id)!.resolve());
      assert.equal(workspace.activeConvId, planning.id, 'pending pins cannot retain the old conversation');

      let latestSelection!: Promise<void>;
      await act(async () => { latestSelection = controller.handleSelectChatSession(main.id); });
      assert.equal(workspace.activeConvId, main.id);
      await act(async () => {
        const pin = pins.get(planning.id)!;
        if (staleOutcome === 'success') pin.resolve();
        else {
          hydration.get(planning.id)!.reject(new Error('Old transcript request failed'));
          pin.reject(new Error('Old pin request failed'));
        }
      });
      assert.equal(workspace.activeConvId, main.id, 'older completion cannot restore the previous choice');
      assert.equal(currentError, null);
      await act(async () => {
        hydration.get(main.id)!.reject(new Error('Transcript unavailable'));
        pins.get(main.id)!.reject(new Error('Pin unavailable'));
        await latestSelection;
      });
      assert.equal(workspace.activeConvId, main.id, 'load failure must retain the explicitly selected channel');
      assert.equal(currentError, 'Transcript unavailable');
    } finally {
      await act(async () => root.unmount());
      host.remove();
      environment.restore();
    }
  });
}
