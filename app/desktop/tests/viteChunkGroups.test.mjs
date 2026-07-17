import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import config from '../vite.config.js';

test('cloud features are split before the generic desktop features chunk', async () => {
  const resolvedConfig = typeof config === 'function'
    ? await config({ command: 'build', mode: 'production' })
    : config;
  const groups = resolvedConfig.build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
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

test('Vite development serves only with an explicit non-production API origin', async () => {
  const previous = process.env.VITE_KORDI_CLOUD_API_BASE;
  try {
    delete process.env.VITE_KORDI_CLOUD_API_BASE;
    assert.throws(
      () => config({ command: 'serve', mode: 'endpoint-guard-test' }),
      /VITE_KORDI_CLOUD_API_BASE is required for development/i,
    );

    process.env.VITE_KORDI_CLOUD_API_BASE = 'https://coordinar.io:443/';
    assert.throws(
      () => config({ command: 'serve', mode: 'endpoint-guard-test' }),
      /production Cloud API is blocked in development/i,
    );

    process.env.VITE_KORDI_CLOUD_API_BASE = 'http://127.0.0.1:17081/';
    const resolved = await config({ command: 'serve', mode: 'endpoint-guard-test' });
    assert.ok(resolved.plugins?.length > 0);
  } finally {
    if (previous === undefined) delete process.env.VITE_KORDI_CLOUD_API_BASE;
    else process.env.VITE_KORDI_CLOUD_API_BASE = previous;
  }
});
