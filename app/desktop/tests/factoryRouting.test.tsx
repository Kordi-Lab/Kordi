import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentInspectionView } from '../src/kordi-app/agents/AgentInspectionView';
import { AgentStudioWorkspace } from '../src/kordi-app/agents/AgentStudioWorkspace';
import { CapabilityLibraryView } from '../src/kordi-app/agents/CapabilityLibraryView';
import {
  agentBuilderSeedForAgent,
  agentDraftCanPublish,
  agentDraftRequiresRuntimeTest,
} from '../src/kordi-app/agents/factoryAgentUtils';
import {
  createFactoryBuildTargetKey,
  factoryArtifactIdentityFromTarget,
  factoryArtifactTargetKey,
  factoryBuildIdentityFromTarget,
  type FactoryLibraryArtifact,
} from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';
import type { DesktopSkillLibraryEntry } from '../src/lib/desktop';
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

test('policy-only agent drafts can publish without a model run', () => {
  const validUntestedStatus = {
    draftId: 'draft-policy',
    targetKey: 'account:user-1:agent:agent-1',
    sessionId: 'session:agent-builder:policy',
    workspacePath: '/tmp/draft-policy',
    lifecycle: 'draft',
    validation: { valid: true, fingerprint: 'policy-fingerprint', errors: [], files: [] },
    testReport: null,
    publishReady: false,
  };

  const policyChanges = [{ key: 'access' }, { key: 'proactive' }, { key: 'mentions' }];
  assert.equal(agentDraftRequiresRuntimeTest(policyChanges), false);
  assert.equal(agentDraftCanPublish(validUntestedStatus, policyChanges), true);
  assert.equal(agentDraftRequiresRuntimeTest([{ key: 'definition' }]), true);
  assert.equal(agentDraftCanPublish(validUntestedStatus, [{ key: 'definition' }]), false);
  assert.equal(agentDraftCanPublish({
    ...validUntestedStatus,
    validation: { ...validUntestedStatus.validation, valid: false, errors: ['Invalid draft'] },
  }, policyChanges), false);
});

test('local agent description comparisons use the same value that seeds the builder', () => {
  const localAgent = {
    ...agent,
    id: 'desktop:local-agent',
    role: 'My local Kordi',
    cloudAgentDescription: undefined,
    cloudAgentSourceSummary: undefined,
  };
  assert.equal(agentBuilderSeedForAgent(localAgent).description, 'My local Kordi');
});

test('Agent inspection exposes published configuration and routes every change to Build', () => {
  let edits = 0;
  const html = renderToStaticMarkup(<AgentInspectionView agent={agent} onEditInBuild={() => { edits += 1; }} />);
  assert.doesNotMatch(html, /This page shows the published agent|private Build conversation/);
  assert.match(html, /Edit in Build/);
  assert.match(html, /Change in Build/);
  assert.match(html, /Manage in Build/);
  assert.match(html, /Cite the source used for every claim/);
  assert.doesNotMatch(html, /Published files|No published/);
  assert.doesNotMatch(html, /textarea|contenteditable/);
  assert.equal(edits, 0);
});

test('My Kordi and every owned agent expose collaboration policy controls in Build', () => {
  const localAgent = { ...agent, id: 'desktop:local-agent', messaging: 'Local runtime' };
  const html = renderToStaticMarkup(
    <AgentStudioWorkspace
      agent={localAgent}
      creating={false}
      artifactKind="agent"
      creationDraft={null}
      creationAccessScope="private"
      agentAccessScope="private"
      onCreationAccessScopeChange={() => undefined}
      config={{ systemPrompt: localAgent.systemPrompt, loadedSkills: [], loadedTools: [], loadedPlugins: [] }}
      persisted={{ systemPrompt: localAgent.systemPrompt, loadedSkills: [], loadedTools: [], loadedPlugins: [], editHistory: [] }}
      changes={[{ key: 'proactive', label: 'Proactive collaboration updated', detail: 'On' }]}
      availableSkills={[]}
      skillDescriptions={{}}
      availableTools={[]}
      availablePlugins={[]}
      editableCapabilityKinds={new Set()}
      allowCapabilityCreation={false}
      canEditPrompt={false}
      onPromptChange={() => undefined}
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
      onUpdateAgentAccess={() => undefined}
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
      builderStatus={{
        draftId: 'draft-policy',
        targetKey: 'account:user-1:agent:agent-1',
        sessionId: 'session:agent-builder:policy',
        workspacePath: '/tmp/draft-policy',
        lifecycle: 'draft',
        validation: { valid: true, fingerprint: 'policy-fingerprint', errors: [], files: [] },
        testReport: null,
        publishReady: false,
      }}
    />,
  );

  assert.match(html, /Only me/);
  assert.match(html, /aria-label="Edit access"/);
  assert.match(html, /Proactive/);
  assert.match(html, /Enabling proactive also shares this agent with people in its chats/);
  const proactiveSwitch = html.slice(html.indexOf('aria-label="Proactive collaboration"'), html.indexOf('aria-label="Proactive collaboration"') + 320);
  assert.doesNotMatch(proactiveSwitch, /disabled/);
  assert.match(html, /@mention permissions/);
  assert.match(html, /aria-label="Allow @mentions of people"/);
  assert.match(html, /aria-label="Allow @mentions of agents"/);
  assert.match(html, /These policy settings are ready to publish/);
  assert.doesNotMatch(html, /Open Runs/);
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
    assert.doesNotMatch(html, /Published (tool|plugin)|Published definition|private Build|Read only/i);
    assert.doesNotMatch(html, /textarea|Save file|Remove|Enable|Disable/);
  }
});

