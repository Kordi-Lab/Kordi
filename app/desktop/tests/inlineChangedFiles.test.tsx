import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { changedFileRowsFromTurn, extractSessionArtifacts } from '../src/features/chat/artifacts';
import { openInlineChangedFile } from '../src/kordi-app/components/transcript';
import { LiveChatTurnCard, MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

function turnWithTools(tools: DesktopChatTurnSnapshot['tools'], overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-inline-files',
    sessionId: 'session-1',
    prompt: 'make the change',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Done.',
    thinkingText: '',
    tools,
    completed: true,
    succeeded: true,
    error: null,
    ...overrides,
  };
}

test('changedFileRowsFromTurn returns new and modified local files with diff stats', () => {
  const turn = turnWithTools([
    {
      id: 'tool-write',
      name: 'write',
      status: 'done',
      arguments: JSON.stringify({ path: 'app/desktop/tests/inlineChangedFiles.test.tsx' }),
      liveOutput: '',
      resultText: 'created file\n+first line\n+second line',
      isError: false,
    },
    {
      id: 'tool-edit',
      name: 'edit',
      status: 'done',
      arguments: JSON.stringify({ path: 'app/desktop/src/kordi-app/components/transcript.tsx' }),
      liveOutput: '',
      resultText: '--- a/app/desktop/src/kordi-app/components/transcript.tsx\n+++ b/app/desktop/src/kordi-app/components/transcript.tsx\n-old\n+new\n+another',
      isError: false,
    },
  ]);

  assert.deepEqual(changedFileRowsFromTurn(turn), [
    {
      path: 'app/desktop/tests/inlineChangedFiles.test.tsx',
      status: 'new',
      artifactId: 'app/desktop/tests/inlineChangedFiles.test.tsx',
      diffStat: { added: 2, removed: 0 },
    },
    {
      path: 'app/desktop/src/kordi-app/components/transcript.tsx',
      status: 'modified',
      artifactId: 'app/desktop/src/kordi-app/components/transcript.tsx',
      diffStat: { added: 2, removed: 1 },
    },
  ]);
});

test('inline changed files render under assistant turns and hide when there are no file changes', () => {
  const changedTurn = turnWithTools([
    {
      id: 'tool-edit',
      name: 'edit',
      status: 'done',
      arguments: JSON.stringify({ path: 'app/desktop/src/features/chat/artifacts.ts' }),
      liveOutput: '',
      resultText: '+added\n-removed',
      isError: false,
    },
  ]);
  const unchangedTurn = turnWithTools([]);

  const changedMarkup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn: changedTurn, historical: true }));
  const unchangedMarkup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn: unchangedTurn, historical: true }));

  assert.match(changedMarkup, /Changed 1 file/);
  assert.match(changedMarkup, /data-inline-changed-files="true"/);
  assert.match(changedMarkup, /data-artifact-id="app\/desktop\/src\/features\/chat\/artifacts.ts"/);
  assert.doesNotMatch(unchangedMarkup, /Changed \d+ file/);
  assert.doesNotMatch(unchangedMarkup, /data-inline-changed-files="true"/);
});

test('hidden changed file kinds are filtered out of inline rows and artifact extraction', () => {
  const turn = turnWithTools([
    {
      id: 'tool-package',
      name: 'write',
      status: 'done',
      arguments: JSON.stringify({ path: 'package.json' }),
      liveOutput: '',
      resultText: '+script',
      isError: false,
    },
    {
      id: 'tool-skill',
      name: 'edit',
      status: 'done',
      arguments: JSON.stringify({ path: 'skills/review/SKILL.md' }),
      liveOutput: '',
      resultText: '+skill',
      isError: false,
    },
    {
      id: 'tool-memory',
      name: 'reflection',
      status: 'done',
      arguments: JSON.stringify({ path: '.kordi/reflection-lessons/session.md' }),
      liveOutput: '',
      resultText: '+lesson',
      isError: false,
    },
  ]);
  const message: Message = { role: 'owned-agent', sender: 'My Kordi', text: 'Done.', time: '10:00', turn };

  assert.deepEqual(changedFileRowsFromTurn(turn), []);
  assert.deepEqual(extractSessionArtifacts([message]), []);
});

