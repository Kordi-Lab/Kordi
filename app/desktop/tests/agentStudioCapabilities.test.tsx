import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CloudAgentAccessScope } from '../src/features/cloud/cloudAgentsClient';
import { AgentStudioWorkspace, CapabilitiesView } from '../src/kordi-app/agents/AgentStudioWorkspace';
import { agentBuilderTargetKey, visibleAgentStudioTabIds, type AgentStudioConfigDraft } from '../src/kordi-app/agents/model';

const availableSkills = ['navigate-knowledge', 'clarify-requirements'];
const availableTools = ['write', 'web_fetch', 'web_search'];
const expectedOrder = ['clarify-requirements', 'navigate-knowledge', 'web_fetch', 'web_search', 'write'];
const skillDescriptions = {
  'clarify-requirements': 'Ask concise follow-up questions when a request is unclear.',
  'navigate-knowledge': 'Find and summarize relevant information before answering.',
};

test('agent builds use Blueprint instead of a duplicate Files tab', () => {
  assert.deepEqual(visibleAgentStudioTabIds(false, 'agent'), ['blueprint', 'capabilities', 'runs', 'history']);
  assert.deepEqual(visibleAgentStudioTabIds(true, 'agent'), ['blueprint', 'capabilities', 'runs', 'history']);
  assert.deepEqual(visibleAgentStudioTabIds(true, 'skill'), ['files', 'runs', 'history']);
});

