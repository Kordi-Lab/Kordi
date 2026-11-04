import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ToolActivityRow } from '../src/kordi-app/components/ToolActivityRow';
import { ToolActivityText } from '../src/kordi-app/components/ToolActivityText';
import type { DesktopChatToolSnapshot } from '../src/kordi-app/types';

const tool: DesktopChatToolSnapshot = {
  id: 'search', name: 'search_sessions', status: 'done', arguments: '{"query":"Project notes"}',
  resultText: 'No matching sessions found.', isError: false,
};
const render = (snapshot = tool) => new JSDOM(renderToStaticMarkup(createElement(ToolActivityRow, { tool: snapshot }))).window.document;

test('short tool results are readable inline without another disclosure and raw input stays collapsed', () => {
  const doc = render();
  assert.equal(doc.querySelector('pre')?.textContent, tool.resultText);
  assert.match(doc.querySelector('.app-tool-activity-label')!.textContent!, /Searched conversations · “Project notes”/);
  assert.equal(doc.querySelectorAll('button').length, 1);
  const input = doc.querySelector('button')!;
  assert.equal(input.textContent, 'View input');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.ok(doc.getElementById(input.getAttribute('aria-controls')!));
  assert.equal(doc.querySelector('[aria-label="Tool input"]'), null);
});

test('inline output keeps streaming and final results without repeating contained streaming text', () => {
  assert.equal(render({ ...tool, liveOutput: 'Partial', resultText: 'Partial result' }).querySelector('pre')?.textContent, 'Partial result');
  assert.equal(render({ ...tool, liveOutput: 'Progress', resultText: 'Final result' }).querySelector('pre')?.textContent, 'Progress\n\nFinal result');
  assert.equal(render({ ...tool, status: 'running', liveOutput: 'Partial', resultText: undefined }).querySelector('pre')?.textContent, 'Partial');
});

test('output previews bound both long lines and many lines without losing short output', () => {
  for (const text of ['Short output', 'x'.repeat(5000), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')]) {
    const doc = new JSDOM(renderToStaticMarkup(createElement(ToolActivityText, { text, label: 'Tool output' }))).window.document;
    const displayed = doc.querySelector('pre')!.textContent!;
    if (text === 'Short output') {
      assert.equal(displayed, text);
      assert.equal(doc.querySelector('button'), null);
    } else {
      assert.ok(displayed.length <= 601);
      assert.ok(displayed.split('\n').length <= 6);
      assert.ok(displayed.endsWith('…'));
      assert.equal(doc.querySelector('button')!.getAttribute('aria-expanded'), 'false');
    }
  }
});

test('input-only and failed tools keep inspectable arguments and error details', () => {
  const inputOnly = render({ ...tool, status: 'running', resultText: undefined });
  assert.equal(inputOnly.querySelector('pre'), null);
  assert.equal(inputOnly.querySelector('button')!.textContent, 'View input');
  const failed = render({ ...tool, status: 'error', isError: true, resultText: 'Unavailable' });
  assert.equal(failed.querySelector('.app-tool-activity-error')!.textContent, 'Failed');
  assert.equal(failed.querySelector('pre')!.textContent, 'Unavailable');
});
