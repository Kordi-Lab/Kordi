import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudContactsAdapter } from '../src/features/cloud/CloudContactsAdapter';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import type { CloudAccount } from '../src/features/cloud/authClient';
import type { Contact } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'bridge-peer-person:acct_peer:acct_peer',
    name: 'Shuyhere',
    initials: 'SH',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: "Owner of Shuyhere's Kordi",
    bridges: ['cloud'],
    status: 'Reachable',
    discoverableOn: ['cloud'],
    detail: 'acct_peer',
    owner: 'Shuyhere',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_peer',
    bridgePeerRuntime: 'person',
    bridgeHumanId: 'acct_peer',
    avatarSeed: 'acct_peer',
    profileImageUrl: null,
    ...overrides,
  };
}

test('CloudContactsAdapter hides Cloud self agent rows and does not show local-agent detail copy', () => {
  const cloudContact = cloudContactToContact({
    accountId: 'acct_peer',
    displayName: 'Peer',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-05-11T00:00:00Z',
  });

  const markup = renderToStaticMarkup(createElement(CloudContactsAdapter, {
    account,
    contactsPageProps: {
      filteredGroupedContacts: [
        { id: 'my-agents', label: 'My agents', items: [contact({
          id: 'bridge-self:cloud',
          name: 'Me',
          classType: 'my-agents',
          entityType: 'My agent',
          subtitle: 'Direct local chat',
          detail: 'Chat directly with my local Kordi agent. Bridge host: kordi.cloud • acct_me',
          bridgeHostId: 'cloud',
          bridgePeerNodeId: 'acct_me',
          bridgePeerRuntime: 'kordi-desktop',
        })] },
        { id: 'other-users', label: 'Other users', items: [cloudContact] },
      ],
      contactSearch: '',
      onContactSearchChange: () => {},
      expandedContactGroups: { 'my-agents': true, 'other-users': true },
      onToggleGroup: () => {},
      activeContactId: 'bridge-self:cloud',
      activeContact: contact({
        id: 'bridge-self:cloud',
        name: 'Me',
        classType: 'my-agents',
        entityType: 'My agent',
        subtitle: 'Direct local chat',
        detail: 'Chat directly with my local Kordi agent. Bridge host: kordi.cloud • acct_me',
        bridgeHostId: 'cloud',
        bridgePeerNodeId: 'acct_me',
        bridgePeerRuntime: 'kordi-desktop',
      }),
      activeContactRequestId: '',
      activeContactRequest: undefined,
      contactOverlayMode: 'contact',
      onCloseOverlay: () => {},
      getStatusBadgeClass: () => '',
      addableContacts: [],
      contactRequests: [],
      onAcceptRequest: () => {},
      onRejectRequest: () => {},
      onAddContactByNodeId: () => {},
      onMessageContact: () => {},
    },
  } as never));

  assert.doesNotMatch(markup, /My agents/);
  assert.doesNotMatch(markup, /My agent • Direct local chat/);
  assert.doesNotMatch(markup, /Chat directly with my local Kordi agent/);
});

test('CloudContactsAdapter shows one human row and removes other people agent groups', () => {
  const cloudContact = cloudContactToContact({
    accountId: 'acct_peer',
    displayName: 'Shuyhere',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-05-11T00:00:00Z',
  });

  const markup = renderToStaticMarkup(createElement(CloudContactsAdapter, {
    account,
    contactsPageProps: {
      filteredGroupedContacts: [
        { id: 'other-users', label: 'Other users', items: [contact()] },
        { id: 'other-users-agents', label: "Other users' agents", items: [contact({
          id: 'bridge-peer-agent:acct_peer:cloud-agent',
          classType: 'other-users-agents',
          entityType: 'External agent',
          subtitle: 'kordi-desktop',
          detail: "Shuyhere's Kordi",
          bridgePeerRuntime: 'kordi-desktop',
        })] },
      ],
      contactSearch: '',
      onContactSearchChange: () => {},
      expandedContactGroups: { 'other-users': true, 'other-users-agents': true },
      onToggleGroup: () => {},
      activeContactId: cloudContact.id,
      activeContact: cloudContact,
      activeContactRequestId: '',
      activeContactRequest: undefined,
      addableContacts: [],
      contactRequests: [],
      onAcceptRequest: () => {},
      onRejectRequest: () => {},
      onAddContactByNodeId: () => {},
      onMessageContact: () => {},
    },
  } as never));

  assert.match(markup, /Other users/);
  assert.doesNotMatch(markup, /Other users&#x27; agents|Other users' agents/);
  assert.doesNotMatch(markup, /Owner of Shuyhere/);
});
