import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentInspectionView } from '../src/kordi-app/agents/AgentInspectionView';
import { AgentStudioWorkspace } from '../src/kordi-app/agents/AgentStudioWorkspace';
import { CapabilityLibraryView } from '../src/kordi-app/agents/CapabilityLibraryView';
import {
  CLOUD_AGENT_TOOL_DESCRIPTIONS,
  factoryAgentCreateInput,
  newArtifactSeed,
  readyFactoryBuildForPublish,
} from '../src/kordi-app/agents/factoryAgentUtils';
import {
  createFactoryBuildTargetKey,
  factoryArtifactIdentityFromTarget,
  factoryArtifactTargetKey,
  factoryBuildIdentityFromTarget,
  publishableLocalAgentConfigChanges,
  type FactoryLibraryArtifact,
} from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';
import { randomFactoryCreationAvatar } from '../src/kordi-app/agents/useFactoryCreationAvatar';
import type { DesktopAgentBuilderStatus, DesktopSkillLibraryEntry } from '../src/lib/desktop';
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

const creationBuilderStatus: DesktopAgentBuilderStatus = {
  draftId: 'draft-1',
  targetKey: 'account:one:create:agent:build-1',
  sessionId: 'session:agent-builder:draft-1',
  workspacePath: '/tmp/factory/draft-1',
  lifecycle: 'draft',
  draft: {
    name: 'Research Agent',
    role: 'Source-backed research',
    description: 'Research current topics with citations.',
    systemPrompt: 'Cite the source used for every claim.',
    sourceSummary: '',
    boundaries: [],
    access: 'only-me',
    provider: 'openai-codex',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    tools: ['web_search', 'web_fetch'],
    plugins: [],
    skills: [],
  },
  validation: { valid: true, fingerprint: 'fingerprint-1', errors: [], files: [] },
  testReport: null,
  publishReady: false,
};

test('new agent builds inherit the active configured route and expose Cloud tools', () => {
  const seed = newArtifactSeed('agent', {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai-codex',
    authChoice: 'oauth-profile',
    thinking: 'high',
  });

  assert.equal(seed.provider, 'openai-codex');
  assert.equal(seed.model, 'openai/gpt-5.6-sol');
  assert.equal(seed.thinking, 'high');
  assert.deepEqual(
    Object.keys(CLOUD_AGENT_TOOL_DESCRIPTIONS).filter((name) => name.startsWith('web_')),
    ['web_fetch', 'web_search'],
  );
});

