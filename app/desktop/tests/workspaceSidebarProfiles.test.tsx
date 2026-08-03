import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { applyCloudPresenceToConversations } from '../src/app/viewModels/cloudConversationPresence';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { CloudProfileLogoutAction, WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { conversation, baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('WorkspaceSidebar cloud profile uses the provider image avatar instead of a generated pixel fallback', () => {
  const cloudAccount: CloudAccount = {
    accountId: 'acct_provider',
    displayName: 'Provider User',
    primaryEmail: 'provider@example.com',
    avatarUrl: 'https://lh3.googleusercontent.com/a/provider-avatar',
    nodeId: 'node-provider',
    passwordSet: false,
  };

  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    cloudAccount,
    onUpdateCloudProfile: async () => cloudAccount,
    localProfileAvatarSeed: 'stale-generated-local-seed',
  }) as never));

  const profileAvatarMarkup = markup.slice(markup.indexOf('aria-label="Provider User avatar"'), markup.indexOf('aria-label="Provider User avatar"') + 500);
  assert.match(profileAvatarMarkup, /src="https:\/\/lh3\.googleusercontent\.com\/a\/provider-avatar"/);
  assert.doesNotMatch(profileAvatarMarkup, /shape-rendering="crispEdges"/);
});

test('CloudProfileLogoutAction renders a destructive account logout menu item', () => {
  const markup = renderToStaticMarkup(createElement(CloudProfileLogoutAction, { onSignOut: async () => undefined }));

  assert.match(markup, /Logout/);
  assert.match(markup, /aria-label="Logout of account"/);
  assert.doesNotMatch(markup, />Cloud<\/span>/);
});

test('cloud presence hydrates account participants before chat rows are grouped', () => {
  const chatConversations = [conversation({
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me', humanId: 'acct_me' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob', humanId: 'acct_bob' },
    ],
  })];

  const hydrated = applyCloudPresenceToConversations(chatConversations, {
    acct_bob: { accountId: 'acct_bob', status: 'online', updatedAt: '2026-05-23T00:00:00Z' },
  });

  assert.equal(hydrated[0]?.canonicalParticipants?.[1]?.presenceStatus, 'online');
  assert.equal(buildParticipantSpaces(hydrated)[0]?.avatarStack[0]?.presenceStatus, 'online');
});

test('cloud presence hydrates fallback direct chat participants by account id', () => {
  const chatConversations = [conversation({
    canonicalParticipants: undefined,
    participants: ['Me', '333'],
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: 'acct_333',
      displayName: '333',
      ownerName: '333',
      runtime: 'person',
      humanId: 'acct_333',
      agentId: null,
    },
    avatarSeed: 'acct_333',
  })];

  const hydrated = applyCloudPresenceToConversations(chatConversations, {
    acct_333: { accountId: 'acct_333', status: 'offline', updatedAt: '2026-05-23T00:00:00Z' },
  });

  assert.equal(buildParticipantSpaces(hydrated)[0]?.avatarStack[0]?.presenceStatus, 'offline');
});

test('WorkspaceSidebar shows participant presence lights in direct chat rows only', () => {
  const chatConversations = [conversation({
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me', presenceStatus: 'online' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob', presenceStatus: 'online' },
    ],
  })];
  const participantSpaces = buildParticipantSpaces(chatConversations);

  assert.equal(participantSpaces[0]?.avatarStack[0]?.presenceStatus, 'online');

  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    filteredConversations: chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: chatConversations[0]?.id,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /class="app-presence-light"/);
  assert.match(markup, /data-presence-status="online"/);
});

test('WorkspaceSidebar hides presence lights on group row avatar stacks', () => {
  const chatConversations = [conversation({
    id: 'session:group:presence-row',
    canonicalSessionId: 'session:group:presence-row',
    name: '111, 222',
    type: 'group',
    participants: ['Me', '111', '222'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me', presenceStatus: 'online' },
      { id: 'human:111', name: '111', kind: 'human', role: 'person', source: 'bridge', avatarKey: '111', presenceStatus: 'online' },
      { id: 'human:222', name: '222', kind: 'human', role: 'person', source: 'bridge', avatarKey: '222', presenceStatus: 'online' },
    ],
  })];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    filteredConversations: chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: chatConversations[0]?.id,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /111, 222/);
  assert.doesNotMatch(markup, /class="app-presence-light"/);
  assert.doesNotMatch(markup, /relative inline-flex shrink-0 h-7 w-7 border/);
});

test('WorkspaceSidebar renders direct human participant spaces as one flat chat row without session actions', () => {
  const participantSpaces = buildParticipantSpaces(baseSidebarProps().chats.chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /data-chat-sidebar-mode="participant-spaces-inline"/);
  assert.match(markup, /app-filter-tab/);
  assert.match(markup, />Contact</);
  assert.match(markup, />Agent</);
  assert.doesNotMatch(markup, />People</);
  assert.match(markup, /Bob/);
  assert.match(markup, /New preview/);
  assert.doesNotMatch(markup, /Person • 1 chat/);
  assert.match(markup, /data-participant-space-row-shell="true"/);
  assert.match(markup, /app-participant-space-row-button/);
  assert.match(markup, /app-participant-space-row-title/);
  assert.match(markup, /app-participant-space-row-preview/);
  assert.doesNotMatch(markup, /app-participant-space-row-detail/);
  assert.doesNotMatch(markup, /data-participant-space-toggle="true"/);
  assert.doesNotMatch(markup, /aria-label="Collapse Bob"/);
  assert.doesNotMatch(markup, /aria-label="Expand Bob"/);
  assert.doesNotMatch(markup, /aria-label="Create session in Bob"/);
  assert.doesNotMatch(markup, /data-participant-space-context-create="true"/);
  assert.doesNotMatch(markup, /data-participant-space-toggle-button="true"/);
  assert.doesNotMatch(markup, /data-testid="participant-space-session-row"/);
  assert.doesNotMatch(markup, /absolute right-1\.5 top-1\.5/);
  assert.doesNotMatch(markup, /pr-\[4\.75rem\]/);
  assert.doesNotMatch(markup, /data-participant-space-enter="true"/);
  assert.doesNotMatch(markup, /Back to chats/);
  assert.doesNotMatch(markup, /Old Bob thread/);
  assert.doesNotMatch(markup, /New Bob thread/);
});

test('WorkspaceSidebar renders an Agent tab shortcut for new My agent sessions', () => {
  const chatConversations = [
    conversation({
      id: 'session:my-agent:new',
      canonicalSessionId: 'session:my-agent:new',
      name: 'My agent session',
      type: 'owned-agent',
      subtitle: 'New plan',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: [],
    agentParticipantSpaces: participantSpaces,
    activeConvId: 'session:my-agent:new',
    initialChatChannel: 'agent',
  }) as never));

  assert.match(markup, />Agent</);
  assert.match(markup, /New My agent session/);
  assert.match(markup, /New session/);
});
