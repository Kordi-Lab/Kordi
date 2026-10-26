import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CgProgress } from '../src/features/commonGround/parts';

test('the inline progress is the small one-line status, the default stays the full-page one', () => {
  const inline = renderToStaticMarkup(createElement(CgProgress, { line: 'Finding overlap', inline: true }));
  const page = renderToStaticMarkup(createElement(CgProgress, { line: 'Finding overlap' }));
  assert.match(inline, /class="cg-progress is-inline"/);
  assert.match(inline, /role="status"/);
  assert.match(inline, /Finding overlap/);
  assert.match(page, /class="cg-progress"/);
  assert.doesNotMatch(page, /is-inline/);
});