test('new agent creation sends its avatar through the canonical Cloud mutation', () => {
  const input = factoryAgentCreateInput({
    draft: {
      name: 'Research Agent', role: 'Research', description: '', systemPrompt: 'Research.',
      sourceSummary: '', boundaries: [], skills: [],
    },
    runtime: creationBuilderStatus.draft,
    accessScope: 'private',
    avatarMutation: { action: 'upload', uploadedAsset: 'data:image/png;base64,avatar' },
  });
  assert.deepEqual(input.avatarMutation, { action: 'upload', uploadedAsset: 'data:image/png;base64,avatar' });

  const random = randomFactoryCreationAvatar();
  assert.equal(random?.mutation.action, 'regenerate');
  assert.match(random?.imageUrl ?? '', /\/v1\/avatars\/preview\/thumbs\//);
  assert.match(random?.mutation.seed ?? '', /^[A-Za-z0-9_-]+$/);
});

test('publishing tests an untested draft once and continues only when it passes', async () => {
  const shellSource = readFileSync(new URL('../src/app/assembleMainContentSlot.tsx', import.meta.url), 'utf8');
  let tests = 0;
  const tested = { ...creationBuilderStatus, publishReady: true };
  assert.equal(await readyFactoryBuildForPublish(creationBuilderStatus, async () => {
    tests += 1;
    return tested;
  }), tested);
  assert.equal(tests, 1);
  assert.equal(await readyFactoryBuildForPublish(tested, async () => {
    throw new Error('already tested');
  }), tested);
  await assert.rejects(
    () => readyFactoryBuildForPublish(creationBuilderStatus, async () => null),
    /agent test did not pass/i,
  );
  assert.match(shellSource, /setDesktopSkillLibraryEnabled\(skill, enabled\)/);
  assert.match(shellSource, /await renameDesktopAgent\(name\);[\s\S]*await args\.refreshDesktopChat\(\)/);
  assert.doesNotMatch(shellSource, /runDesktopChatSkillCommand/);
});

test('local Kordi publication ignores stale file-only changes without blocking identity updates', () => {
  const changes = [
    { key: 'prompt' as const, label: 'System prompt updated', detail: 'prompt' },
    { key: 'skills' as const, label: 'Skill selection updated', detail: '24 loaded' },
  ];
  assert.deepEqual(
    publishableLocalAgentConfigChanges(changes, false, true),
    [changes[1]],
  );
});

test('new agent Blueprint exposes avatar and model setup behind one publish action', () => {
  const html = renderToStaticMarkup(
    <AgentStudioWorkspace
      creating
      artifactKind="agent"
      creationDraft={{
        name: 'Research Agent',
        role: 'Source-backed research',
        description: 'Research current topics with citations.',
        systemPrompt: 'Cite the source used for every claim.',
        sourceSummary: '',
        boundaries: [],
        skills: [],
      }}
      creationAccessScope="private"
      agentAccessScope="private"
      onCreationAccessScopeChange={() => undefined}
      config={null}
      persisted={null}
      changes={[]}
      availableSkills={[]}
      skillDescriptions={{}}
      availableTools={Object.keys(CLOUD_AGENT_TOOL_DESCRIPTIONS)}
      availablePlugins={[]}
      editableCapabilityKinds={new Set(['skill', 'tool', 'plugin'])}
      allowCapabilityCreation
      canEditPrompt
      onPromptChange={() => undefined}
      onCreationDraftChange={() => undefined}
      creationAvatarUrl="data:image/png;base64,avatar"
      onCreationAvatarUpload={() => undefined}
      onCreationAvatarRandomize={() => undefined}
      onCreationModelRoutingChange={() => undefined}
      onToggleCapability={() => undefined}
      onAddCapability={() => undefined}
      onRenameCapability={() => undefined}
      onPublish={() => undefined}
      onDiscard={() => undefined}
      publishing={false}
      publishFeedback={null}
      publishDisabled={false}
      draftMutationDisabled={false}
      chatModelOptions={[{
        value: 'openai/gpt-5.6-sol',
        label: 'gpt-5.6-sol',
        provider: 'openai',
        providerLabel: 'OpenAI',
        thinkingLevels: ['high'],
      }]}
      composerProviderOptions={[]}
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
      builderStatus={creationBuilderStatus}
      builderTesting={false}
      onTestBuilderDraft={() => undefined}
    />,
  );

  assert.match(html, /aria-label="Upload agent avatar"/);
  assert.match(html, /aria-label="Generate random agent avatar"/);
  assert.match(html, /data-cloud-signup-avatar-upload="true"/);
  assert.match(html, /data-cloud-signup-avatar-reroll="true"/);
  assert.match(html, /lucide-dice-5/);
  assert.match(html, /lucide-camera/);
  assert.ok(html.indexOf('data-cloud-signup-avatar-reroll') < html.indexOf('data-cloud-signup-avatar-upload'));
  assert.match(html, /flex h-12 w-7 shrink-0 flex-col overflow-hidden rounded-full/);
  assert.doesNotMatch(html, /Upload a PNG, JPEG, or WebP image/);
  assert.match(html, /aria-label="Edit model"/);
  assert.match(html, />Publish agent<\/button>/);
  assert.doesNotMatch(html, />Test agent<\/button>/);
  assert.doesNotMatch(html, /disabled="">Publish agent<\/button>/);
});

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
  assert.doesNotMatch(html, /This page shows the published agent|private Build conversation/);
  assert.match(html, /Edit in Build/);
  assert.match(html, /Change in Build/);
  assert.match(html, /Manage in Build/);
  assert.match(html, /Cite the source used for every claim/);
  assert.doesNotMatch(html, /Published files|No published/);
  assert.doesNotMatch(html, /textarea|contenteditable/);
  assert.equal(edits, 0);
});

test('the collaboration-backed default Kordi exposes identity controls in Build', () => {
  const localAgent = {
    ...agent,
    id: 'cloud-local-agent',
    cloudAgentId: undefined,
    isOwned: true,
    isCollaborationDefault: true,
  };
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
      changes={[]}
      availableSkills={[]}
      skillDescriptions={{}}
      availableTools={[]}
      availablePlugins={[]}
      editableCapabilityKinds={new Set()}
      allowCapabilityCreation={false}
      canEditPrompt={false}
      onPromptChange={() => undefined}
      onNameChange={() => undefined}
      onCreationDraftChange={() => undefined}
      creationAvatarUrl="data:image/png;base64,avatar"
      onCreationAvatarUpload={() => undefined}
      onCreationAvatarRandomize={() => undefined}
      onToggleCapability={() => undefined}
      onAddCapability={() => undefined}
      onRenameCapability={() => undefined}
      onPublish={() => undefined}
      onDiscard={() => undefined}
      publishing={false}
      publishFeedback={null}
      publishDisabled
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
      builderStatus={creationBuilderStatus}
    />,
  );

  assert.match(html, /Only me/);
  assert.match(html, /aria-label="Edit name"/);
  assert.match(html, /aria-label="Upload agent avatar"/);
  assert.match(html, /aria-label="Generate random agent avatar"/);
  assert.ok(html.indexOf('>Name<') < html.indexOf('>Avatar<'));
  assert.ok(html.indexOf('>Avatar<') < html.indexOf('>Prompt<'));
  assert.match(html, /aria-label="Edit access"/);
  assert.doesNotMatch(html, /Local runtime/);
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
