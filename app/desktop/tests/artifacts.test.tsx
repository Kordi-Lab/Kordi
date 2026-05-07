import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DesktopChatToolSnapshot, Message, SessionArtifact } from '../src/kordi-app/types';
import { extractSessionArtifacts } from '../src/features/chat/artifacts';
import { MarkdownCodeBlock, MarkdownContent } from '../src/kordi-app/components';
import { ArtifactInspector, ArtifactPreviewWindow, renderArtifactPreview } from '../src/pages/ArtifactInspector';

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

test('session artifact extraction hides memory but keeps local source writes as related files', () => {
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
  assert.equal(artifacts.find((artifact) => artifact.path === 'src/generated.ts')?.category, 'related');
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
  assert.equal(byPath.get('app/desktop/src/reports/report.ts')?.category, 'related');
  assert.equal(byPath.get('tests/generated-report.spec.ts')?.category, 'related');
  assert.equal(byPath.has('artifacts/read-output.txt'), false);
});

test('artifact inspector renders generated artifacts like files without full paths', () => {
  const absolutePath = '/Users/shuyang/.config/superpowers/worktrees/kordi/issue-282-tui-tool-previews/.superpowers/brainstorm/53234-1778054524/content/website-directions.html';
  const markup = renderToStaticMarkup(createElement(ArtifactInspector, {
    isNativeShell: false,
    activeArtifactId: null,
    onSelectArtifact: () => undefined,
    emptyMessage: 'No artifacts',
    artifacts: [
      {
        id: absolutePath,
        path: absolutePath,
        name: 'website-directions.html',
        kind: 'code',
        summary: 'Created artifact with write',
        category: 'artifact',
        timeLabel: '11:02',
      },
    ],
  }));

  assert.match(markup, /data-artifact-file-row="true"/);
  assert.match(markup, /website-directions\.html/);
  assert.match(markup, /content/);
  assert.doesNotMatch(markup, /\/Users\/shuyang/);
  assert.doesNotMatch(markup, /worktrees\/kordi/);
  assert.doesNotMatch(markup, /\.superpowers\/brainstorm\/53234-1778054524\/content\/website-directions\.html/);
});

test('artifact preview renders html and markdown as previewable documents', () => {
  const htmlMarkup = renderToStaticMarkup(createElement('div', null, renderArtifactPreview({
    path: 'content/website-directions.html',
    lines: [{ number: 1, text: '<h1>Kordi Website</h1>' }, { number: 2, text: '<p>Choose a direction.</p>' }],
    truncated: false,
  })));
  const markdownMarkup = renderToStaticMarkup(createElement('div', null, renderArtifactPreview({
    path: 'docs/reports/kordi-project-structure-report.md',
    lines: [{ number: 1, text: '# Kordi Project Structure Report' }, { number: 2, text: 'Generated summary.' }],
    truncated: false,
  })));

  assert.match(htmlMarkup, /<iframe/);
  assert.match(htmlMarkup, /sandbox=/);
  assert.doesNotMatch(htmlMarkup, />Copy</);
  assert.match(markdownMarkup, /Kordi Project Structure Report/);
  assert.doesNotMatch(markdownMarkup, /# Kordi Project Structure Report/);
  assert.doesNotMatch(markdownMarkup, />Copy</);
});

test('artifact inspector renders generated artifacts and related changed files, but hides memory', () => {
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
        timeLabel: '11:19',
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
  assert.match(markup, /data-artifact-section="related"/);
  assert.match(markup, /package\.json/);
  assert.match(markup, /11:19/);
  assert.doesNotMatch(markup, />Name</);
  assert.doesNotMatch(markup, />Modified</);
  assert.doesNotMatch(markup, /Local files changed by assistant turns/);
  assert.doesNotMatch(markup, /Remote-only group files/);
  assert.doesNotMatch(markup, /data-artifact-section="memory"/);
  assert.doesNotMatch(markup, /Session lessons/);
});

test('artifact preview renders csv tables, formatted json, svg, and mermaid files with specialized surfaces', () => {
  const csvMarkup = renderToStaticMarkup(createElement('div', null, renderArtifactPreview({
    path: 'reports/summary.csv',
    lines: [
      { number: 1, text: 'Name,Status' },
      { number: 2, text: 'Kordi,Ready' },
    ],
    truncated: false,
  })));
  const jsonMarkup = renderToStaticMarkup(createElement('div', null, renderArtifactPreview({
    path: 'data/config.json',
    lines: [{ number: 1, text: '{"name":"Kordi","enabled":true}' }],
    truncated: false,
  })));
  const svgMarkup = renderToStaticMarkup(createElement('div', null, renderArtifactPreview({
    path: 'artifacts/diagram.svg',
    lines: [{ number: 1, text: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>' }],
    truncated: false,
  })));
  const mermaidMarkup = renderToStaticMarkup(createElement('div', null, renderArtifactPreview({
    path: 'docs/flow.mmd',
    lines: [{ number: 1, text: 'graph TD' }, { number: 2, text: 'A-->B' }],
    truncated: false,
  })));

  assert.match(csvMarkup, /<table/);
  assert.match(csvMarkup, /Kordi/);
  assert.match(jsonMarkup, /&quot;enabled&quot;/);
  assert.match(jsonMarkup, /true/);
  assert.match(svgMarkup, /<iframe/);
  assert.match(svgMarkup, /diagram\.svg preview/);
  assert.match(mermaidMarkup, /data-mermaid-diagram="true"/);
  assert.match(mermaidMarkup, /Mermaid diagram/);
});

test('markdown code blocks highlight additional file types and render mermaid diagrams', () => {
  const cssMarkup = renderToStaticMarkup(createElement(MarkdownCodeBlock, {
    language: 'css',
    code: '.card { color: oklch(70% 0.12 240); }',
  }));
  const pythonMarkup = renderToStaticMarkup(createElement(MarkdownCodeBlock, {
    language: 'python',
    code: 'def render():\n    return True',
  }));
  const mermaidMarkdown = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '```mermaid\ngraph TD\nA-->B\n```',
  }));

  assert.match(cssMarkup, /text-amber-200/);
  assert.match(cssMarkup, /oklch/);
  assert.match(pythonMarkup, /text-violet-200/);
  assert.match(pythonMarkup, /def/);
  assert.match(mermaidMarkdown, /data-mermaid-diagram="true"/);
  assert.match(mermaidMarkdown, /Mermaid diagram preview/);
  assert.match(mermaidMarkdown, />A</);
  assert.match(mermaidMarkdown, />B</);
});

