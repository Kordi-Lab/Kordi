import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import React from 'react';
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

function renderAgentRail(agent: Agent) {
  return renderToStaticMarkup(
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
    />,
  );
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

test('the Factory rail shows the own agent avatar for the default host agent', () => {
  setLocalAgentAvatar({ accountId: 'acct_x', seed: 'default-agent-acct_x', imageUrl: null });
  const fields = collaborationAgentAvatarFields(defaultHostAgent);
  assert.equal(fields.avatarSeed, 'default-agent-acct_x');

  const row = agentRowAvatar(renderAgentRail(factoryAgent(fields)));
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
