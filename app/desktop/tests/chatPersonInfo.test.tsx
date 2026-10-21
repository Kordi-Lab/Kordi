import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { cloudDirectChatPeerAccountId } from '../src/features/cloud/cloudDirectChatPeer';
import { cloudCollaborationConversationId, cloudDirectPersonSessionId } from '../src/features/collaboration/conversationIds';
import { ContactDetailBody } from '../src/kordi-app/contacts/ContactDetailPane';
import type { ParticipantSpaceViewModel } from '../src/kordi-app/types';
import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';
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

test('inside a chat the profile has no Message tile', () => {
  const nadia = contact({ id: 'cloud:acct_nadia', name: 'Nadia Haddad', subtitle: '@482731906', detail: '@482731906', sourceHostId: 'cloud', sourceParticipantId: 'acct_nadia' });
  const markup = renderToStaticMarkup(createElement(ContactDetailBody, {
    contact: nadia,
    showMessageTile: false,
    onCloseOverlay: () => undefined,
    onRemoveContact: () => undefined,
    contactProfileHost: { accountIdFor: () => 'acct_nadia', load: () => new Promise(() => undefined) },
    contactMute: { isMuted: () => true, setMuted: () => undefined },
  }));
  assert.doesNotMatch(markup, />Message</);
  assert.match(markup, />Unmute</);
  assert.match(markup, />Share</);
  assert.match(markup, /aria-label="More actions"/);
  assert.match(markup, /Delete contact/);
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
        summary: { photos: 0, videos: 0, files: 0, links: 0, commonGroups: 1 },
      }));
    });
    const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('group in common'));
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