test('artifact inspector gives the selected preview the flexible right-panel space', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactInspector, {
    isNativeShell: false,
    activeArtifactId: 'docs/flow.md',
    onSelectArtifact: () => undefined,
    emptyMessage: 'No artifacts',
    artifacts: [
      {
        id: 'docs/flow.md',
        path: 'docs/flow.md',
        name: 'flow.md',
        kind: 'document',
        summary: 'Related file from write',
        category: 'related',
      },
    ],
  }));

  assert.match(markup, /data-artifact-inspector="true"/);
  assert.match(markup, /data-artifact-file-list="true"/);
  assert.match(markup, /data-artifact-preview-section="true"/);
  assert.match(markup, /flex-1/);
  assert.match(markup, /min-h-0/);
});

test('artifact preview window uses full-height preview rendering', () => {
  const preview = {
    path: 'tmp_test_task_mermaid.md',
    lines: [
      { number: 1, text: '```mermaid' },
      { number: 2, text: 'graph TD' },
      { number: 3, text: 'A-->B' },
      { number: 4, text: '```' },
    ],
    truncated: false,
  };
  const markup = renderToStaticMarkup(createElement(ArtifactPreviewWindow, {
    preview,
    title: 'tmp_test_task_mermaid.md',
    kindLabel: 'Markdown',
    onClose: () => undefined,
  }));

  assert.match(markup, /data-artifact-preview-mode="window"/);
  assert.match(markup, /min-h-full/);
  assert.doesNotMatch(markup, /max-h-\[32rem\] overflow-auto px-4 py-4/);
  assert.match(markup, /data-mermaid-diagram="true"/);
});

test('artifact preview exposes a larger preview window surface', () => {
  const preview = {
    path: 'tmp_test_task.py',
    lines: [
      { number: 1, text: '#!/usr/bin/env python3' },
      { number: 2, text: 'print("Hello from preview")' },
    ],
    truncated: false,
  };
  const markup = renderToStaticMarkup(createElement(ArtifactPreviewWindow, {
    preview,
    title: 'tmp_test_task.py',
    kindLabel: 'Source',
    onClose: () => undefined,
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /Preview window/);
  assert.match(markup, /tmp_test_task.py/);
  assert.match(markup, /Hello from preview/);
  assert.match(markup, /aria-label="Close preview window"/);
});
