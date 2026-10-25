import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { setLocalAgentAvatar } from '../src/features/canonical/localAgentAvatar';
import { collaborationAgentAvatarFields } from '../src/features/cloud/cloudAgents';
import { AgentStudioRail } from '../src/kordi-app/agents/AgentStudioRail';
import type { Agent, DesktopCollaborationAgent } from '../src/kordi-app/types';

// The cloud host lists the account's default agent under this id; it is not a valid avatar seed.
const defaultHostAgent: Pick<DesktopCollaborationAgent, 'id' | 'isDefault' | 'profileImageUrl'> = {
  id: 'cloud-agent:acct_x',
  isDefault: true,
  profileImageUrl: null,
};

function factoryAgent(overrides: Partial<Agent>): Agent {
  return {
    id: defaultHostAgent.id,
    name: 'littlefish',
    role: 'My agent',
    messaging: 'Direct local chat',
    status: 'Active',
    tasks: 0,
    defaultProvider: 'OpenAI',
    defaultModel: 'gpt-test',
    collaborationConfig: 'Kordi Cloud',
    contactId: `collaboration-agent:cloud:${defaultHostAgent.id}`,
    systemPrompt: '',
    xMd: '',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    isOwned: true,
    ...overrides,
  };
}

function agentRailElement(agent: Agent) {
  return (
    <AgentStudioRail
      agents={[agent]}
      activeAgentId={agent.id}
      builds={[]}
      activeBuildSessionId={null}
      skills={[]}
      libraryArtifacts={{ tool: [], plugin: [] }}
      selectedLibraryId={null}
      section="agents"
      librarySection="skill"
      libraryCommunity={false}
      canCreateAgent
      onSectionChange={() => undefined}
      onLibrarySectionChange={() => undefined}
      onOpenBuild={() => undefined}
      onOpenAgent={() => undefined}
      onOpenLibraryArtifact={() => undefined}
      onCreateArtifact={() => undefined}
    />
  );
}

function renderAgentRail(agent: Agent) {
  return renderToStaticMarkup(agentRailElement(agent));
}

/** Client render, so the own-agent avatar store is read live instead of its signed-out server snapshot. */
async function renderAgentRailInDom(agent: Agent) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://kordi.ai/' });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(agentRailElement(agent)));
    return host.innerHTML;
  } finally {
    await act(async () => root.unmount());
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
}

function agentRowAvatar(markup: string) {
  const row = markup.match(/<button[^>]*app-agent-studio-agent-row[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.ok(row, 'the agent row renders');
  return row;
}

afterEach(() => setLocalAgentAvatar(null));

test('an id-only avatar seed for the default host agent renders an empty tile', () => {
  const row = agentRowAvatar(renderAgentRail(factoryAgent({ avatarSeed: defaultHostAgent.id })));
  assert.match(row, /data-avatar-state="fallback"/);
  assert.doesNotMatch(row, /<img/);
});

test('the Factory rail shows the own agent avatar for the default host agent', async () => {
  setLocalAgentAvatar({ accountId: 'acct_x', seed: 'default-agent-acct_x', imageUrl: null });
  const fields = collaborationAgentAvatarFields(defaultHostAgent);
  // A stable own-agent seed, so the row follows the account snapshot after a change.
  assert.equal(fields.avatarSeed, 'cloud-local-agent');

  const row = agentRowAvatar(await renderAgentRailInDom(factoryAgent(fields)));
  assert.match(row, /data-avatar-state="ready"/);
  assert.match(row, /<img[^>]+src="[^"]*\/v1\/avatars\/preview\/kordi-birds\/default-agent-acct_x\.png"/);
  // Same 36px tile as the agent rows in the Chats sidebar.
  assert.match(row, /class="relative inline-flex shrink-0 rounded-\[17%\] h-9 w-9"/);
});

test('a host agent avatar image is kept, and other host agents keep their id seed', () => {
  const uploaded = 'https://cloud.example/v1/avatars/assets/ava_1/256.jpg';
  assert.deepEqual(
    collaborationAgentAvatarFields({ id: 'agt_research', isDefault: false, profileImageUrl: ` ${uploaded} ` }),
    { avatarSeed: 'agt_research', profileImageUrl: uploaded },
  );
});

test('own agent rows follow the account snapshot after its avatar changes', async () => {
  setLocalAgentAvatar({ accountId: 'acct_x', seed: 'bird-owl-color-paper', imageUrl: null });
  const fields = collaborationAgentAvatarFields(defaultHostAgent);
  assert.equal(collaborationAgentAvatarFields(defaultHostAgent).avatarSeed, fields.avatarSeed);
  const staleImage = 'https://cloud.example/v1/avatars/preview/kordi-birds/bird-owl-color-paper.png';
  const staleRow = factoryAgent({ ...fields, profileImageUrl: staleImage });

  setLocalAgentAvatar({
    accountId: 'acct_x',
    seed: 'bird-sparrow-ink-sakura',
    imageUrl: 'https://cloud.example/v1/avatars/assets/ava_2/256.jpg',
  });
  const row = agentRowAvatar(await renderAgentRailInDom(staleRow));
  assert.match(row, /<img[^>]+src="https:\/\/cloud\.example\/v1\/avatars\/assets\/ava_2\/256\.jpg"/);
  assert.doesNotMatch(row, /bird-owl-color-paper/);

  setLocalAgentAvatar({ accountId: 'acct_x', seed: 'bird-sparrow-ink-sakura', imageUrl: null });
  const fallbackRow = agentRowAvatar(await renderAgentRailInDom(staleRow));
  assert.match(fallbackRow, /bird-owl-color-paper/, 'the row image stays when the snapshot has none');
});
