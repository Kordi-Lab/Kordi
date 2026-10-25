import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentStudioWorkspaceFooter } from '../src/kordi-app/agents/AgentStudioWorkspaceFooter';
import { resolveFactoryBuildAgent } from '../src/kordi-app/agents/factoryBuildAgent';
import type { FactoryBuildRoute } from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: 'Kordi',
    role: 'My agent',
    messaging: 'Direct local chat',
    status: 'Active',
    tasks: 0,
    defaultProvider: 'OpenAI',
    defaultModel: 'gpt-test',
    collaborationConfig: 'Kordi Cloud',
    contactId: id,
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

const route = (artifactId: string, defaultAgent?: true): FactoryBuildRoute => ({
  targetKey: `device:agent:${artifactId}`,
  sessionId: null,
  artifactKind: 'agent',
  artifactId,
  returnContext: null,
  ...(defaultAgent ? { defaultAgent } : {}),
});

test('a Build route keeps its agent while the agent list is rebuilt', () => {
  const previous = agent('desktop:local-agent');
  const renamed = agent('cloud-agent:acct_x', { isCollaborationDefault: true });
  const research = agent('cloud:research', { cloudAgentId: 'research' });

  assert.equal(resolveFactoryBuildAgent(route('desktop:local-agent', true), [research, renamed], null), renamed);
  assert.equal(
    resolveFactoryBuildAgent(route('desktop:local-agent', true), [], { artifactId: 'desktop:local-agent', agent: previous }),
    previous,
  );
  assert.equal(resolveFactoryBuildAgent(route('cloud:research'), [], { artifactId: 'cloud:research', agent: research }), research);
  assert.equal(resolveFactoryBuildAgent(route('cloud:research'), [], { artifactId: 'cloud:other', agent: research }), undefined);
  assert.equal(resolveFactoryBuildAgent(route('cloud:research'), [renamed], null), undefined, 'only default-agent routes follow the default agent');
  assert.equal(resolveFactoryBuildAgent(null, [research], null), undefined);
});

function footer(props: Partial<React.ComponentProps<typeof AgentStudioWorkspaceFooter>>) {
  return renderToStaticMarkup(
    <AgentStudioWorkspaceFooter
      artifactKind="agent"
      standaloneBuild={false}
      creating={false}
      hasCreationDraft={false}
      hasAgent
      changeCount={0}
      publishing={false}
      publishDisabled={false}
      draftMutationDisabled={false}
      onDiscard={() => undefined}
      onPublish={() => undefined}
      {...props}
    />,
  );
}

test('an existing agent always shows the publish bar', () => {
  const idle = footer({});
  assert.match(idle, />No unpublished changes</);
  assert.match(idle, /<button[^>]*disabled=""[^>]*>Publish<\/button>/);
  assert.doesNotMatch(idle, />Discard</);

  const changed = footer({ changeCount: 2 });
  assert.match(changed, />2 unpublished changes</);
  assert.match(changed, />Discard</);
  assert.doesNotMatch(changed, /disabled=""[^>]*>Publish</);

  assert.equal(footer({ builderStatus: { lifecycle: 'published' } as never }), '');
  assert.equal(footer({ hasAgent: false }), '');
  assert.match(footer({ creating: true, hasAgent: false, hasCreationDraft: true }), />Publish agent</);
});
