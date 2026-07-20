import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentStudioRail } from '../src/kordi-app/agents/AgentStudioRail';
import { SkillLibraryView } from '../src/kordi-app/agents/SkillLibraryView';
import type { DesktopSkillLibraryEntry } from '../src/lib/desktop';

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

test('Factory plus menu offers separate real agent and skill builds', () => {
  const html = renderToStaticMarkup(
    <AgentStudioRail
      agents={[]}
      activeAgentId=""
      creatingKind={null}
      agentConfigs={{}}
      skills={[builtSkill]}
      selectedSkillId={null}
      section="builds"
      canCreateAgent
      onSectionChange={() => undefined}
      onOpenAgent={() => undefined}
      onOpenSkill={() => undefined}
      onCreateArtifact={() => undefined}
    />,
  );

  assert.match(html, /Build agent/);
  assert.match(html, /Build skill/);
  assert.match(html, /Skills <span>1<\/span>/);
  assert.match(html, /Search factory projects/);
});

test('Skill Library keeps install state and explicit add-to-build action visible', () => {
  const html = renderToStaticMarkup(
    <SkillLibraryView
      skills={[builtSkill]}
      selectedSkillId={builtSkill.id}
      loading={false}
      error={null}
      mutatingSkillId={null}
      canAddToBuild
      onSelectSkill={() => undefined}
      onRefresh={async () => [builtSkill]}
      onSetEnabled={async () => builtSkill}
      onRemove={async () => true}
      onInstalled={() => undefined}
      onAddToBuild={() => undefined}
    />,
  );

  assert.match(html, /Skill Library/);
  assert.match(html, /My skills/);
  assert.match(html, /Community/);
  assert.match(html, /repository-review/);
  assert.match(html, /Disabled/);
  assert.match(html, /Add to current build/);
  assert.match(html, /Remove/);
});
