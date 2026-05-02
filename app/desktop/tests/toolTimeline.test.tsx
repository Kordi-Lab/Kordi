import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { formatRunningElapsed, toolTimelineFoldedLabel, toolTimelineSummary, toolTimelineToolLabel, toolTimelineTypeLabel } from '../src/kordi-app/components/toolTimeline';

function cssBlock(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, 's').exec(css);
  assert.ok(match, `Missing CSS block for ${selector}`);
  return match[0];
}

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

test('running tool timeline styling uses muted amber tokens without glow', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(themeTokensCss, /--app-tool-running-fg:\s*oklch\([^)]*0\.0[0-8]/);
  assert.match(cssBlock(shellCss, '.app-transcript-timeline-row-running .app-transcript-timeline-row-title'), /color:\s*var\(--app-tool-running-fg\)/);
  assert.match(cssBlock(shellCss, '.app-transcript-timeline-row-running .app-transcript-timeline-node'), /color:\s*var\(--app-tool-running-icon\)/);
  assert.match(cssBlock(shellCss, '.app-transcript-timeline-running-time'), /color:\s*var\(--app-tool-running-muted\)/);

  const dotBlock = cssBlock(shellCss, '.app-transcript-tool-running-dot');
  assert.match(dotBlock, /background:\s*var\(--app-tool-running-fg\)/);
  assert.doesNotMatch(dotBlock, /box-shadow|animation:/);

  const runningToolCss = [
    dotBlock,
    cssBlock(shellCss, '.app-transcript-tool-pin-running'),
    cssBlock(shellCss, '.app-transcript-status-text-running'),
    cssBlock(shellCss, '.app-transcript-tool-row-running'),
    cssBlock(shellCss, '.app-transcript-tool-row-running .app-transcript-tool-row-icon'),
    cssBlock(shellCss, '.app-transcript-single-tool-running'),
    cssBlock(shellCss, '.app-transcript-timeline-row-running .app-transcript-timeline-row-title'),
    cssBlock(shellCss, '.app-transcript-timeline-row-running .app-transcript-timeline-node'),
    cssBlock(shellCss, '.app-transcript-timeline-running-time'),
  ].join('\n');
  assert.doesNotMatch(runningToolCss, /rgb\(251 191 36\)|rgb\(252 211 77\)/);
});

test('running tool progress takes preview priority over earlier attention state', () => {
  const tools = [
    { name: 'grep', status: 'failed', arguments: '{}', isError: true },
    { name: 'bash', status: 'running', arguments: '{"command":"pnpm lint"}' },
  ];

  assert.equal(
    toolTimelineSummary({ tools, active: true, completed: false }),
    'Thinking and tool use · running…',
  );
  assert.equal(
    toolTimelineFoldedLabel({ tools, active: true, completed: false }),
    'Running command',
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
