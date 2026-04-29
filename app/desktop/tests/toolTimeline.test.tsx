import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatRunningElapsed, toolTimelineFoldedLabel, toolTimelineSummary, toolTimelineToolLabel, toolTimelineTypeLabel } from '../src/kordi-app/components/toolTimeline';

test('labels disk usage shell commands by intent', () => {
  assert.equal(toolTimelineToolLabel({ name: 'bash', status: 'done', arguments: '{"command":"df -h"}' }), 'Check disk usage');
  assert.equal(toolTimelineTypeLabel({ name: 'bash', status: 'done', arguments: '{"command":"df -h"}' }), 'Script');
});

test('labels common tool kinds with concise human text', () => {
  assert.equal(toolTimelineToolLabel({ name: 'grep', status: 'done', arguments: '{"pattern":"ToolActivity"}' }), 'Search code');
  assert.equal(toolTimelineTypeLabel({ name: 'grep', status: 'done', arguments: '{}' }), 'Search');
  assert.equal(toolTimelineToolLabel({ name: 'read', status: 'done', arguments: '{"path":"app/desktop/src/App.tsx"}' }), 'Read file');
  assert.equal(toolTimelineTypeLabel({ name: 'edit', status: 'done', arguments: '{}' }), 'Edit');
});

test('summarizes foldable timeline state without raw tool activity wording', () => {
  assert.equal(
    toolTimelineSummary({ tools: [{ name: 'bash', status: 'running', arguments: '{"command":"df -h"}' }], active: true, completed: false }),
    'Thinking and tool use · running…',
  );
  assert.equal(
    toolTimelineSummary({ tools: [{ name: 'bash', status: 'done', arguments: '{"command":"df -h"}' }], active: false, completed: true }),
    'Used 1 tool · completed',
  );
  assert.equal(
    toolTimelineSummary({ tools: [{ name: 'grep', status: 'failed', arguments: '{}', isError: true }], active: false, completed: true }),
    'Tool use needs attention',
  );
});

test('formats running tool elapsed time compactly', () => {
  assert.equal(formatRunningElapsed(0), '0s');
  assert.equal(formatRunningElapsed(1_500), '1s');
  assert.equal(formatRunningElapsed(65_400), '1m 05s');
});

test('uses a clean one-line folded label for active and completed timelines', () => {
  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'bash', status: 'running', arguments: '{"command":"df -h"}' }],
      active: true,
      completed: false,
      thinkingText: 'assessing current disk space usage and capacity',
    }),
    'Thinking about assessing current disk space usage and capacity',
  );
  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'bash', status: 'done', arguments: '{"command":"df -h"}' }],
      active: false,
      completed: true,
      thinkingText: 'Converted Fahrenheit temperatures to Celsius for Saudi Arabia.',
    }),
    'Converted Fahrenheit temperatures to Celsius for Saudi Arabia',
  );
  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'bash', status: 'running', arguments: '{"command":"echo hi"}' }],
      active: true,
      completed: false,
    }),
    'Running command',
  );
  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'bash', status: 'running', arguments: '{"command":"df -h"}' }],
      active: true,
      completed: false,
      thinkingText: '**Checking disk usage**\n\nI need to inspect the filesystem.',
    }),
    'Thinking about checking disk usage',
  );
});
