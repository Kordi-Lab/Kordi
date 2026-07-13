import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRollbackArguments } from './rollback-desktop-beta-channel.mjs';

test('beta rollback CLI requires an explicit expected current version', () => {
  assert.deepEqual(parseRollbackArguments([
    '--',
    '--expected-current-version',
    '0.0.1-beta.6',
  ]), { expectedCurrentVersion: '0.0.1-beta.6' });
  assert.throws(() => parseRollbackArguments([]), /required/i);
  assert.throws(
    () => parseRollbackArguments(['--expected-current-version']),
    /requires a value/i,
  );
  assert.throws(() => parseRollbackArguments(['--unexpected']), /unknown/i);
});
