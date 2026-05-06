import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DesktopChatToolSnapshot, Message, SessionArtifact } from '../src/kordi-app/types';
import { extractSessionArtifacts } from '../src/features/chat/artifacts';
import { ArtifactInspector } from '../src/pages/ArtifactInspector';

function toolSnapshot(overrides: Partial<DesktopChatToolSnapshot>): DesktopChatToolSnapshot {
  return {
    id: overrides.id ?? 'tool-1',
    name: overrides.name ?? 'write',
    status: overrides.status ?? 'done',
    arguments: overrides.arguments ?? '{}',
    liveOutput: overrides.liveOutput ?? '',
    resultText: overrides.resultText ?? null,
    detail: overrides.detail ?? null,
    artifactPath: overrides.artifactPath ?? null,
    toolLayer: overrides.toolLayer ?? null,
    isError: overrides.isError ?? false,
  };
}

test('session artifact extraction hides memory and source writes from the artifact list', () => {
  const messages: Message[] = [{
    role: 'owned-agent',
    sender: 'My Kordi',
    text: 'Updated a file',
    time: '12:00',
    turn: {
      id: 'turn-1',
      sessionId: 'session-123',
      prompt: 'write file',
      status: 'complete',
      message: '',
      assistantText: '',
      thinkingText: '',
      tools: [{
        id: 'tool-1',
        name: 'write',
        status: 'done',
        arguments: JSON.stringify({ path: 'src/generated.ts' }),
        liveOutput: '',
        resultText: 'wrote file',
        detail: null,
        isError: false,
      }],
      completed: true,
      succeeded: true,
    },
  }];
  const lessonArtifact: SessionArtifact = {
    id: 'lesson:conversation:session-123',
    path: '/tmp/kordi/artifacts/reflection-lessons/conversation/session-123.md',
    name: 'Session lessons',
    kind: 'document',
    summary: 'Pinned scoped reflection lesson artifact',
    timeLabel: 'Pinned',
    pinned: true,
  };

  const artifacts = extractSessionArtifacts(messages, null, [lessonArtifact]);

  assert.equal(artifacts.some((artifact) => artifact.id === lessonArtifact.id), false);
  assert.equal(artifacts.some((artifact) => artifact.path === 'src/generated.ts'), false);
});

test('extractSessionArtifacts keeps generated artifacts but hides package and skill files', () => {
  const messages: Message[] = [{
    role: 'owned-agent',
    sender: 'My Kordi',
    text: 'Created a project report and touched implementation files.',
    time: '12:30',
    turn: {
      id: 'turn-report',
      sessionId: 'session-123',
      prompt: 'Create a Kordi project structure report',
      status: 'complete',
      message: '',
      assistantText: '',
      thinkingText: '',
      completed: true,
      succeeded: true,
      tools: [
        toolSnapshot({
          id: 'report',
          name: 'write',
          arguments: JSON.stringify({ path: 'docs/reports/kordi-project-structure-report.md' }),
          resultText: 'wrote report',
        }),
        toolSnapshot({
          id: 'package',
          name: 'edit',
          arguments: JSON.stringify({ path: 'package.json' }),
          resultText: 'updated package metadata',
        }),
        toolSnapshot({
          id: 'skill',
          name: 'write',
          arguments: JSON.stringify({ path: 'app/desktop/docs/superpowers/skills/reviewer/SKILL.md' }),
          resultText: 'wrote skill notes',
        }),
        toolSnapshot({
          id: 'read-source',
          name: 'read',
          arguments: JSON.stringify({ path: 'app/desktop/src/pages/TaskActivityDashboardPanel.tsx' }),
          resultText: 'read source',
        }),
        toolSnapshot({
          id: 'source-report',
          name: 'write',
          arguments: JSON.stringify({ path: 'app/desktop/src/reports/report.ts' }),
          resultText: 'wrote implementation source',
        }),
        toolSnapshot({
          id: 'test-spec',
          name: 'write',
          arguments: JSON.stringify({ path: 'tests/generated-report.spec.ts' }),
          resultText: 'wrote test source',
        }),
        toolSnapshot({
          id: 'read-artifact-path',
          name: 'read',
          arguments: JSON.stringify({ path: 'docs/reports/kordi-project-structure-report.md' }),
          artifactPath: 'artifacts/read-output.txt',
          resultText: 'read report',
        }),
      ],
    },
  }];

  const artifacts = extractSessionArtifacts(messages);
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));

  assert.equal(byPath.get('docs/reports/kordi-project-structure-report.md')?.category, 'artifact');
  assert.equal(byPath.has('package.json'), false);
  assert.equal(byPath.has('app/desktop/docs/superpowers/skills/reviewer/SKILL.md'), false);
  assert.equal(byPath.has('app/desktop/src/pages/TaskActivityDashboardPanel.tsx'), false);
  assert.equal(byPath.has('app/desktop/src/reports/report.ts'), false);
  assert.equal(byPath.has('tests/generated-report.spec.ts'), false);
  assert.equal(byPath.has('artifacts/read-output.txt'), false);
});

test('artifact inspector only renders generated artifacts in the artifact list', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactInspector, {
    isNativeShell: false,
    activeArtifactId: null,
    onSelectArtifact: () => undefined,
    emptyMessage: 'No artifacts',
    artifacts: [
      {
        id: 'docs/reports/kordi-project-structure-report.md',
        path: 'docs/reports/kordi-project-structure-report.md',
        name: 'kordi-project-structure-report.md',
        kind: 'document',
        summary: 'Generated report',
        category: 'artifact',
      },
      {
        id: 'package.json',
        path: 'package.json',
        name: 'package.json',
        kind: 'code',
        summary: 'Related package metadata',
        category: 'related',
      },
      {
        id: 'lesson:conversation:session-123',
        path: '/tmp/kordi/artifacts/reflection-lessons/conversation/session-123.md',
        name: 'Session lessons',
        kind: 'document',
        summary: 'Scoped memory',
        category: 'memory',
        pinned: true,
      },
    ],
  }));

  assert.match(markup, /data-artifact-section="generated"/);
  assert.match(markup, /kordi-project-structure-report.md/);
  assert.doesNotMatch(markup, /data-artifact-section="related"/);
  assert.doesNotMatch(markup, /data-artifact-section="memory"/);
  assert.doesNotMatch(markup, /package\.json/);
  assert.doesNotMatch(markup, /Session lessons/);
});
