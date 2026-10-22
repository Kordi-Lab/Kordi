import { LiveChatTurnCard } from '../src/kordi-app/components/transcriptLiveTurns';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupTurnSegments, mergeTurnSegments, parseTurnSegments, type TurnSegment } from '../src/features/chat/turnSegments';
import { TurnProgress } from '../src/kordi-app/components/TurnProgress';
import { turnProgressLabel } from '../src/kordi-app/components/turnProgressLabels';
import { cloudAgentExecutionSnapshotFromTurn } from '../src/features/cloud/cloudAgentExecutionTrace';
import { parseCloudAgentExecutionSnapshot } from '../src/features/cloud/cloudAgentExecutionSnapshot';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const segments: TurnSegment[] = [
  { id: 'a', kind: 'text', text: 'I will inspect the example.' },
  { id: 'tool:one', kind: 'tool', toolId: 'one' },
  { id: 'tool:two', kind: 'tool', toolId: 'two' },
  { id: 'b', kind: 'text', text: 'The example needs one change.' },
  { id: 'tool:three', kind: 'tool', toolId: 'three' },
  { id: 'c', kind: 'text', text: 'The example is ready.', revision: 1 },
];
const turn: DesktopChatTurnSnapshot = {
  id: 'turn', sessionId: 'session', prompt: '', message: '', status: 'running',
  assistantText: 'Legacy aggregate must not repeat', thinkingText: 'Private reasoning must stay collapsed',
  completed: false, succeeded: false, startedAtMs: 1000, segments,
  tools: ['one', 'two', 'three'].map(id => ({ id, name: 'read', status: 'done', arguments: '{}', liveOutput: 'detail', isError: false })),
};

test('groups only adjacent tools and preserves commentary boundaries through JSON hydration', () => {
  const restored = parseTurnSegments(JSON.parse(JSON.stringify(segments)))!;
  const groups = groupTurnSegments(restored, turn.tools);
  assert.deepEqual(groups.map(group => group.id), ['a', 'tool:one', 'b', 'tool:three', 'c']);
  assert.equal(groups[1].kind === 'tools' && groups[1].tools.length, 2);
  assert.equal(groupTurnSegments(restored, [turn.tools[2]])[1].kind, 'tools');
  assert.deepEqual(parseTurnSegments([null, {}, segments[0], segments[0]]), [segments[0]]);
});

test('snapshot replay does not duplicate or reorder segments and keeps partial text', () => {
  assert.deepEqual(mergeTurnSegments(segments, segments), segments);
  const next: TurnSegment[] = [...segments.slice(0, 5), { id: 'c', kind: 'text', text: 'The example is ready. Verified.', revision: 2 }];
  assert.deepEqual(mergeTurnSegments(mergeTurnSegments(segments, next), segments), next);
});

