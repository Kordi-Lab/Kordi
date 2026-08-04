import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentInspectionView } from '../src/kordi-app/agents/AgentInspectionView';
import { CapabilityLibraryView } from '../src/kordi-app/agents/CapabilityLibraryView';
import {
  createFactoryBuildTargetKey,
  factoryArtifactIdentityFromTarget,
  factoryArtifactTargetKey,
  factoryBuildIdentityFromTarget,
  type FactoryLibraryArtifact,
} from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

const agent: Agent = {
  id: 'cloud:agent/alpha',
  name: 'Research Agent',
  role: 'Source-backed research',
  messaging: 'Cloud runtime',
  status: 'Active',
  tasks: 2,
  defaultProvider: 'OpenAI',
  defaultModel: 'gpt-test',
  collaborationConfig: 'Cloud',
  contactId: 'research-agent',
  systemPrompt: 'Cite the source used for every claim.',
  xMd: '',
  identityFiles: ['AGENTS.md'],
  loadedTools: ['web_search'],
  loadedSkills: ['research'],
  loadedPlugins: ['github'],
  lastActivities: [],
  isOwned: true,
};

test('artifact targets round-trip exact identity without relying on list order', () => {
  for (const kind of ['agent', 'skill', 'tool', 'plugin'] as const) {
    const artifactId = `${kind}/alpha:β`;
    const target = factoryArtifactTargetKey('account/one', kind, artifactId);
    assert.deepEqual(factoryArtifactIdentityFromTarget(target), { kind, id: artifactId });
    assert.deepEqual(factoryBuildIdentityFromTarget(target), { kind, artifactId });
  }
  assert.deepEqual(
    factoryBuildIdentityFromTarget('device:agent:agent:kordi'),
    { kind: 'agent', artifactId: 'agent:kordi' },
  );

  const creation = createFactoryBuildTargetKey('account/one', 'plugin', 'build/unique');
  assert.deepEqual(factoryBuildIdentityFromTarget(creation), { kind: 'plugin', artifactId: null });
  assert.notEqual(creation, createFactoryBuildTargetKey('account/one', 'plugin', 'build/other'));
});

test('Agent inspection exposes published configuration and routes every change to Build', () => {
  let edits = 0;
  const html = renderToStaticMarkup(<AgentInspectionView agent={agent} onEditInBuild={() => { edits += 1; }} />);
  assert.match(html, /This page shows the published agent/);
  assert.match(html, /Edit in Build/);
  assert.match(html, /Change in Build/);
  assert.match(html, /Manage in Build/);
  assert.match(html, /Cite the source used for every claim/);
  assert.doesNotMatch(html, /textarea|contenteditable/);
  assert.equal(edits, 0);
});

test('Tool and Plugin inspection remain read-only and expose exact Build routing', () => {
  for (const kind of ['tool', 'plugin'] as const) {
    const artifact: FactoryLibraryArtifact = {
      id: `${kind}:source-review`,
      kind,
      name: 'source-review',
      description: 'Review source quality.',
      status: 'Published',
      usedBy: ['Research Agent'],
    };
    const html = renderToStaticMarkup(<CapabilityLibraryView kind={kind} artifact={artifact} onEditInBuild={() => undefined} />);
    assert.match(html, /Edit in Build/);
    assert.match(html, /published (tool|plugin)/i);
    assert.doesNotMatch(html, /textarea|Save file|Remove|Enable|Disable/);
  }
});

test('compact Factory layout stacks conversation and workspace without hiding either', () => {
  const css = readDesktopShellCss();
  const compactRule = css.match(/@container agents-page \(max-width: 1120px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(compactRule, /\.app-agent-studio-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.doesNotMatch(compactRule, /data-compact-pane[^}]*display:\s*none/);

  const pageSource = readFileSync(new URL('../src/kordi-app/agents/AgentsPage.tsx', import.meta.url), 'utf8');
  assert.match(pageSource, /Factory \/ Build \/ \{builder\.status\?\.sessionId/);
  assert.match(pageSource, /Build session unavailable/);
  assert.match(pageSource, /Recover from published/);
});
