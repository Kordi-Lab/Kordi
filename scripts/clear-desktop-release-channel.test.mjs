import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClearChannelArguments } from './clear-desktop-release-channel.mjs';

test('acceptance cleanup CLI is deliberately scoped to the acceptance pointer', () => {
  assert.deepEqual(parseClearChannelArguments(['--', '--channel', 'acceptance']), {
    channel: 'acceptance',
  });
  assert.throws(
    () => parseClearChannelArguments(['--channel', 'beta']),
    /only.*acceptance/i,
  );
  assert.throws(() => parseClearChannelArguments(['--channel']), /requires a value/i);
  assert.throws(() => parseClearChannelArguments(['--unexpected']), /unknown/i);
});
