import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CompactComposerModelMenu,
} from '../src/kordi-app/components/composer';
import {
  shouldUseCompactModelRouteMenu,
} from '../src/pages/ChatsPage';
import { shouldSynchronizeConversationModelRoute } from '../src/pages/chatsPage.model';
import { canConfigureConversationModelRoute } from '../src/pages/chatsPage.header';
import type { Conversation } from '../src/kordi-app/types';

const providerOptions = [
  { value: 'openai::personal', providerId: 'openai', label: 'openai', detail: 'personal key', selectionLabel: 'openai · personal key', active: true },
  { value: 'google::default', providerId: 'google', label: 'google gemini', detail: 'available fallback' },
];

const modelOptions = [
  { value: 'openai/gpt-5.1', label: 'gpt-5.1', provider: 'openai', detail: 'balanced for chat requests', thinkingLevels: ['auto', 'light', 'deep'] },
  { value: 'openai/gpt-5.1-mini', label: 'gpt-5.1-mini', provider: 'openai', detail: 'faster replies', thinkingLevels: ['auto', 'light'] },
];

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'session:direct-person:me:alice',
    name: 'alice',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'cloud',
    directness: 'direct person chat',
    participants: ['me', 'alice'],
    messages: [],
    ...overrides,
  };
}

test('compact composer presents a readable pill and immediate model menu', () => {
  const markup = renderToStaticMarkup(createElement(CompactComposerModelMenu, {
    scope: 'chat', selection: { mode: 'chat', model: 'openai/gpt-5.1', thinking: 'auto' },
    providerOptions, modelOptions, defaultOpen: true, onSave: () => {},
  }));
  assert.match(markup, /Select model, current GPT-5.1/);
  assert.match(markup, /Adjust effort, current Default/);
  assert.match(markup, /aria-label="Select model"/);
  assert.match(markup, />Default</);
  assert.doesNotMatch(markup, /<details|>save<|>Save<|lucide-menu|More effort may take longer/);
});

test('missing accounts remain visible without substituting another account on render', () => {
  const markup = renderToStaticMarkup(createElement(CompactComposerModelMenu, {
    scope: 'chat', selection: { mode: 'chat', model: 'openai/gpt-5.1', thinking: 'max', authProvider: 'openai', authChoice: 'profile:removed' },
    providerOptions, modelOptions, defaultOpen: true, onSave: () => { assert.fail('render must not save'); },
  }));
  assert.match(markup, /Account unavailable/);
  assert.match(markup, /Adjust effort, current Max/);
});

test('compact model route menu is scoped to group and human contact chats', () => {
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'person', directness: 'direct person chat' })), true);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'person', directness: 'group chat', id: 'session:group:one' })), true);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'group' as Conversation['type'], directness: 'group chat', id: 'session:group:one' })), true);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'owned-agent', directness: 'direct chat' })), false);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'external-agent', directness: 'agent thread' })), false);
});

test('agent model routes synchronize independently from message execution transport', () => {
  const ownedAgent = conversation({
    type: 'owned-agent',
    directness: 'direct agent chat',
  });
  const externalAgent = conversation({
    type: 'external-agent',
    directness: 'direct agent chat',
  });
  const person = conversation({
    type: 'person',
    directness: 'direct person chat',
  });

  assert.equal(shouldSynchronizeConversationModelRoute({
    conversation: ownedAgent,
    usesCollaborationTransport: false,
    hasCloudAccount: true,
    hasModelHost: true,
  }), true, 'Mac-executed owned Agent sessions still synchronize their model route');
  assert.equal(shouldSynchronizeConversationModelRoute({
    conversation: externalAgent,
    usesCollaborationTransport: false,
    hasCloudAccount: true,
    hasModelHost: true,
  }), true, 'external Agent sessions use the same session-owned route');
  assert.equal(shouldSynchronizeConversationModelRoute({
    conversation: person,
    usesCollaborationTransport: false,
    hasCloudAccount: true,
    hasModelHost: true,
  }), false, 'local human message transport does not implicitly become collaboration transport');
  assert.equal(shouldSynchronizeConversationModelRoute({
    conversation: person,
    usesCollaborationTransport: true,
    hasCloudAccount: false,
    hasModelHost: false,
  }), true, 'existing collaboration conversations retain their route controls');
  assert.equal(shouldSynchronizeConversationModelRoute({
    conversation: ownedAgent,
    usesCollaborationTransport: false,
    hasCloudAccount: false,
    hasModelHost: true,
  }), false, 'a local-only Agent session cannot publish a cloud route without an account');
  assert.equal(shouldSynchronizeConversationModelRoute({
    conversation: ownedAgent,
    usesCollaborationTransport: false,
    hasCloudAccount: true,
    hasModelHost: false,
  }), false, 'a route needs a model host before synchronization is enabled');
});

test('Kordi Support keeps its server-owned model route locked', () => {
  assert.equal(canConfigureConversationModelRoute(conversation({
    id: 'cloud:conversation:acct_kordi_support:agent',
  })), false);
  assert.equal(canConfigureConversationModelRoute(conversation({
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
  })), false);
  assert.equal(canConfigureConversationModelRoute(conversation({
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: 'acct_kordi_support',
      agentId: 'cloud_agent_kordi_support',
    },
  })), false);
  assert.equal(canConfigureConversationModelRoute(conversation({
    identity: {
      sourceHostId: 'cloud',
      localHumanId: 'acct_me',
      localHumanName: 'Me',
      remoteAgentId: 'cloud_agent_kordi_support',
    },
  })), false);
  assert.equal(canConfigureConversationModelRoute(conversation({ supportTicketEnabled: true })), false);
  assert.equal(canConfigureConversationModelRoute(conversation({ supportTicketEnabled: false })), true);
  assert.equal(canConfigureConversationModelRoute(conversation({})), true);

  const source = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  assert.match(source, /const canConfigureModelRoute = canConfigureConversationModelRoute\(conversation\)/);
  assert.match(source, /canConfigureModelRoute[\s\S]*<CompactComposerModelMenu/);
  assert.match(source, /canConfigureModelRoute[\s\S]*<ComposerModelControls/);
  assert.match(source, /canConfigureModelRoute[\s\S]*<CollaborationRoutingControls/);
});

test('main and thread route pills sit beside the send controls', () => {
  const main = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  const thread = readFileSync(new URL('../src/pages/ChatThreadPanel.tsx', import.meta.url), 'utf8');
  assert.ok(main.indexOf('<ComposerAttachmentAddMenu') < main.indexOf('<CompactComposerModelMenu'));
  assert.ok(thread.indexOf('<ComposerAttachmentAddMenu') < thread.indexOf('<CompactComposerModelMenu'));
});
