import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentCreateDialog } from '../src/kordi-app/agents/AgentCreateDialog';
import { AgentsSidebar } from '../src/kordi-app/agents/AgentsSidebar';
import { AgentDeleteConfirmDialog, AgentDetailPane } from '../src/kordi-app/agents/AgentDetailPane';
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

test('AgentCreateDialog shows real cloud access options', () => {
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
  assert.match(markup, /Only me/);
  assert.match(markup, /People in my chats can mention it/);
  assert.match(markup, /Only you can use this agent/);
  assert.doesNotMatch(markup, /coming later/);
  assert.doesNotMatch(markup, /Workspace\/shared Cloud/);
});

test('AgentCreateDialog creates agents with the selected access scope', () => {
  const source = readFileSync(new URL('../src/kordi-app/agents/AgentCreateDialog.tsx', import.meta.url), 'utf8');

  assert.match(source, /const \[accessScope, setAccessScope\]/);
  assert.match(source, /accessScope,\n\s*name: draft\.name/);
  assert.doesNotMatch(source, /accessScope: 'private',\n\s*name: draft\.name/);
});

test('AgentCreateDialog keeps shape and create actions in a sticky footer', () => {
  const source = readFileSync(new URL('../src/kordi-app/agents/AgentCreateDialog.tsx', import.meta.url), 'utf8');
  const footerStart = source.indexOf('app-agent-create-actions');

  assert.notEqual(footerStart, -1);
  assert.notEqual(source.indexOf('Shape draft with Kordi', footerStart), -1);
  assert.notEqual(source.indexOf('Create Agent', footerStart), -1);
});

test('AgentCreateDialog uses calm auth-aligned surfaces without dashed callout chrome', () => {
  const source = readFileSync(new URL('../src/kordi-app/agents/AgentCreateDialog.tsx', import.meta.url), 'utf8');
  const shellPagesCss = readFileSync(new URL('../src/styles/shell-pages.css', import.meta.url), 'utf8');

  assert.match(source, /app-agent-create-surface/);
  assert.match(source, /app-agent-create-panel/);
  assert.match(source, /app-agent-create-muted/);
  assert.doesNotMatch(source, /border-dashed/);
  assert.match(shellPagesCss, /\.app-agent-create-surface[\s\S]*background:\s*var\(--app-transient-surface-bg\)/);
  assert.match(shellPagesCss, /\.app-agent-create-muted[\s\S]*background:\s*var\(--app-transient-raised-bg\)/);
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

  assert.match(markup, /Only me/);
  assert.match(markup, /Only you can use this agent/);
});

test('AgentDetailPane enables Message for private cloud-created agents', () => {
  const markup = renderAgentDetail(cloudAgent, { onMessage: () => undefined });

  assert.match(markup, />Message<\/button>/);
  assert.doesNotMatch(markup, /disabled="">Message<\/button>/);
});

test('AgentDetailPane exposes delete action only for private cloud agents', () => {
  const cloudMarkup = renderAgentDetail(cloudAgent, { onArchiveCloudAgent: async () => undefined });
  const kordiMarkup = renderAgentDetail(creatorAgent, { onArchiveCloudAgent: async () => undefined });

  assert.match(cloudMarkup, /More agent actions/);
  assert.match(cloudMarkup, /Delete agent/);
  assert.doesNotMatch(kordiMarkup, /Delete agent/);
});

test('agent deletion uses the accessible shared modal lifecycle', () => {
  const markup = renderToStaticMarkup(createElement(AgentDeleteConfirmDialog, {
    agent: cloudAgent,
    isDeleting: true,
    error: null,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /aria-labelledby="delete-agent-dialog-title"/);
  assert.match(markup, /aria-busy="true"/);
});

test('AgentDetailPane uses an in-app delete dialog instead of native window.confirm', () => {
  const source = readFileSync(new URL('../src/kordi-app/agents/AgentDetailPane.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /AgentDeleteConfirmDialog/);
});

test('AgentDeleteConfirmDialog renders recoverable archive copy', async () => {
  const { AgentDeleteConfirmDialog } = await import('../src/kordi-app/agents/AgentDetailPane');
  const markup = renderToStaticMarkup(createElement(AgentDeleteConfirmDialog, {
    agent: cloudAgent,
    isDeleting: false,
    error: null,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(markup, /Delete this agent\?/);
  assert.match(markup, /Docs Helper/);
  assert.match(markup, /removed from your Agent page/);
  assert.match(markup, /kept as an archived Cloud record/);
  assert.match(markup, /Cancel/);
  assert.match(markup, /Delete agent/);
});

test('archiveAgentFromMenu archives private cloud agents without leaking success onto the next selected agent', async () => {
  const { archiveAgentFromMenu } = await import('../src/kordi-app/agents/AgentDetailPane');
  let archivedAgent: Agent | null = null;
  const feedback: string[] = [];

  const archived = await archiveAgentFromMenu({
    agent: cloudAgent,
    onArchiveCloudAgent: async (agent) => { archivedAgent = agent; },
    onFeedback: (message) => feedback.push(message.text),
  });

  assert.equal(archived, true);
  assert.equal(archivedAgent?.id, cloudAgent.id);
  assert.deepEqual(feedback, ['Deleting Docs Helper…']);
});
