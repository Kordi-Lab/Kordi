import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentStudioRail } from '../src/kordi-app/agents/AgentStudioRail';
import { AddToAgentControl, SkillLibraryView } from '../src/kordi-app/agents/SkillLibraryView';
import { skillLibraryFileDisplay } from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';
import type { DesktopSkillLibraryEntry } from '../src/lib/desktop';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

const builtSkill: DesktopSkillLibraryEntry = {
  id: 'skill:review',
  name: 'repository-review',
  description: 'Review repository changes with a focused checklist.',
  sourceLabel: 'global skill',
  sourcePath: '/tmp/.kordi/skills/repository-review/SKILL.md',
  scope: 'global',
  origin: 'built',
  enabled: false,
  editable: true,
  removable: true,
  version: null,
  provider: null,
  owner: null,
  sourceUrl: null,
  digest: null,
  fileCount: 1,
};

const externalUiSkill: DesktopSkillLibraryEntry = {
  ...builtSkill,
  id: 'skill:adapt',
  name: 'adapt',
  description: 'Adapt interface designs across screen sizes and responsive layouts.',
  sourceLabel: 'Settings:External',
  sourcePath: '/tmp/.agents/skills/adapt/SKILL.md',
  scope: 'shared',
  origin: 'external',
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:kordi',
    name: 'Kordi',
    role: 'Personal agent',
    messaging: 'Local runtime',
    status: 'Active',
    tasks: 0,
    defaultProvider: 'OpenAI',
    defaultModel: 'gpt-test',
    collaborationConfig: 'Local runtime',
    contactId: 'agent:kordi',
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

function railProps(overrides: Partial<React.ComponentProps<typeof AgentStudioRail>> = {}): React.ComponentProps<typeof AgentStudioRail> {
  return {
    agents: [],
    activeAgentId: '',
    builds: [],
    activeBuildSessionId: null,
    skills: [],
    libraryArtifacts: { tool: [], plugin: [] },
    selectedLibraryId: null,
    section: 'build',
    librarySection: 'skill',
    libraryCommunity: false,
    canCreateAgent: true,
    onSectionChange: () => undefined,
    onLibrarySectionChange: () => undefined,
    onOpenBuild: () => undefined,
    onOpenAgent: () => undefined,
    onOpenLibraryArtifact: () => undefined,
    onCreateArtifact: () => undefined,
    ...overrides,
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
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

test('skill file rows do not repeat a root filename as their subtitle', () => {
  const source = readFileSync(new URL('../src/kordi-app/agents/SkillLibraryView.tsx', import.meta.url), 'utf8');
  assert.deepEqual(skillLibraryFileDisplay('SKILL.md'), { name: 'SKILL.md', parent: null });
  assert.deepEqual(skillLibraryFileDisplay('references/api.md'), { name: 'api.md', parent: 'references' });
  assert.doesNotMatch(source, /Editable Factory skill|Read only/);
});

test('Factory rail exposes Build, Agent, Lib and all chat-first artifact kinds', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({ skills: [builtSkill], section: 'agents' })} />,
  );

  assert.match(html, /New agent/);
  assert.match(html, /New skill/);
  assert.match(html, /New tool/);
  assert.match(html, /New plugin/);
  assert.match(html, />Build<\/button>/);
  assert.match(html, /Agent <span>0<\/span>/);
  assert.match(html, /Lib <span>1<\/span>/);
  assert.match(html, /Search agents/);
  assert.doesNotMatch(html, /Factory runtime connected/);
});

test('Factory build rows stay compact and omit decorative icons and private-draft copy', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({
      section: 'build',
      builds: [{
        draftId: 'draft:one',
        targetKey: 'target:one',
        sessionId: 'session:one',
        artifactKind: 'agent',
        name: 'Research helper',
        lifecycle: 'draft',
        updatedAtMs: 1,
        available: true,
      }],
    })} />,
  );

  assert.match(html, /app-agent-studio-agent-row is-compact/);
  assert.match(html, /<strong>Research helper<\/strong><span class="app-agent-studio-agent-state">Agent<\/span>/);
  assert.doesNotMatch(html, /Private draft|app-agent-studio-draft-avatar/);
});

