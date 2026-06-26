import assert from 'node:assert/strict';
import test from 'node:test';

import config from '../vite.config.js';

test('cloud features are split before the generic desktop features chunk', () => {
  const groups = config.build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
  const names = groups.map((group) => group.name);

  const cloudIndex = names.indexOf('cloud-features');
  const desktopIndex = names.indexOf('desktop-features');

  assert.notEqual(cloudIndex, -1, 'expected a dedicated cloud-features chunk group');
  assert.notEqual(desktopIndex, -1, 'expected the generic desktop-features chunk group');
  assert.ok(
    cloudIndex < desktopIndex,
    'cloud-features must be matched before desktop-features so it is split out',
  );
});
