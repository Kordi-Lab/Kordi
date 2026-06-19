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

test('AgentDetailPane shows private access menu for cloud-created agents', () => {
  const markup = renderToStaticMarkup(createElement(AgentDetailPane, {
    activeAgent: cloudAgent,
    activeAgentConfig: { systemPrompt: cloudAgent.systemPrompt, loadedSkills: cloudAgent.loadedSkills },
    activePersistedConfig: { systemPrompt: cloudAgent.systemPrompt, loadedSkills: cloudAgent.loadedSkills, loadedTools: [], loadedPlugins: [], editHistory: [] },
    activeDetail: { kind: 'prompt' },
    activeSaveFeedback: null,
    activeEditingSection: null,
    availableSkills: cloudAgent.loadedSkills,
    onUpdateModelRouting: undefined,
    onReset: () => undefined,
    onOpenPromptDetail: () => undefined,
    onStartEditing: () => undefined,
    onSave: () => undefined,
    onCancelEditing: () => undefined,
    onToggleSkill: () => undefined,
    onSelectIdentityFile: () => undefined,
  }));

  assert.match(markup, /Private — only me/);
  assert.match(markup, /Synced privately to your Cloud account/);
});
