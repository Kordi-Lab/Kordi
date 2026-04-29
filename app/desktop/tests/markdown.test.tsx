import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownContent } from '../src/kordi-app/components/markdown';

test('renders indented fenced code blocks without hanging', () => {
  const markdown = [
    'Before',
    '',
    '   ```json',
    '   {"ok": true}',
    '   ```',
    '',
    'After',
  ].join('\n');

  const html = renderToStaticMarkup(createElement(MarkdownContent, { text: markdown }));

  assert.match(html, /Before/);
  assert.match(html, /After/);
  assert.match(html, /ok/);
});