test('Factory loads on demand in a dedicated production bundle', () => {
  const switchSource = readFileSync(new URL('../src/app/MainContentSwitch.tsx', import.meta.url), 'utf8');
  const pagesSource = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');
  const viteSource = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');

  assert.match(switchSource, /lazy\(\(\) => import\('@\/kordi-app\/agents\/AgentsPage'\)/);
  assert.match(switchSource, /<Suspense fallback=/);
  assert.doesNotMatch(pagesSource, /export \{ AgentsPage \}/);
  assert.ok(viteSource.indexOf("name: 'agent-studio'") < viteSource.indexOf("name: 'agent-factory'"));
  assert.match(viteSource, /name: 'agent-factory'/);
});

function factoryWorkspace(
  onAccessScopeChange: (scope: CloudAgentAccessScope) => void = () => undefined,
  onNameChange: (name: string) => void = () => undefined,
) {
  return (
    <AgentStudioWorkspace
      creating
      artifactKind="agent"
      creationDraft={{
        name: 'Research agent',
        role: 'Research assistant',
        description: 'Finds and summarizes relevant sources.',
        systemPrompt: 'Research the question before answering.',
        sourceSummary: '',
        boundaries: [],
        skills: [],
      }}
      creationAccessScope="private"
      agentAccessScope="private"
      onCreationAccessScopeChange={onAccessScopeChange}
      config={null}
      persisted={null}
      changes={[]}
      availableSkills={[]}
      skillDescriptions={{}}
      availableTools={[]}
      availablePlugins={[]}
      editableCapabilityKinds={new Set()}
      allowCapabilityCreation
      canEditPrompt
      onPromptChange={() => undefined}
      onNameChange={onNameChange}
      onCreationDraftChange={() => undefined}
      onToggleCapability={() => undefined}
      onAddCapability={() => undefined}
      onRenameCapability={() => undefined}
      onPublish={() => undefined}
      onDiscard={() => undefined}
      publishing={false}
      publishFeedback={null}
      publishDisabled={false}
      draftMutationDisabled={false}
      activeDetail={null}
      activeFilePreview={{ status: 'idle', text: '' }}
      activeFileDraft=""
      activeFileCanEdit={false}
      activeFileIsEditing={false}
      activeFileSaveFeedback={null}
      onSelectPrompt={() => undefined}
      onSelectFile={() => undefined}
      onStartFileEditing={() => undefined}
      onCancelFileEditing={() => undefined}
      onSaveFile={() => undefined}
      onFileDraftChange={() => undefined}
    />
  );
}

test('Factory draft targets are isolated by signed-in Cloud account', () => {
  assert.equal(
    agentBuilderTargetKey(' account/one ', 'agent:shared-id'),
    'account:account%2Fone:agent:shared-id',
  );
  assert.equal(
    agentBuilderTargetKey('account-two', 'agent:shared-id'),
    'account:account-two:agent:shared-id',
  );
  assert.equal(agentBuilderTargetKey(null, 'create-agent'), 'device:create-agent');
});

test('Factory keeps its publish action only in the bottom-right workspace footer', () => {
  const agentsPageSource = readFileSync(new URL('../src/kordi-app/agents/AgentsPage.tsx', import.meta.url), 'utf8');
  const html = renderToStaticMarkup(factoryWorkspace());

  const footerStart = html.indexOf('app-agent-studio-workspace-footer');
  assert.equal(footerStart >= 0, true);
  assert.equal(html.match(/>Publish agent<\/button>/g)?.length, 1);
  assert.equal(html.indexOf('>Publish agent</button>') > footerStart, true);
  assert.doesNotMatch(html, /app-agent-studio-blueprint-core/);
  assert.match(html, /app-agent-studio-icon-button is-inline-edit/);
  assert.match(html, /app-agent-studio-access-edit/);
  assert.match(html, /aria-label="Edit access"/);
  assert.match(html, /aria-label="Edit name"/);
  assert.match(html, />Research agent</);
  assert.match(html, /aria-haspopup="menu"/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /app-agent-studio-access-picker/);
  assert.doesNotMatch(html, /app-agent-studio-inline-select/);
  assert.doesNotMatch(agentsPageSource, /Open full conversation/);
  assert.doesNotMatch(agentsPageSource, /<h2>Kordi Factory<\/h2>/);
  assert.doesNotMatch(agentsPageSource, /<span className="app-agent-studio-factory-mark"/);
});

test('Factory keeps an owner-edited Kordi name in the draft', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let renamed = '';

  try {
    await act(async () => root?.render(factoryWorkspace(() => undefined, (name) => { renamed = name; })));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Edit name"]');
    await act(async () => trigger?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })));
    const input = host.querySelector<HTMLInputElement>('[role="dialog"][aria-label="Edit agent name"] input');
    assert.ok(input);
    input.value = 'Release Scout';
    const keep = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Keep in draft');
    await act(async () => keep?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(renamed, 'Release Scout');
    assert.equal(host.querySelector('[role="dialog"][aria-label="Edit agent name"]'), null);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
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
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

test('access choices render inside Kordi instead of a native select', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let selectedScope: CloudAgentAccessScope | null = null;

  try {
    await act(async () => root?.render(factoryWorkspace((scope) => { selectedScope = scope; })));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Edit access"]');

    await act(async () => trigger?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })));

    const menu = host.querySelector('[role="menu"][aria-label="Agent access"]');
    const sharedOption = host.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="false"]');
    assert.ok(menu);
    assert.equal(host.querySelector('select'), null);

    await act(async () => sharedOption?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(selectedScope, 'participant_conversations');
    assert.equal(host.querySelector('[role="menu"][aria-label="Agent access"]'), null);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

function capabilities(config: AgentStudioConfigDraft) {
  return (
    <CapabilitiesView
      creating={false}
      config={config}
      creationDraft={null}
      availableSkills={availableSkills}
      skillDescriptions={skillDescriptions}
      availableTools={availableTools}
      availablePlugins={[]}
      editableKinds={new Set(['skill'])}
      allowCapabilityCreation={false}
      onToggle={() => undefined}
      onAdd={() => undefined}
      onRename={() => undefined}
    />
  );
}

function renderCapabilities(config: AgentStudioConfigDraft) {
  return renderToStaticMarkup(capabilities(config));
}

function assertCapabilityOrder(html: string) {
  const positions = expectedOrder.map((name) => html.indexOf(`<strong>${name}</strong>`));
  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
}

test('capability order stays alphabetical when selections change', () => {
  const toolsLoaded = renderCapabilities({
    systemPrompt: '',
    loadedSkills: [],
    loadedTools: ['web_fetch', 'web_search', 'write'],
    loadedPlugins: [],
  });
  const skillsLoaded = renderCapabilities({
    systemPrompt: '',
    loadedSkills: ['clarify-requirements', 'navigate-knowledge'],
    loadedTools: [],
    loadedPlugins: [],
  });

  assertCapabilityOrder(toolsLoaded);
  assertCapabilityOrder(skillsLoaded);
});

test('capability rows show descriptions without type or read-only labels', () => {
  const html = renderCapabilities({
    systemPrompt: '',
    loadedSkills: [],
    loadedTools: ['web_fetch'],
    loadedPlugins: [],
  });

  assert.doesNotMatch(html, /Included in this draft|Available to add|>Published<|>Draft<|>Available</);
  assert.doesNotMatch(html, /<code>(?:skill|tool)<\/code>|>Read only</);
  assert.match(html, /Ask concise follow-up questions when a request is unclear\./);
  assert.match(html, /Read content from a web page\./);
  assert.match(html, /aria-label="Remove web_fetch from this agent"/);
  assert.match(html, /aria-label="Add clarify-requirements to this agent"/);
});

test('a capability keeps its row position when its loaded state changes', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  const loadedConfig: AgentStudioConfigDraft = {
    systemPrompt: '',
    loadedSkills: ['custom-review'],
    loadedTools: ['web_fetch'],
    loadedPlugins: [],
  };
  const unloadedConfig: AgentStudioConfigDraft = { ...loadedConfig, loadedSkills: [] };

  try {
    await act(async () => root?.render(capabilities(loadedConfig)));
    const before = Array.from(host.querySelectorAll('.app-agent-studio-capability-name strong'), (node) => node.textContent);
    const beforeIndex = before.indexOf('custom-review');

    await act(async () => root?.render(capabilities(unloadedConfig)));
    const after = Array.from(host.querySelectorAll('.app-agent-studio-capability-name strong'), (node) => node.textContent);
    const customSwitch = host.querySelector('[aria-label="Add custom-review to this agent"]');

    assert.equal(beforeIndex >= 0, true);
    assert.deepEqual(after, before);
    assert.equal(after.indexOf('custom-review'), beforeIndex);
    assert.equal(customSwitch?.getAttribute('aria-checked'), 'false');
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});
