import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { cloudDirectChatPeerAccountId, directChatPeerParticipant } from '../src/features/cloud/cloudDirectChatPeer';
import { cloudCollaborationConversationId, cloudDirectPersonSessionId } from '../src/features/collaboration/conversationIds';
import { normalizeContactProfile, type CloudContactProfile, type CloudContactProfileGroup } from '../src/features/cloud/contactProfileClient';
import { ChatPersonInfo } from '../src/kordi-app/contacts/ChatPersonInfo';
import type { Conversation, Message, ParticipantSpaceViewModel } from '../src/kordi-app/types';
import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';
import { ContactInfoPopover } from '../src/pages/ContactInfoPopover';
import { ContactProfileSharedContent } from '../src/pages/ContactProfileSharedContent';
import { contact } from './helpers/contactsPageFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';

const self = 'acct_me';

test('direct person chats resolve to the other account; groups and agent chats do not', () => {
  assert.equal(cloudDirectChatPeerAccountId({ id: cloudCollaborationConversationId('acct_nadia', 'person'), type: 'person' }, self), 'acct_nadia');
  assert.equal(cloudDirectChatPeerAccountId({ id: 'session:x', type: 'person', canonicalSessionId: cloudDirectPersonSessionId(self, 'acct_nadia') }, self), 'acct_nadia');
  assert.equal(cloudDirectChatPeerAccountId({ id: 'group:gs_1', type: 'person', canonicalSessionId: 'session:group:gs_1' }, self), null);
  assert.equal(cloudDirectChatPeerAccountId({ id: cloudCollaborationConversationId('acct_nadia', 'agent', 'session:a'), type: 'external-agent' }, self), null);
  assert.equal(cloudDirectChatPeerAccountId({ id: cloudCollaborationConversationId('acct_nadia', 'agent', 'session:a'), type: 'person' }, self), null);
});

function infoPanel(renderPersonInfo?: (legacy: ReactNode) => ReactNode) {
  return renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'info',
    activeConv: {
      id: cloudCollaborationConversationId('acct_nadia', 'person'),
      canonicalSessionId: cloudDirectPersonSessionId(self, 'acct_nadia'),
      name: 'Nadia Haddad', type: 'person', subtitle: '', unread: 0, collaborationSources: ['Cloud'],
      trust: 'Owned', directness: 'Direct', participants: ['Me', 'Nadia Haddad'], messages: [],
    },
    activeConvHasSubtitle: false,
    activeConversationUsesCollaboration: true,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
    renderPersonInfo,
  }));
}

test('the Info tab of a person chat hands today\'s content to the profile renderer', () => {
  assert.match(infoPanel(), /Overview/);
  assert.match(infoPanel(), /Participants/);
  let received = '';
  const markup = infoPanel((legacy) => {
    received = renderToStaticMarkup(createElement('div', null, legacy));
    return createElement('div', { 'data-person-profile': '' }, 'Profile');
  });
  assert.match(markup, /data-person-profile/);
  assert.doesNotMatch(markup, /Overview|Participants/);
  assert.match(received, /Overview/, 'the renderer can fall back to today\'s Info');
});

const nadiaContact = contact({
  id: 'cloud:acct_nadia', name: 'Nadia Haddad', subtitle: '@482731906', detail: '@482731906',
  sourceHostId: 'cloud', sourceParticipantId: 'acct_nadia', presenceStatus: 'online',
});

function nadiaProfile(groups: CloudContactProfileGroup[] = []): CloudContactProfile {
  return normalizeContactProfile({
    accountId: 'acct_nadia', kordiId: '482731906', displayName: 'Nadia Haddad', kind: 'person',
    about: 'Robotics PhD at KAUST.', contactSince: '2026-08-12T09:30:00Z',
    shared: { mediaCount: 24, linkCount: 9, documentCount: 3, groups },
  })!;
}

function directChat(messages: Message[], canonicalMessageCount?: number): Conversation {
  return {
    id: cloudCollaborationConversationId('acct_nadia', 'person'), canonicalSessionId: cloudDirectPersonSessionId(self, 'acct_nadia'),
    name: 'Nadia Haddad', type: 'person', subtitle: '', unread: 0, collaborationSources: ['Cloud'], trust: '', directness: '',
    participants: ['Me', 'Nadia Haddad'], messages, canonicalMessageCount,
  };
}

