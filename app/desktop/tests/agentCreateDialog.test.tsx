import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentCreateDialog } from '../src/kordi-app/agents/AgentCreateDialog';
import { AgentsSidebar } from '../src/kordi-app/agents/AgentsSidebar';
import { AgentDetailPane } from '../src/kordi-app/agents/AgentDetailPane';
import type { Agent } from '../src/kordi-app/types';

const creatorAgent: Agent = {
  id: 'desktop:local-agent',
  name: 'Kordi',
  role: 'My agent',
  messaging: 'Local runtime',
  status: 'Active',
  tasks: 0,
  defaultProvider: 'openai',
  defaultModel: 'openai/gpt-5.5',
  defaultAuthProvider: 'openai',
  defaultAuthChoice: 'api-key',
  bridgesConfig: 'Local runtime',
  contactId: 'desktop:local-agent',
  systemPrompt: 'You are an expert coding assistant.',
  identityFiles: ['AGENTS.md'],
  loadedTools: ['read', 'bash', 'edit'],
  loadedSkills: ['brainstorming', 'test-driven-development'],
  loadedPlugins: [],
  lastActivities: [],
  isOwned: true,
};

const cloudAgent: Agent = {
  id: 'cloud-agent:cloud_agent_1',
  cloudAgentId: 'cloud_agent_1',
  cloudAgentAccessScope: 'private',
  name: 'Docs Helper',
  role: 'Technical support agent',
  messaging: 'Private Cloud agent',
  status: 'Active',
  tasks: 0,
  bridgesConfig: 'Cloud synced',
  contactId: 'cloud-agent:cloud_agent_1',
  systemPrompt: 'Use docs only.',
  xMd: 'Cloud Agent Definition',
  identityFiles: [],
  loadedTools: [],
  loadedSkills: ['navigate-knowledge'],
  loadedPlugins: [],
  lastActivities: ['Created in Cloud'],
  isOwned: true,
};

test('AgentCreateDialog shows private-only access menu and future sharing options', () => {
  const markup = renderToStaticMarkup(createElement(AgentCreateDialog, {
    open: true,
    creatorAgent,
    onClose: () => undefined,
    onCreateCloudAgent: async () => cloudAgent,
  }));

  assert.match(markup, /Create Cloud Agent/);
  assert.match(markup, /Created by Kordi/);
  assert.match(markup, /3 tools/);
  assert.match(markup, /2 skills/);
  assert.match(markup, /read/);
  assert.match(markup, /brainstorming/);
  assert.match(markup, /Private — only me/);
  assert.match(markup, /Share with contacts — coming later/);
  assert.match(markup, /Workspace\/shared Cloud — coming later/);
  assert.match(markup, /MVP agents are creator-owned\/private Cloud sync only/);
});

test('AgentsSidebar exposes New agent action when cloud creation is available', () => {
  const markup = renderToStaticMarkup(createElement(AgentsSidebar, {
    agents: [cloudAgent],
    activeAgentId: cloudAgent.id,
    agentConfigs: { [cloudAgent.id]: { systemPrompt: cloudAgent.systemPrompt, loadedSkills: cloudAgent.loadedSkills } },
    getStatusBadgeClass: () => '',
    onOpenAgent: () => undefined,
    onCreateAgentClick: () => undefined,
  }));

  assert.match(markup, /\+ New agent/);
  assert.doesNotMatch(markup, /disabled=""[^>]*>\+ New agent/);
});

function renderAgentDetail(agent: Agent, extraProps: Partial<Parameters<typeof AgentDetailPane>[0]> = {}) {
  return renderToStaticMarkup(createElement(AgentDetailPane, {
    activeAgent: agent,
    activeAgentConfig: { systemPrompt: agent.systemPrompt, loadedSkills: agent.loadedSkills },
    activePersistedConfig: { systemPrompt: agent.systemPrompt, loadedSkills: agent.loadedSkills, loadedTools: [], loadedPlugins: [], editHistory: [] },
    activeDetail: { kind: 'prompt' },
    activeSaveFeedback: null,
    activeEditingSection: null,
    availableSkills: agent.loadedSkills,
    onUpdateModelRouting: undefined,
    onReset: () => undefined,
    onOpenPromptDetail: () => undefined,
    onStartEditing: () => undefined,
    onSave: () => undefined,
    onCancelEditing: () => undefined,
    onToggleSkill: () => undefined,
    onSelectIdentityFile: () => undefined,
    ...extraProps,
  }));
}

test('AgentDetailPane shows private access menu for cloud-created agents', () => {
  const markup = renderAgentDetail(cloudAgent);

  assert.match(markup, /Private — only me/);
  assert.match(markup, /Synced privately to your Cloud account/);
});

test('AgentDetailPane exposes delete action only for private cloud agents', () => {
  const cloudMarkup = renderAgentDetail(cloudAgent, { onArchiveCloudAgent: async () => undefined });
  const kordiMarkup = renderAgentDetail(creatorAgent, { onArchiveCloudAgent: async () => undefined });

  assert.match(cloudMarkup, /More agent actions/);
  assert.match(cloudMarkup, /Delete agent/);
  assert.doesNotMatch(kordiMarkup, /Delete agent/);
});

test('archiveAgentFromMenu confirms and archives private cloud agents', async () => {
  const { archiveAgentFromMenu } = await import('../src/kordi-app/agents/AgentDetailPane');
  let archivedAgent: Agent | null = null;
  const feedback: string[] = [];

  const archived = await archiveAgentFromMenu({
    agent: cloudAgent,
    confirm: () => true,
    onArchiveCloudAgent: async (agent) => { archivedAgent = agent; },
    onFeedback: (message) => feedback.push(message.text),
  });

  assert.equal(archived, true);
  assert.equal(archivedAgent?.id, cloudAgent.id);
  assert.deepEqual(feedback, ['Deleting Docs Helper…', 'Deleted Docs Helper.']);
});

test('archiveAgentFromMenu does not archive when confirmation is cancelled', async () => {
  const { archiveAgentFromMenu } = await import('../src/kordi-app/agents/AgentDetailPane');
  let called = false;

  const archived = await archiveAgentFromMenu({
    agent: cloudAgent,
    confirm: () => false,
    onArchiveCloudAgent: async () => { called = true; },
  });

  assert.equal(archived, false);
  assert.equal(called, false);
});
