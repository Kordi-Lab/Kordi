import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatCreateDialog } from '../src/pages/ChatCreateDialog';
import { participantSpaceSessionIdLabel, participantSpaceSessionRowTitle, sessionContextMenuTargetForConversation } from '../src/pages/WorkspaceSidebar';
import { conversation, contact, agent } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('WorkspaceSidebar uses menu for the global plus and agent picker for Agent-tab New session', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');
  const dialogSource = readFileSync(new URL('../src/pages/ChatCreateDialog.tsx', import.meta.url), 'utf8');

  assert.match(source, /const \[chatCreateInitialMode, setChatCreateInitialMode\]\s*=\s*useState<ChatCreateMode>\('menu'\)/);
  assert.match(source, /const openChatCreateDialog = \(event: ReactMouseEvent<HTMLElement>\) => \{[\s\S]*setChatCreateInitialMode\('menu'\);[\s\S]*setIsChatCreateDialogOpen\(true\);[\s\S]*\};/);
  assert.match(source, /setChatCreateInitialMode\('agent'\);[\s\S]*setIsChatCreateDialogOpen\(true\);/);
  assert.match(source, /initialMode=\{chatCreateInitialMode\}/);
  assert.doesNotMatch(source, /initialMode=\{chatChannel === 'agent' \? 'agent' : 'menu'\}/);
  assert.match(dialogSource, /if \(isOpen\) \{\s*setMode\(initialMode\);\s*\}/);
});

test('ChatCreateDialog agent mode shows agent choices with avatars directly', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'agent',
    contacts: [contact({ id: 'contact:alice', name: 'Alice' })],
    agents: [
      agent({ id: 'agent:kordi', name: 'Kordi', role: 'Personal agent', avatarSeed: 'local-kordi' }),
      agent({
        id: 'cloud-agent:cloud_agent_abc',
        name: 'Kordi Project Driver',
        role: 'Project planning agent',
        cloudAgentId: 'cloud_agent_abc',
        avatarSeed: 'cloud_agent_abc',
        profileImageUrl: 'https://example.test/project-driver.png',
      }),
    ],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
  }));

  assert.match(markup, /Chat with agent/);
  assert.match(markup, /Kordi Project Driver/);
  assert.match(markup, /Personal agent/);
  assert.match(markup, /data-avatar-kind="agent"/);
  assert.match(markup, /project-driver\.png/);
  assert.doesNotMatch(markup, /Chat with contact/);
  assert.doesNotMatch(markup, /Start group/);
  assert.doesNotMatch(markup, /Add contacts/);
});

test('ChatCreateDialog renders compact theme-aware choices beside the plus button', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    contacts: [contact({ id: 'contact:alice', name: 'Alice' })],
    agents: [agent({ id: 'agent:kordi', name: 'Kordi' })],
    anchorRect: { left: 460, top: 40, width: 32, height: 32 },
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
  }));

  assert.match(markup, /data-create-surface="side-popover"/);
  assert.match(markup, /data-popover-placement="right"/);
  assert.match(markup, /app-chat-create-popover/);
  assert.match(markup, /app-frosted-popover/);
  assert.match(markup, /app-chat-create-popover-enter/);
  assert.doesNotMatch(markup, /bg-white\/80/);
  assert.doesNotMatch(markup, /text-slate-950/);
  assert.doesNotMatch(markup, /fixed inset-0 z-50 flex items-center justify-center/);
  assert.match(markup, /Chat with contact/);
  assert.doesNotMatch(markup, /Chat with person/);
  assert.match(markup, /Chat with agent/);
  assert.match(markup, /Start group/);
  assert.match(markup, /Add contacts/);
});

test('ChatCreateDialog cloud lookup copy asks for an account id, not a Bridge node id', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'add-contact',
    contacts: [],
    agents: [],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
    onAddContact: () => {},
    onLookupContact: async () => null,
    addContactPlaceholder: 'Account ID, e.g. acct_…',
  }));

  assert.match(markup, /Add contact/);
  assert.match(markup, /Kordi account ID/);
  assert.match(markup, /Account ID, e.g. acct_…/);
  assert.doesNotMatch(markup, /Bridge node ID/);
});

test('ChatCreateDialog add contact mode requests a Kordi account id', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'add-contact',
    contacts: [],
    agents: [],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
    onAddContact: () => {},
  }));

  assert.match(markup, /Add contact/);
  assert.match(markup, /Kordi account ID/);
  assert.match(markup, /Send request/);
  assert.match(markup, /Paste a Kordi account ID/);
});

test('ChatCreateDialog add contact mode shows visible non-contact Bridge users', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'add-contact',
    contacts: [],
    addableContacts: [
      contact({
        id: 'bridge-addable:kordi-user-6',
        name: 'Kordi User 6',
        entityType: 'Person',
        subtitle: 'Needs approval',
        detail: 'Node: kd_user6',
        sourceHostId: 'host-1',
        sourceParticipantId: 'kd_user6',
        contactStatus: 'none',
      }),
    ],
    agents: [],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
    onAddContact: () => {},
  }));

  assert.match(markup, /Visible users/);
  assert.match(markup, /Kordi User 6/);
  assert.match(markup, /Needs approval/);
  assert.match(markup, /Request/);
});

test('ChatCreateDialog group picker requires at least 2 contacts and excludes agents', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'group',
    contacts: [
      contact({ id: 'contact:alice', name: 'Alice', entityType: 'Person' }),
      contact({ id: 'contact:bob', name: 'Bob', entityType: 'Person' }),
      contact({ id: 'contact:agent', name: 'Helper Kordi', entityType: 'External agent', classType: 'other-users-agents' }),
    ],
    agents: [agent({ id: 'agent:kordi', name: 'Kordi' })],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
  }));

  assert.match(markup, /Select at least 2 contacts/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Bob/);
  assert.doesNotMatch(markup, /Helper Kordi/);
});

test('participant-space child session rows use hashtag titles and hide raw session ids', () => {
  assert.equal(participantSpaceSessionRowTitle('Hi shu'), '# Hi shu');
  assert.equal(participantSpaceSessionRowTitle('# Existing'), '# Existing');
  assert.equal(participantSpaceSessionIdLabel({ id: 'session:group:child', canonicalSessionId: 'session:group:root' }), 'Group chat');
});

test('participant-space direct sessions expose remove-chat context menu targets', () => {
  const target = sessionContextMenuTargetForConversation(conversation({
    id: 'session:bridge:humans:shu',
    canonicalSessionId: 'session:bridge:humans:shu',
    name: 'Lunch planning',
    type: 'person',
  }), 42, 84);

  assert.deepEqual(target, {
    sessionId: 'session:bridge:humans:shu',
    sessionName: 'Lunch planning',
    x: 42,
    y: 84,
  });
});