test('Skill Library uses a balanced three-pane inspection layout and keeps Community discovery available', () => {
  const skill: DesktopSkillLibraryEntry = {
    id: 'skill:research',
    name: 'research',
    description: 'Research with source-backed evidence.',
    sourceLabel: 'Settings:External',
    sourcePath: '/tmp/research/SKILL.md',
    scope: 'shared',
    origin: 'external',
    enabled: true,
    editable: false,
    removable: false,
    version: '1.0.0',
    provider: null,
    owner: null,
    sourceUrl: null,
    digest: null,
    fileCount: 2,
  };
  const artifact: FactoryLibraryArtifact = {
    id: skill.id,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    status: 'Enabled',
    usedBy: ['Research Agent'],
  };
  const installedHtml = renderToStaticMarkup(
    <CapabilityLibraryView
      kind="skill"
      artifact={artifact}
      skill={skill}
      installedSkills={[skill]}
      onEditInBuild={() => undefined}
    />,
  );
  const communityHtml = renderToStaticMarkup(
    <CapabilityLibraryView
      kind="skill"
      artifact={artifact}
      skill={skill}
      skillMode="community"
      installedSkills={[skill]}
      onEditInBuild={() => undefined}
    />,
  );
  const css = readDesktopShellCss();

  assert.match(installedHtml, /app-factory-library-overview/);
  assert.match(installedHtml, /app-factory-library-preview/);
  assert.match(installedHtml, /My skills <span>1<\/span>/);
  assert.match(installedHtml, /Local library/);
  assert.doesNotMatch(installedHtml, /Settings:External/);
  assert.doesNotMatch(installedHtml, /File preview|Published files|Read only/);
  assert.doesNotMatch(communityHtml, /Community catalog/);
  assert.match(communityHtml, /Search ClawHub/);
  assert.match(communityHtml, /Inspect before installing/);
  assert.match(
    css,
    /\.app-factory-library-detail\s*\{[^}]*grid-template-columns:\s*minmax\(280px, 0\.72fr\) minmax\(420px, 1\.28fr\);/s,
  );
  assert.match(
    css,
    /\.app-factory-library-switch\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s,
  );
});

test('compact Factory layout stacks conversation and workspace without hiding either', () => {
  const css = readDesktopShellCss();
  const compactRule = css.match(/@container agents-page \(max-width: 1120px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(compactRule, /\.app-agent-studio-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.doesNotMatch(compactRule, /data-compact-pane[^}]*display:\s*none/);

  const pageSource = readFileSync(new URL('../src/kordi-app/agents/AgentsPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(pageSource, /Factory \/ Build \/ \{builder\.status\?\.sessionId/);
  assert.match(pageSource, /Build session unavailable/);
  assert.match(pageSource, /Recover from published/);
});

test('Factory page headers share the Build title hierarchy', () => {
  const css = readDesktopShellCss();

  assert.match(css, /--agent-studio-type-caption:\s*0\.6875rem;/);
  assert.match(css, /--agent-studio-type-body:\s*0\.8125rem;/);
  assert.match(css, /--agent-studio-type-subheading:\s*0\.8125rem;/);
  assert.match(
    css,
    /\.app-agent-studio-header h2\s*\{[^}]*font-size:\s*var\(--agent-studio-type-body\);[^}]*font-weight:\s*600;/s,
  );
  assert.match(
    css,
    /\.app-agent-studio-header p\s*\{[^}]*font-size:\s*var\(--agent-studio-type-caption\);/s,
  );
  assert.match(
    css,
    /\.app-factory-build-context strong\s*\{[^}]*font-size:\s*var\(--agent-studio-type-body\);[^}]*font-weight:\s*600;/s,
  );
});