test('Factory plus menu stays fully inside the narrow rail', () => {
  const css = readDesktopShellCss();
  const panelRule = css.match(/\.app-factory-create-menu-panel\s*\{([^}]*)\}/)?.[1];

  assert.ok(panelRule);
  assert.match(panelRule, /right:\s*-16px;/);
  assert.match(panelRule, /width:\s*min\(224px,\s*calc\(100vw - 24px\)\);/);
});

test('Factory plus menu dismisses outside and restores trigger focus on Escape', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(host, outside);
  let root: Root | null = createRoot(host);

  try {
    await act(async () => root?.render(
      <AgentStudioRail {...railProps({ skills: [builtSkill] })} />,
    ));

    const details = host.querySelector<HTMLDetailsElement>('.app-factory-create-menu');
    const summary = host.querySelector<HTMLElement>('.app-agent-studio-rail-add');
    assert.ok(details);
    assert.ok(summary);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new installed.dom.window.Event('toggle'));
    });
    assert.equal(details.open, true);
    assert.equal(summary.getAttribute('aria-expanded'), 'true');

    await act(async () => {
      outside.dispatchEvent(new installed.dom.window.Event('pointerdown', { bubbles: true }));
    });
    assert.equal(details.open, false);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');

    const firstMenuItem = host.querySelector<HTMLButtonElement>('[role="menuitem"]');
    assert.ok(firstMenuItem);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new installed.dom.window.Event('toggle'));
    });
    firstMenuItem.focus();
    assert.equal(document.activeElement, firstMenuItem);

    await act(async () => {
      firstMenuItem.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    assert.equal(details.open, false);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, summary);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    outside.remove();
    host.remove();
    installed.restore();
  }
});

test('Factory agent selection spans the full rail while content stays aligned', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({ agents: [agent()], activeAgentId: 'agent:kordi', section: 'agents' })} />,
  );
  const css = readDesktopShellCss();

  assert.match(html, /app-agent-studio-agent-list app-scroll-area is-agent-list/);
  assert.match(html, /app-agent-studio-agent-row app-session-row-active/);
  assert.match(
    css,
    /\.app-agent-studio-agent-list\.is-agent-list\s*\{[^}]*padding-inline:\s*0;/s,
  );
  assert.match(
    css,
    /\.app-agent-studio-agent-list\.is-agent-list \.app-agent-studio-agent-row\s*\{[^}]*padding-inline:\s*16px;[^}]*border-radius:\s*0;/s,
  );
});

test('Lib exposes independent Skill, Tool, and Plugin counts with stable selection', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({
      skills: [{ ...builtSkill, enabled: true }],
      selectedLibraryId: builtSkill.id,
      section: 'library',
      librarySection: 'skill',
      libraryArtifacts: {
        tool: [{ id: 'tool:read', kind: 'tool', name: 'read', description: '', status: 'Available', usedBy: [] }],
        plugin: [{ id: 'plugin:github', kind: 'plugin', name: 'github', description: '', status: 'Available', usedBy: [] }],
      },
    })} />,
  );

  assert.match(html, /repository-review/);
  assert.match(html, /Skills <span>1<\/span>/);
  assert.match(html, /Tools <span>1<\/span>/);
  assert.match(html, /Plugins <span>1<\/span>/);
  assert.match(html, /app-session-row-active/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /Enabled/);
  assert.match(html, /<strong>repository-review<\/strong><span class="app-agent-studio-agent-state">Enabled<\/span>/);
  assert.doesNotMatch(html, /app-agent-studio-draft-avatar/);
});

test('Factory rail keys search and scroll return context independently for each peer view', () => {
  const source = readFileSync(new URL('../src/kordi-app/agents/AgentStudioRail.tsx', import.meta.url), 'utf8');

  assert.match(source, /const \[queries, setQueries\] = useState<Record<string, string>>\(\{\}\);/);
  assert.match(source, /const viewKey = section === 'library' \? `\$\{section\}:\$\{librarySection\}:\$\{libraryCommunity \? 'community' : 'installed'\}` : section;/);
  assert.match(source, /setQueries\(\(current\) => \(\{ \.\.\.current, \[viewKey\]: event\.currentTarget\.value \}\)\)/);
  assert.equal(source.match(/scrollPositionsRef\.current\[viewKey\]/g)?.length, 2);
});

