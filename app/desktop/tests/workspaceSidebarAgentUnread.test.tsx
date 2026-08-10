import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { collaborationChatConversationRoutesToLocalAgentPage } from '../src/app/useWorkspaceViewModels';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { conversation, bridgeConversation, baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('WorkspaceSidebar marks the active agent fork path connector for accent styling', () => {
  const chatConversations = [
    conversation({
      id: 'session:agent:root',
      canonicalSessionId: 'session:agent:root',
      name: 'Root agent chat',
      type: 'owned-agent',
      subtitle: 'Root reply',
      unread: 0,
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:agent:fork',
      canonicalSessionId: 'session:agent:fork',
      name: 'Forked agent chat',
      type: 'owned-agent',
      subtitle: 'Fork reply',
      unread: 0,
      forkedFromSessionId: 'session:agent:root',
      forkedFromMessageId: 'msg:root-agent',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: [],
    agentParticipantSpaces: participantSpaces,
    activeConvId: 'session:agent:fork',
    initialChatChannel: 'agent',
  }) as never));

  assert.match(markup, /data-session-fork-path-active="true"/);
  assert.match(markup, /app-session-fork-children-active/);
});

test('WorkspaceSidebar keeps agent session hashtags aligned with fork controls on the right', () => {
  const chatConversations = [
    conversation({
      id: 'session:agent:root-align',
      canonicalSessionId: 'session:agent:root-align',
      name: 'Root agent chat',
      type: 'owned-agent',
      subtitle: 'Root reply',
      unread: 0,
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:agent:fork-align',
      canonicalSessionId: 'session:agent:fork-align',
      name: 'Forked agent chat',
      type: 'owned-agent',
      subtitle: 'Fork reply',
      unread: 0,
      forkedFromSessionId: 'session:agent:root-align',
      forkedFromMessageId: 'msg:root-agent',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: [],
    agentParticipantSpaces: participantSpaces,
    activeConvId: 'session:agent:root-align',
    initialChatChannel: 'agent',
  }) as never));
  const rootRowStart = markup.indexOf('data-agent-session-row="session:agent:root-align"');
  const rootRowMarkup = markup.slice(rootRowStart, markup.indexOf('</button>', rootRowStart));
  const titleIndex = rootRowMarkup.indexOf('app-session-row-title');
  const toggleIndex = rootRowMarkup.indexOf('app-agent-session-fork-toggle');
  const shellCss = readDesktopShellCss();

  assert.match(rootRowMarkup, /app-agent-session-main/);
  assert.match(rootRowMarkup, /app-agent-session-side/);
  assert.match(rootRowMarkup, /app-agent-session-fork-toggle/);
  assert.ok(titleIndex >= 0, 'agent session title should render');
  assert.ok(toggleIndex > titleIndex, 'agent fork toggle should render to the right of the title');
  assert.doesNotMatch(rootRowMarkup.slice(0, titleIndex), /app-agent-session-fork-toggle/);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-agent-session-row\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content/s);
});

test('WorkspaceSidebar does not show an Agent tab unread badge for hidden canonical parent forks', () => {
  const chatConversations = [
    conversation({
      id: 'session:fork:hidden-contact-child',
      canonicalSessionId: 'session:fork:hidden-contact-child',
      name: 'Forked group continuation',
      type: 'owned-agent',
      subtitle: 'Unread hidden fork',
      unread: 1,
      forkedFromSessionId: 'session:group:cloud-parent',
      forkedFromMessageId: 'msg:source',
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
    activeConvId: '',
    initialChatChannel: 'agent',
  }) as never));

  assert.match(markup, /No agent conversations yet/);
  assert.doesNotMatch(markup, /data-unread-scope="channel-tab" data-unread-count="1"/);
});

