import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { formatRunningElapsed, toolTimelineDisplayArguments, toolTimelineFoldedLabel, toolTimelineSummary, toolTimelineToolLabel, toolTimelineTypeLabel } from '../src/kordi-app/components/toolTimeline';

function cssBlock(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, 's').exec(css);
  assert.ok(match, `Missing CSS block for ${selector}`);
  return match[0];
}

test('labels disk usage shell commands by intent and execution layer', () => {
  assert.equal(toolTimelineToolLabel({ name: 'bash', status: 'done', arguments: '{"command":"df -h"}' }), 'Check disk usage');
  assert.equal(toolTimelineTypeLabel({ name: 'bash', status: 'done', arguments: '{"command":"df -h"}' }), 'Execution');
});

test('labels common tool kinds with concise human text and layer badges', () => {
  assert.equal(toolTimelineToolLabel({ name: 'grep', status: 'done', arguments: '{"pattern":"ToolActivity"}' }), 'Search code');
  assert.equal(toolTimelineTypeLabel({ name: 'grep', status: 'done', arguments: '{}' }), 'Observation');
  assert.equal(toolTimelineToolLabel({ name: 'read', status: 'done', arguments: '{"path":"app/desktop/src/App.tsx"}' }), 'Read file');
  assert.equal(toolTimelineTypeLabel({ name: 'edit', status: 'done', arguments: '{}' }), 'Execution');
  assert.equal(toolTimelineTypeLabel({ name: 'update_plan', status: 'done', arguments: '{}' }), 'Planning');
  assert.equal(toolTimelineTypeLabel({ name: 'task_operator', status: 'done', arguments: '{}' }), 'Operator');
  assert.equal(toolTimelineTypeLabel({ name: 'reflection', status: 'done', arguments: '{}' }), 'Reflection');
  assert.equal(toolTimelineTypeLabel({ name: 'read', status: 'done', arguments: '{}', toolLayer: 'reflection' }), 'Reflection');
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
  const shellCss = readDesktopShellCss();
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
    toolTimelineFoldedLabel({ tools, active: true, completed: false, runningElapsed: '12s' }),
    'Execution: running command: pnpm lint · 12s',
  );
});

/**
 * The folded active preview is the only visible tool state until the user expands
 * the timeline, so it must identify the live work instead of repeating generic
 * thinking copy.
 */
test('running folded preview includes live tool target and elapsed time before thinking text', () => {
  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'bash', status: 'running', arguments: '{"command":"pnpm --dir app/desktop lint"}' }],
      active: true,
      completed: false,
      thinkingText: 'Clarifying task requirements',
      runningElapsed: '9s',
    }),
    'Execution: running command: pnpm --dir app/desktop lint · 9s',
  );

  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'read', status: 'running', arguments: '{"path":"app/desktop/src/kordi-app/components/toolTimeline.ts"}' }],
      active: true,
      completed: false,
      runningElapsed: '4s',
    }),
    'Observation: reading file: app/desktop/src/kordi-app/components/toolTimeline.ts · 4s',
  );

  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'grep', status: 'running', arguments: '{"pattern":"toolTimelineFoldedLabel"}' }],
      active: true,
      completed: false,
      runningElapsed: '6s',
    }),
    'Observation: searching: toolTimelineFoldedLabel · 6s',
  );

  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'web_fetch', status: 'running', arguments: '{"url":"https://example.com/docs"}' }],
      active: true,
      completed: false,
      runningElapsed: '7s',
    }),
    'Observation: fetching URL: https://example.com/docs · 7s',
  );
});

test('running folded preview hides temporary clipboard paths', () => {
  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'read', status: 'running', arguments: '{"path":"/var/folders/sj/4t94lr1x6nz054myq77r2b4c0000gn/T/pi-clipboard-41b8cb97-c2ff-4f38-9d5a-cbb4d040a552.png"}' }],
      active: true,
      completed: false,
      runningElapsed: '4s',
    }),
    'Observation: reading attached image · 4s',
  );
});

test('tool argument details hide temporary clipboard paths', () => {
  const text = toolTimelineDisplayArguments({
    name: 'read',
    status: 'done',
    arguments: '{"path":"/var/folders/sj/4t94lr1x6nz054myq77r2b4c0000gn/T/pi-clipboard-41b8cb97-c2ff-4f38-9d5a-cbb4d040a552.png"}',
  });

  assert.equal(text.includes('/var/folders'), false);
  assert.match(text, /attached image/);
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
    'Execution: running command: df -h',
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
    'Execution: running command: echo hi',
  );
  assert.equal(
    toolTimelineFoldedLabel({
      tools: [{ name: 'bash', status: 'running', arguments: '{"command":"df -h"}' }],
      active: true,
      completed: false,
      thinkingText: '**Checking disk usage**\n\nI need to inspect the filesystem.',
    }),
    'Execution: running command: df -h',
  );
});