test('failed turns still show successful file writes without an incomplete badge', () => {
  const turn = turnWithTools([
    {
      id: 'tool-write',
      name: 'write',
      status: 'done',
      arguments: JSON.stringify({ path: 'docs/failure-report.md' }),
      liveOutput: '',
      resultText: '+partial',
      isError: false,
    },
  ], {
    status: 'failed',
    succeeded: false,
    error: 'The final command failed.',
  });

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));

  assert.match(markup, /Changed 1 file/);
  assert.doesNotMatch(markup, /incomplete/);
  assert.match(markup, /docs\/failure-report.md/);
});

test('failed file write attempts are not shown as changed files', () => {
  const turn = turnWithTools([
    {
      id: 'tool-failed-write',
      name: 'write',
      status: 'error',
      arguments: JSON.stringify({ path: '/root/tmp_test_task/README.md' }),
      liveOutput: '',
      resultText: 'Permission denied',
      isError: true,
    },
    {
      id: 'tool-successful-write',
      name: 'write',
      status: 'done',
      arguments: JSON.stringify({ path: 'tmp_test_task.md' }),
      liveOutput: '',
      resultText: '+content',
      isError: false,
    },
  ], {
    status: 'failed',
    succeeded: false,
    error: 'Could not write under /root.',
  });

  assert.deepEqual(changedFileRowsFromTurn(turn), [{
    path: 'tmp_test_task.md',
    status: 'new',
    artifactId: 'tmp_test_task.md',
    diffStat: { added: 1, removed: 0 },
  }]);

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));
  assert.match(markup, /Changed 1 file/);
  assert.match(markup, /tmp_test_task.md/);
  assert.doesNotMatch(markup, /\/root\/tmp_test_task\/README.md/);
});

test('long inline changed file lists collapse after five rows', () => {
  const tools = Array.from({ length: 7 }, (_, index) => ({
    id: `tool-${index}`,
    name: 'write',
    status: 'done',
    arguments: JSON.stringify({ path: `docs/report-${index}.md` }),
    liveOutput: '',
    resultText: '+line',
    isError: false,
  }));
  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn: turnWithTools(tools), historical: true }));

  assert.match(markup, /Changed 7 files/);
  assert.match(markup, /Show 2 more/);
  assert.match(markup, /docs\/report-4.md/);
  assert.doesNotMatch(markup, /docs\/report-5.md/);
});

test('click handler routes the selected changed file artifact id to the Artifact Inspector opener', () => {
  let opened: string | null = null;

  openInlineChangedFile({
    path: 'app/desktop/src/kordi-app/components/transcript.tsx',
    status: 'modified',
    artifactId: 'app/desktop/src/kordi-app/components/transcript.tsx',
  }, (artifactId) => {
    opened = artifactId;
  });

  assert.equal(opened, 'app/desktop/src/kordi-app/components/transcript.tsx');

  const source = readFileSync(new URL('../src/kordi-app/components/transcriptChangedFiles.tsx', import.meta.url), 'utf8');
  assert.match(source, /onClick=\{\(\) => openInlineChangedFile\(row, onOpenArtifact\)\}/);
});

test('assistant message bubbles pass changed file clicks to the Artifact Inspector opener', () => {
  const message: Message = {
    id: 'msg-with-files',
    role: 'owned-agent',
    sender: 'My Kordi',
    text: 'Done.',
    time: '10:00',
    turn: turnWithTools([
      {
        id: 'tool-edit',
        name: 'edit',
        status: 'done',
        arguments: JSON.stringify({ path: 'app/desktop/src/pages/ArtifactInspector.tsx' }),
        liveOutput: '',
        resultText: '+row',
        isError: false,
      },
    ]),
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenArtifact: () => undefined }));

  assert.match(markup, /Changed 1 file/);
  assert.match(markup, /Open app\/desktop\/src\/pages\/ArtifactInspector.tsx in Artifact Inspector/);
});