test('Community discovery owns its search pane without duplicating the installed-skill search', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail {...railProps({
      skills: [builtSkill],
      section: 'library',
      librarySection: 'skill',
      libraryCommunity: true,
    })} />,
  );

  assert.match(html, /Community skills/);
  assert.doesNotMatch(html, /Search trusted catalogs/);
  assert.doesNotMatch(html, /Search skills/);
  assert.doesNotMatch(html, /repository-review/);
});

test('Skill Library keeps install state and explicit add-to-agent action visible', () => {
  const agentTargets = [
    agent(),
    agent({ id: 'agent:reviewer', name: 'Review Agent', role: 'Repository reviewer', loadedSkills: ['adapt'] }),
  ];
  const html = renderToStaticMarkup(
    <SkillLibraryView
      skills={[externalUiSkill]}
      selectedSkillId={externalUiSkill.id}
      loading={false}
      error={null}
      mutatingSkillId={null}
      agentTargets={agentTargets}
      onSelectSkill={() => undefined}
      onRefresh={async () => [externalUiSkill]}
      onSetEnabled={async () => externalUiSkill}
      onRemove={async () => true}
      onInstalled={() => undefined}
      onAddToAgent={() => undefined}
    />,
  );

  assert.match(html, /Skill Library/);
  assert.match(html, /My skills/);
  assert.match(html, /Community/);
  assert.match(html, /adapt/);
  assert.match(html, /Category/);
  assert.match(html, />UI</);
  assert.match(html, /Installed from/);
  assert.match(html, /Local library/);
  assert.match(html, /Version/);
  assert.match(html, />—</);
  assert.doesNotMatch(html, /<dt>Source<\/dt>|<dt>Scope<\/dt>|<dt>Files<\/dt>|Settings:External/);
  assert.match(html, /Disabled/);
  assert.match(html, /Add to agent/);
  assert.match(html, /Choose an agent/);
  assert.match(html, /Kordi/);
  assert.match(html, /Review Agent/);
  assert.match(html, /Repository reviewer/);
  assert.match(html, /Added/);
  assert.doesNotMatch(html, /Add to current build/);
  assert.match(html, /Remove/);
});

test('Add to agent exposes each target and forwards the selected agent id', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let selectedAgentId: string | null = null;

  try {
    await act(async () => root?.render(
      <AddToAgentControl
        skill={externalUiSkill}
        content="# Adapt"
        agentTargets={[agent(), agent({ id: 'agent:writer', name: 'Writing Agent', role: 'Writing assistant' })]}
        onAddToAgent={async (agentId) => { selectedAgentId = agentId; }}
      />,
    ));

    const writingAgent = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Writing Agent'));
    assert.ok(writingAgent);
    await act(async () => writingAgent.click());
    assert.equal(selectedAgentId, 'agent:writer');
    assert.equal(host.querySelector('summary')?.textContent?.trim(), 'Add to agent');
    assert.equal(host.querySelector('details')?.hasAttribute('open'), false);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('Add to agent dismisses when the user clicks outside the picker', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(host, outside);
  let root: Root | null = createRoot(host);

  try {
    await act(async () => root?.render(
      <AddToAgentControl
        skill={externalUiSkill}
        content="# Adapt"
        agentTargets={[agent()]}
        onAddToAgent={() => undefined}
      />,
    ));

    const details = host.querySelector<HTMLDetailsElement>('details');
    assert.ok(details);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new installed.dom.window.Event('toggle'));
    });
    assert.equal(details.open, true);

    await act(async () => {
      outside.dispatchEvent(new installed.dom.window.Event('pointerdown', { bubbles: true }));
    });
    assert.equal(details.open, false);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    outside.remove();
    host.remove();
    installed.restore();
  }
});
