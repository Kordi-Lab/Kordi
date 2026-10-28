import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudAgentSubsessionClient } from '../src/features/cloud/cloudAgentSubsessionClient';
import { subsessionMentionOptions, subsessionMentions } from '../src/features/cloud/subsessionConversation';
import {
  subsessionMessageRunsAgent,
  subsessionRouteAfterSave,
  subsessionRouteInput,
  subsessionRouteSelection,
  subsessionRuntimeRouteBody,
} from '../src/features/cloud/subsessionRoute';
import type { CloudAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';
import { CompanionComposer, type CompanionComposerProps } from '../src/pages/chatsPage.companionComposer';
import type { Conversation } from '../src/kordi-app/types';

const record: CloudAgentSubsession = {
  sessionId: 'thread', parentSessionId: 'parent', parentRequestId: 'request', title: 'Write the notes', status: 'failed',
  messages: [], ownerAccountId: 'owner', agentId: 'cloud-agent:owner', ownerDisplayName: 'Owner',
  agentDisplayName: 'Helper', version: 3, updatedAt: '2026-10-17T00:00:00Z',
  participants: [{ accountId: 'owner', displayName: 'Owner' }, { accountId: 'peer', displayName: 'Peer' }],
};

test('the owner\'s plain message in an agent thread runs their agent; other members still mention it', () => {
  assert.equal(subsessionMessageRunsAgent(record, 'owner', []), true, 'owner "try again" must start a run');
  assert.equal(subsessionMessageRunsAgent(record, 'peer', []), false, 'a member\'s plain message stays context');
  const peerOptions = subsessionMentionOptions(record, 'peer');
  const handle = peerOptions[0].value;
  assert.equal(subsessionMessageRunsAgent(record, 'peer', subsessionMentions(`@${handle} continue`, peerOptions)), true);
  const ownerOptions = subsessionMentionOptions(record, 'owner');
  const toPeer = subsessionMentions('@Peer look at this', ownerOptions);
  assert.equal(toPeer.length, 1);
  assert.equal(subsessionMessageRunsAgent(record, 'owner', toPeer), false, 'a message to a person does not run the agent');
});

test('a chosen thread route is sent with the message in the server route shape', async () => {
  const route = subsessionRouteAfterSave(null, {
    providerOption: { value: 'openai::api-key', providerId: 'openai', label: 'API key' },
    model: 'openai/gpt-5.5', thinking: 'high',
  });
  assert.deepEqual(route, { model: 'openai/gpt-5.5', thinking: 'high', authProvider: 'openai', authChoice: 'api-key' });
  const body = subsessionRuntimeRouteBody(route);
  assert.deepEqual(body, { defaultModel: 'openai/gpt-5.5', defaultAuthProvider: 'openai', defaultAuthChoice: 'api-key', thinking: 'high' });
  assert.equal(subsessionRuntimeRouteBody(null), undefined);
  const modelOptions = [
    { value: 'openai/gpt-5.5', label: 'gpt-5.5', provider: 'openai', thinkingLevels: ['low', 'high'] },
    { value: 'anthropic/claude', label: 'claude', provider: 'anthropic', thinkingLevels: ['off'] },
  ];
  const selection = subsessionRouteSelection(route, { model: 'x', thinking: 'off' });
  assert.deepEqual(subsessionRouteAfterSave(route, subsessionRouteInput(selection, { type: 'thinking', value: 'low' }, modelOptions)),
    { ...route, thinking: 'low' }, 'a thinking change keeps the account');
  const switched = subsessionRouteAfterSave(route, subsessionRouteInput(selection, { type: 'model', value: 'anthropic/claude' }, modelOptions));
  assert.deepEqual([switched.model, switched.authProvider, switched.authChoice], ['anthropic/claude', null, null],
    'another provider\'s model leaves the account behind');
  const sent: unknown[] = [];
  const client = new CloudAgentSubsessionClient(async <T,>(_path: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return record as T;
  });
  await client.sendAgentSubsessionMessage('token', 'thread', 'message', 'try again', [], body);
  await client.sendAgentSubsessionMessage('token', 'thread', 'message-2', 'again', []);
  assert.deepEqual(sent[0], { clientMessageId: 'message', text: 'try again', mentions: [], runtimeRoute: body });
  assert.equal('runtimeRoute' in (sent[1] as object), false, 'no chosen route keeps the thread route on the server');
});

function renderComposer(subsession: CompanionComposerProps['subsession'], draftText = 'try again') {
  const conversation = { id: 'thread', name: 'Write the notes', type: 'owned-agent', agentSubsessionId: 'thread', messages: [] } as unknown as Conversation;
  const props = {
    conversation, subsession, paneKind: 'agent', draftText, attachmentError: null, isNativeShell: true,
    attachmentInputRef: createRef<HTMLInputElement>(),
    composer: { chatComposerAttachments: [], saveDesktopAttachments: async () => [], saveDesktopAttachmentPaths: async () => [],
      removeChatComposerAttachment: () => {}, updateChatComposerAttachment: () => {} },
    runtime: {
      composerSelection: { mode: 'agent', model: 'openai/gpt-5.5', thinking: 'medium' },
      composerProviderOptions: [{ value: 'openai::api-key', providerId: 'openai', label: 'API key', active: true }],
      chatModelOptions: [{ value: 'openai/gpt-5.5', label: 'gpt-5.5', provider: 'openai' }],
      composerAuthLabel: 'OpenAI', composerAuthOptions: [],
      resolveChatRuntimeRoute: () => null,
    },
    localRouting: { enabled: false, selection: null, configTarget: null, authLabel: '', authOptions: [], isLoading: false, loadError: null, retry: () => {}, runtimeContextStatus: null, runtimeCacheText: null },
    collaborationRouting: { enabled: false, notice: null, agents: [], selectedAgent: null, selection: null, visibility: null, selectorOpen: false, setSelectedAgentId: () => {}, update: () => {}, defaultThinkingForModel: () => 'off' },
    ui: { openSelector: null, setOpenSelector: () => {}, toggleSelector: () => {}, prefersReducedMotion: true },
    onDraftChange: () => {}, onSend: () => {},
  } as unknown as CompanionComposerProps;
  return renderToStaticMarkup(createElement(CompanionComposer, props));
}

const base = { mentionOptions: [], sending: false, sendError: null, disabled: false, agentName: 'Helper' };

test('the owner sees the route menu and a plain-message hint in an agent thread', () => {
  const markup = renderComposer({ ...base, route: { value: { model: 'openai/gpt-5.5', authProvider: 'openai', authChoice: 'api-key', thinking: 'high' }, choose: () => {} } });
  assert.match(markup, /data-companion-thread-route="true"/);
  assert.match(markup, /gpt-5\.5/);
  assert.match(markup, /High/i);
  assert.match(markup, /Message Helper/);
  assert.doesNotMatch(markup, /@mention the agent/);
  assert.doesNotMatch(markup, /data-companion-send-control="true"[^>]*disabled=""/);
});

test('other members keep the mention hint and get no route menu', () => {
  const markup = renderComposer({ ...base, route: null });
  assert.doesNotMatch(markup, /data-companion-thread-route/);
  assert.match(markup, /@mention the agent for a reply/);
});

test('a thread route on an unavailable account disables Send like the main composer', () => {
  const unavailable = { model: 'openai/gpt-5.5', authProvider: 'openai', authChoice: 'cloud-login:removed', thinking: 'high' };
  assert.equal(subsessionRouteSelection(unavailable, { model: 'x', thinking: 'off' }).authChoice, 'cloud-login:removed');
  const markup = renderComposer({ ...base, route: { value: unavailable, choose: () => {} } });
  assert.match(markup, /Account unavailable/);
  assert.match(markup, /disabled=""[^>]*data-companion-send-control="true"|data-companion-send-control="true"[^>]*disabled=""/);
});