test('ordered rendering has one active signal and no duplicated aggregate or raw reasoning', () => {
  const markup = renderToStaticMarkup(createElement(TurnProgress, { turn, renderTool: tool => createElement('div', { key: tool.id }, tool.id), legacyAnswer: 'Legacy aggregate must not repeat' }));
  const texts = ['I will inspect the example.', 'Read context', 'The example needs one change.', 'Read context', 'The example is ready.'];
  let position = -1;
  for (const text of texts) { const next = markup.indexOf(text, position + 1); assert.ok(next > position, text); position = next; }
  assert.equal((markup.match(/app-turn-progress-dots/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /Legacy aggregate|Private reasoning|Observation|Execution ×|done|complete/);
});

test('terminal duration comes from stored timestamps and tool errors do not fail a successful turn', () => {
  const completed = { ...turn, status: 'succeeded', completed: true, succeeded: true, completedAtMs: 9000 };
  const markup = renderToStaticMarkup(createElement(TurnProgress, { turn: completed, renderTool: () => null }));
  assert.match(markup, /Worked for 8s/);
  assert.doesNotMatch(markup, /app-turn-progress-dots/);
  assert.equal(turnProgressLabel({ ...completed, tools: [{ ...turn.tools[0], status: 'error', isError: true }] }), 'Worked for');
  assert.equal(turnProgressLabel({ ...turn, status: 'cancelled', completed: true }), 'Stopped');
});

test('owner execution transport preserves ordered prose and tool references', () => {
  const snapshot = cloudAgentExecutionSnapshotFromTurn(turn, 9000);
  assert.deepEqual(parseCloudAgentExecutionSnapshot(JSON.parse(JSON.stringify(snapshot)))?.segments, segments);
});

test('activity summaries combine observed actions without repeating every tool', async () => {
  const { settledProgressLabel } = await import('../src/kordi-app/components/turnProgressLabels');
  const read = { ...turn.tools[0], arguments: '{"path":"src/example.ts"}' };
  assert.equal(settledProgressLabel([read, read, { ...read, name: 'bash', arguments: '{"command":"pnpm test"}' }]), 'Read files, ran tests');
  assert.equal(settledProgressLabel([], 2), 'Earlier activity');
});

test('live status describes concurrent tools and excludes failed or finished work', () => {
  const tool = { ...turn.tools[0], status: 'running' };
  const disk = { ...tool, name: 'bash', arguments: '{"command":"df -h"}' };
  const web = { ...tool, id: 'web', name: 'web_search' };
  assert.equal(turnProgressLabel({ ...turn, tools: [disk, web] }), 'Checking disk usage, searching the web');
  assert.equal(turnProgressLabel({ ...turn, tools: [disk, { ...web, isError: true }] }), 'Checking disk usage');
  assert.equal(turnProgressLabel({ ...turn, tools: [{ ...disk, status: 'done' }, web] }), 'Searching the web');
  assert.equal(turnProgressLabel({ ...turn, status: 'thinking', tools: [] }), 'Thinking');
  assert.equal(turnProgressLabel({ ...turn, status: 'waiting-approval', tools: [disk] }), 'Waiting for approval');
});

test('file links use explicit file arguments and tolerate incomplete tool streams', async () => {
  const { toolActivityMetadata } = await import('../src/kordi-app/components/toolActivityMetadata');
  assert.equal(toolActivityMetadata({ ...turn.tools[0], arguments: '{"file_path":"src/example.ts"}' }).path, 'src/example.ts');
  assert.equal(toolActivityMetadata({ ...turn.tools[0], arguments: '{"path":"https://example.invalid/file.ts"}' }).path, undefined);
  for (const argumentsJson of ['{', 'null', '1', '[]']) assert.equal(toolActivityMetadata({ ...turn.tools[0], arguments: argumentsJson }).path, undefined);
  assert.equal(toolActivityMetadata({ ...turn.tools[0], name: 'bash', arguments: '{"command":"cat src/example.ts"}' }).path, undefined);
});

test('a plain completed response has no duration section or empty activity wrapper', () => {
  const simple = { ...turn, thinkingText: '', tools: [], completed: true, succeeded: true, status: 'succeeded', completedAtMs: 9000,
    segments: [{ id: 'text:0', kind: 'text' as const, text: 'Hello.' }] };
  const markup = renderToStaticMarkup(createElement(TurnProgress, { turn: simple, renderTool: () => null }));
  assert.match(markup, /Hello\./);
  assert.doesNotMatch(markup, /Worked for|app-turn-worked-header|app-turn-progress-summary|app-turn-final/);
});


test('ordered commentary replaces the initial processing placeholder even before aggregate text arrives', () => {
  const streaming = { ...turn, status: 'starting', assistantText: '', thinkingText: '', tools: [],
    segments: [{ id: 'text:0', kind: 'text' as const, text: 'I will check the example.' }] };
  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn: streaming, showReasoning: true, onStopActiveTurn: () => {} }));
  assert.match(markup, /I will check the example/);
  assert.match(markup, /Stop agent request/);
  assert.doesNotMatch(markup, /app-agent-waiting-wave|app-transcript-live-status|app-turn-progress-dots/);
});
