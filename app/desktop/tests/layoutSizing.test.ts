import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampDetailPanelWidth } from '../src/kordi-app/layout';

test('right detail rail can resize wider when the window has room', () => {
  assert.equal(clampDetailPanelWidth(680, 1600, 320), 680);
});

test('right detail rail still preserves the main content minimum width', () => {
  assert.equal(clampDetailPanelWidth(720, 1300, 320), 380);
});