async function mountInfo(props: { conversation: Conversation; groups?: CloudContactProfileGroup[] }) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls = { opened: [] as DOMRect[], returned: 0, groups: [] as string[] };
  await act(async () => {
    root.render(createElement(ChatPersonInfo, {
      peer: nadiaContact,
      self: { id: self, name: 'Alex', imageUrl: null },
      conversation: props.conversation,
      host: {
        accountIdFor: (picked) => picked.sourceParticipantId ?? null,
        load: async () => nadiaProfile(props.groups),
        openGroup: (group) => { calls.groups.push(group.groupId); },
      },
      onOpenPeer: (rect) => { calls.opened.push(rect); },
      onReturnToChat: () => { calls.returned += 1; },
    }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    host,
    calls,
    text: () => host.textContent ?? '',
    click: (element: Element | null | undefined) => act(async () => {
      assert.ok(element, 'element to click should exist');
      element.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true }));
    }),
    button: (text: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim().startsWith(text)),
    async cleanup() {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

const sharedMessages: Message[] = [{
  id: 'm1', role: 'person', text: 'Survey https://arxiv.org/abs/1', time: '', timestampMs: Date.now(),
  attachments: [{ kind: 'image', name: 'a.png' }, { kind: 'image', name: 'b.png' }],
}];

test('the Info tab lists the participants and the shared rows, nothing else', async () => {
  const page = await mountInfo({ conversation: directChat(sharedMessages), groups: [{ groupId: 'gs_1', title: 'Robotics', avatarUrl: null }] });
  try {
    const text = page.text();
    assert.ok(text.indexOf('Participants') < text.indexOf('Shared with you'));
    const rows = [...page.host.querySelectorAll('.app-chat-person-info-participant')];
    assert.deepEqual(rows.map((row) => row.textContent), ['Nadia Haddadonline', 'AlexYou']);
    assert.equal(rows[0].tagName, 'BUTTON', 'the other person opens their profile');
    assert.equal(rows[1].tagName, 'DIV', 'your own row does nothing');
    assert.match(text, /Photos2Files0Links1Groups in common/);
    assert.doesNotMatch(text, /Kordi ID|About|Robotics PhD|Contact since|Common ground|Delete contact/);
    assert.equal(page.host.querySelector('.app-contacts-tiles'), null, 'no action tiles');

    await page.click(rows[0]);
    assert.equal(page.calls.opened.length, 1);
    await page.click(page.button('Groups in common'));
    assert.deepEqual(page.calls.groups, ['gs_1']);
  } finally {
    await page.cleanup();
  }
});

test('shared rows open a page in the tab; Back and Escape return to the list', async () => {
  const page = await mountInfo({ conversation: directChat(sharedMessages) });
  try {
    await page.click(page.button('Photos'));
    const region = page.host.querySelector('[role="region"][aria-label="Photos"]');
    assert.ok(region, 'the Photos page replaces the list');
    assert.equal(page.calls.returned, 0, 'a loaded chat opens the page, not the transcript');
    const back = region.querySelector('.app-contact-shared-back');
    assert.equal(back?.textContent, 'Back');
    assert.equal(back?.getAttribute('aria-label'), 'Back');
    assert.equal(region.querySelector('.app-contact-shared-count')?.textContent, '2 photos');
    assert.equal(region.querySelectorAll('.app-contact-shared-tile').length, 2);
    assert.doesNotMatch(page.text(), /Participants/);

    await page.click(back);
    assert.match(page.text(), /Participants/);
    await page.click(page.button('Links'));
    assert.ok(page.host.querySelector('[role="region"][aria-label="Links"]'));
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(page.host.querySelector('[role="region"]'), null, 'Escape returns to the list');
  } finally {
    await page.cleanup();
  }
});

test('until the whole chat is loaded the rows show the server counts and return to the chat', async () => {
  const page = await mountInfo({ conversation: directChat(sharedMessages, 40) });
  try {
    assert.match(page.text(), /Photos24Files3Links9/);
    await page.click(page.button('Files'));
    assert.equal(page.calls.returned, 1);
    assert.equal(page.host.querySelector('[role="region"]'), null);
  } finally {
    await page.cleanup();
  }
});

test('the chat participant handed to the profile popover is the other account', () => {
  const conversation = { ...directChat([]), canonicalParticipants: [
    { id: 'human:acct_me', humanId: self, name: 'Me', kind: 'human', role: 'self' },
    { id: 'human:acct_nadia', humanId: 'acct_nadia', name: 'Nadia Haddad', kind: 'human', role: 'person', avatarKey: 'k' },
  ] };
  assert.equal(directChatPeerParticipant(conversation, 'acct_nadia', nadiaContact).avatarKey, 'k');
  const fallback = directChatPeerParticipant(directChat([]), 'acct_nadia', nadiaContact);
  assert.equal(fallback.id, 'human:acct_nadia');
  assert.equal(fallback.kind, 'human');
  assert.equal(fallback.name, 'Nadia Haddad');
});

test('the popover lists groups in common with the square member mosaic', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const space = {
    id: 'group:gs_1', kind: 'group', title: 'Robotics reading group', participants: [], participantCount: 3,
    sessionCount: 1, unread: 0, updatedAtMs: 0, preview: '', sessions: [],
    avatarStack: [{ kind: 'human', seed: 'acct_me', isSelf: true }, { kind: 'human', seed: 'acct_nadia' }, { kind: 'agent', seed: 'agent_n' }],
  } satisfies ParticipantSpaceViewModel;
  try {
    await act(async () => {
      root.render(createElement(ContactProfileSharedContent, {
        commonGroups: [space],
        summary: { photos: 0, files: 0, links: 0, commonGroups: 1 },
      }));
    });
    const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Groups in common'));
    await act(async () => { toggle?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })); });
    const row = host.querySelector('.app-contact-profile-group-row');
    assert.ok(row, 'the group row renders');
    const avatar = row.querySelector('.app-group-avatar');
    assert.ok(avatar, 'the row uses the group avatar');
    assert.ok(!avatar.classList.contains('rounded-full'));
    assert.equal(row.querySelector('.-space-x-2'), null, 'no overlapping member stack');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('popover rows open the shared pages inside the card; back and Escape return', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closed = 0;
  const click = (element: Element | null | undefined) => act(async () => {
    assert.ok(element, 'element to click should exist');
    element.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true }));
  });
  const button = (text: string) => [...document.querySelectorAll('[role="dialog"] button')]
    .find((item) => item.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;
  try {
    await act(async () => {
      root.render(createElement(ContactInfoPopover, {
        participant: { id: 'human:nadia', humanId: 'acct_nadia', name: 'Nadia Haddad', kind: 'human', role: 'person', source: 'cloud' },
        contacts: [],
        anchorRect: { left: 20, right: 56, top: 120, bottom: 156, width: 36, height: 36 },
        conversation: {
          id: 'session:direct-person:acct_me:acct_nadia', name: 'Nadia Haddad', type: 'person', subtitle: '', unread: 0,
          collaborationSources: [], trust: '', directness: '', participants: [],
          messages: [{
            id: 'm1', role: 'person', text: 'Notes https://example.com/notes', time: '', timestampMs: Date.now(),
            attachments: [{ kind: 'image', name: 'a.png' }, { kind: 'image', name: 'b.png' }],
          }],
        },
        onClose: () => { closed += 1; },
      }));
    });
    const dialog = () => document.querySelector('[role="dialog"]');
    assert.match(dialog()?.textContent ?? '', /Photos2Files0Links1/);
    const files = button('Files');
    assert.equal(files?.disabled, true, 'a zero row is inert');
    await click(files);
    assert.equal(document.querySelector('[role="region"]'), null, 'a zero row opens nothing');

    await click(button('Photos'));
    const region = document.querySelector('[role="region"][aria-label="Photos"]');
    assert.ok(region, 'the Photos page replaces the profile');
    const header = region.querySelector('.app-contact-shared-header');
    assert.equal(header?.querySelector('.app-contact-shared-back')?.textContent, '', 'the popover back control is icon only');
    assert.equal(header?.querySelector('.app-contact-shared-title')?.textContent, 'Photos');
    assert.equal(header?.querySelector('.app-contact-shared-count')?.textContent, '2 photos');
    assert.ok(header?.querySelector('[aria-label="Close contact info"]'), 'Close stays in the header');
    assert.equal(region.querySelectorAll('.app-contact-shared-tile').length, 2);
    assert.doesNotMatch(dialog()?.textContent ?? '', /Nadia Haddad/);

    await click(document.querySelector('[aria-label="Back to profile"]'));
    assert.equal(document.querySelector('[role="region"]'), null);
    assert.match(dialog()?.textContent ?? '', /Nadia Haddad/);

    await click(button('Links'));
    assert.ok(document.querySelector('[role="region"][aria-label="Links"]'));
    await act(async () => {
      window.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(document.querySelector('[role="region"]'), null, 'Escape returns to the profile');
    assert.equal(closed, 0, 'Escape on a page keeps the popover open');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
