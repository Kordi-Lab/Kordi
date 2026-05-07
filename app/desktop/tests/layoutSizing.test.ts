import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampDetailPanelWidth } from '../src/kordi-app/layout';

test('right detail rail can resize much wider when the window has room', () => {
  assert.equal(clampDetailPanelWidth(980, 2200, 320), 980);
});

test('right detail rail caps at a preview-friendly maximum', () => {
  assert.equal(clampDetailPanelWidth(1400, 2400, 320), 1040);
});

test('right detail rail still preserves the main content minimum width', () => {
  assert.equal(clampDetailPanelWidth(720, 1300, 320), 380);
});