test('WorkspaceSidebar hides group-derived fork unread from the contact tab and folded group row', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:cloud-parent',
      canonicalSessionId: 'session:group:cloud-parent',
      name: 'Cloud group',
      type: 'group',
      subtitle: 'Parent group',
      unread: 0,
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:fork:hidden-contact-child',
      canonicalSessionId: 'session:fork:hidden-contact-child',
      name: 'Forked group continuation',
      type: 'owned-agent',
      subtitle: 'Unread hidden fork',
      unread: 1,
      forkedFromSessionId: 'session:group:cloud-parent',
      forkedFromMessageId: 'msg:source',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 1,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const contactParticipantSpaces = participantSpaces.filter((space) => space.kind === 'group');
  const agentParticipantSpaces = participantSpaces.filter((space) => space.kind === 'self');
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    activeConvId: 'session:outside-active',
  }) as never));

  assert.doesNotMatch(markup, /data-unread-scope="channel-tab" data-unread-count="1"/);
  assert.doesNotMatch(markup, /data-unread-scope="participant-space" data-unread-count="1"/);
});

test('WorkspaceSidebar shows icon-only Bridge message sync progress beside the Chats title', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    isCollaborationSyncing: true,
  }) as never));

  assert.doesNotMatch(markup, /2 total/);
  assert.match(markup, /data-collaboration-sync-status="syncing"/);
  assert.match(markup, /app-collaboration-sync-arc/);
  assert.match(markup, /aria-label="Messages are syncing"/);
  assert.doesNotMatch(markup, /app-collaboration-sync-label/);
  assert.doesNotMatch(markup, />syncing…</);
  assert.doesNotMatch(markup, /pulling missed Bridge updates/);
});

test('direct remote-human to my-agent Bridge reachouts route to the Agent page, while group reachouts stay in the group', () => {
  assert.equal(collaborationChatConversationRoutesToLocalAgentPage(bridgeConversation()), true);
  assert.equal(collaborationChatConversationRoutesToLocalAgentPage(bridgeConversation({
    outreach: {
      ...bridgeConversation().outreach!,
      parentSessionId: 'session:group:launch',
      parentSessionKind: 'group',
    },
  })), false);
  assert.equal(collaborationChatConversationRoutesToLocalAgentPage(bridgeConversation({
    outreach: {
      ...bridgeConversation().outreach!,
      targetAgentId: 'agent-remote',
    },
  })), false);
});

test('Cloud self-agent reachouts stay in the contact chat rail instead of routing away to the Agent page', () => {
  assert.equal(collaborationChatConversationRoutesToLocalAgentPage(bridgeConversation({
    id: 'bridge:cloud:acct-peer:person',
    canonicalSessionId: 'session:bridge:bridge:cloud:acct-peer:person',
    hostId: 'cloud',
    outreach: {
      ...bridgeConversation().outreach!,
      sourceHostId: 'cloud',
      sourceConversationId: 'bridge:cloud:acct-peer:person',
      targetAgentId: 'agent-local',
    },
  })), false);
});

test('WorkspaceSidebar hides collaboration status entirely when idle', () => {
  const caughtUpConversations = [
    conversation({ id: 'chat-1', name: 'Alice', unread: 0 }),
    conversation({ id: 'chat-2', name: 'Bob', unread: 0 }),
  ];
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations: caughtUpConversations,
    isCollaborationSyncing: false,
  }) as never));

  assert.doesNotMatch(markup, /2 total/);
  assert.doesNotMatch(markup, /all caught up/);
  assert.doesNotMatch(markup, /data-collaboration-sync-status/);
  assert.doesNotMatch(markup, /syncing…/);
});

test('WorkspaceSidebar shows a red broken-orbit status when collaboration sync is unavailable', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    isCollaborationSyncing: true,
    isCollaborationSyncUnavailable: true,
  }) as never));

  assert.match(markup, /data-collaboration-sync-status="unavailable"/);
  assert.match(markup, /aria-label="Messages cannot sync right now"/);
  assert.match(markup, /M5\.2 3\.3a5\.4 5\.4 0 0 1 7\.5 2\.3/);
  assert.doesNotMatch(markup, /app-collaboration-sync-arc/);
  assert.doesNotMatch(markup, /data-collaboration-sync-status="syncing"/);
});
