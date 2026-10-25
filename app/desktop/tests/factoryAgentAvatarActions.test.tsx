import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import type { CanonicalAvatarMutation } from '../src/features/cloud/canonicalAvatar';
import type { UpdateCloudAgentInput } from '../src/features/cloud/cloudAgentsClient';
import { factoryAgentIdentityChanges } from '../src/kordi-app/agents/factoryAgentIdentity';
import type { AgentSaveFeedback, FactoryBuildRoute, FactorySection } from '../src/kordi-app/agents/model';
import { useFactoryAgentAvatarActions } from '../src/kordi-app/agents/useFactoryAgentAvatarActions';
import { useFactoryBuildRouting } from '../src/kordi-app/agents/useFactoryBuildRouting';
import type { useFactoryCreationAvatar } from '../src/kordi-app/agents/useFactoryCreationAvatar';
import type { Agent } from '../src/kordi-app/types';

const baseAgent: Agent = {
  id: 'cloud:agent/alpha',
  name: 'Research Agent',
  role: 'Research',
  messaging: 'Cloud runtime',
  status: 'Active',
  tasks: 0,
  defaultProvider: 'OpenAI',
  defaultModel: 'gpt-test',
  collaborationConfig: 'Cloud',
  contactId: 'research-agent',
  systemPrompt: '',
  xMd: '',
  identityFiles: [],
  loadedTools: [],
  loadedSkills: [],
  loadedPlugins: [],
  lastActivities: [],
  isOwned: true,
};
const cloudAgent: Agent = { ...baseAgent, cloudAgentId: 'agent_alpha', cloudAgentAvatarVersion: 4 };
const defaultAgent: Agent = { ...baseAgent, id: 'cloud-agent:acct_x', isCollaborationDefault: true };

async function withDom<T>(run: (render: (element: React.ReactElement) => Promise<void>) => Promise<T>) {
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
    return await run(async (element) => { await act(async () => root.render(element)); });
  } finally {
    await act(async () => root.unmount());
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
}

type AvatarActions = ReturnType<typeof useFactoryAgentAvatarActions>;

function stagedAvatar() {
  const staged: string[] = [];
  const factoryAvatar = {
    imageUrl: null,
    mutation: undefined,
    upload: (asset: string) => staged.push(`upload:${asset}`),
    randomize: (seed?: string) => staged.push(`regenerate:${seed}`),
    clearAvatar: () => undefined,
  } as ReturnType<typeof useFactoryCreationAvatar>;
  return { staged, factoryAvatar };
}

async function avatarActionsFor(agent: Agent, creating: boolean) {
  const cloudUpdates: UpdateCloudAgentInput[] = [];
  const localUpdates: CanonicalAvatarMutation[] = [];
  const feedback: Array<AgentSaveFeedback | null> = [];
  const { staged, factoryAvatar } = stagedAvatar();
  let actions: AvatarActions | null = null;
  function Probe() {
    actions = useFactoryAgentAvatarActions({
      creating,
      agent,
      factoryAvatar,
      onUpdateCloudAgent: async (_agent, input) => { cloudUpdates.push(input); return _agent; },
      onUpdateLocalAgentAvatar: async (mutation) => { localUpdates.push(mutation); },
      setPublishFeedback: (value) => { feedback.push(typeof value === 'function' ? value(null) : value); },
    });
    return null;
  }
  await withDom(async (render) => {
    await render(<Probe />);
    await act(async () => actions?.randomize('bird-owl-ink-paper'));
    await act(async () => actions?.upload('data:image/png;base64,avatar'));
  });
  return { cloudUpdates, localUpdates, staged, feedback };
}

test('an existing cloud agent saves avatar picks at once with the expected version', async () => {
  const result = await avatarActionsFor(cloudAgent, false);
  assert.deepEqual(result.cloudUpdates, [
    { avatarMutation: { action: 'regenerate', seed: 'bird-owl-ink-paper', expectedVersion: 4 } },
    { avatarMutation: { action: 'upload', uploadedAsset: 'data:image/png;base64,avatar', expectedVersion: 4 } },
  ]);
  assert.deepEqual(result.localUpdates, []);
  assert.deepEqual(result.staged, []);
  assert.deepEqual(result.feedback, []);
  assert.deepEqual(factoryAgentIdentityChanges(cloudAgent, null, undefined), []);
});

test('the default agent saves avatar picks through the account profile', async () => {
  const result = await avatarActionsFor(defaultAgent, false);
  assert.deepEqual(result.localUpdates, [
    { action: 'regenerate', seed: 'bird-owl-ink-paper' },
    { action: 'upload', uploadedAsset: 'data:image/png;base64,avatar' },
  ]);
  assert.deepEqual(result.cloudUpdates, []);
  assert.deepEqual(result.staged, []);
});

test('a new agent keeps staging its avatar until it is published', async () => {
  const result = await avatarActionsFor(cloudAgent, true);
  assert.deepEqual(result.staged, ['regenerate:bird-owl-ink-paper', 'upload:data:image/png;base64,avatar']);
  assert.deepEqual(result.cloudUpdates, []);
});

test('opening an agent routes into Build for that agent and returns to the Agent list', async () => {
  const routes: Array<FactoryBuildRoute | null> = [];
  const sections: FactorySection[] = [];
  let editAgentInBuild: ((agent: Agent) => Promise<void>) | null = null;
  const targetKey = 'account:acct_x:agent:cloud%3Aagent%2Falpha';
  function Probe() {
    ({ editAgentInBuild } = useFactoryBuildRouting({
      agents: [cloudAgent],
      builds: [{ targetKey, sessionId: 'session-1' } as never],
      buildRoute: null,
      canCreateAgent: true,
      cloudAccountId: 'acct_x',
      factorySection: 'agents',
      inspectedAgent: cloudAgent,
      libraryArtifacts: { tool: [], plugin: [] },
      librarySection: 'skill',
      selectedLibraryId: null,
      skills: [],
      setBuilds: () => undefined,
      setBuildRoute: (value) => { routes.push(typeof value === 'function' ? value(null) : value); },
      setBuildSeed: () => undefined,
      setBuilderGeneration: () => undefined,
      setFactorySection: (value) => { sections.push(typeof value === 'function' ? value('agents') : value); },
      setPublishFeedback: () => undefined,
    }));
    return null;
  }
  await withDom(async (render) => {
    await render(<Probe />);
    await act(async () => { await editAgentInBuild?.(cloudAgent); });
  });
  assert.equal(routes.at(-1)?.artifactKind, 'agent');
  assert.equal(routes.at(-1)?.artifactId, cloudAgent.id);
  assert.deepEqual(routes.at(-1)?.returnContext, { section: 'agents', selectedId: cloudAgent.id });
  assert.equal(sections.at(-1), 'build');
});
