import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateSuppressionGrowth,
  formatSuppressionGrowth,
  parseSuppressionRatchetArgs,
  parseSuppressions,
} from './check-eslint-suppressions-ratchet.mjs';

test('suppression ratchet allows equal or reduced existing debt', () => {
  const previous = parseSuppressions({
    'src/a.ts': {
      'rule/a': { count: 3 },
      'rule/b': { count: 1 },
    },
  });
  const current = parseSuppressions({
    'src/a.ts': {
      'rule/a': { count: 2 },
      'rule/b': { count: 1 },
    },
  });

  assert.deepEqual(evaluateSuppressionGrowth(current, previous), []);
});

test('suppression ratchet rejects new and increased debt', () => {
  const previous = parseSuppressions({
    'src/a.ts': {
      'rule/a': { count: 2 },
    },
  });
  const current = parseSuppressions({
    'src/a.ts': {
      'rule/a': { count: 3 },
    },
    'src/b.tsx': {
      'rule/b': { count: 1 },
    },
  });

  assert.deepEqual(evaluateSuppressionGrowth(current, previous), [
    {
      addedCount: 1,
      count: 3,
      filePath: 'src/a.ts',
      previousCount: 2,
      ruleName: 'rule/a',
    },
    {
      addedCount: 1,
      count: 1,
      filePath: 'src/b.tsx',
      previousCount: 0,
      ruleName: 'rule/b',
    },
  ]);
});

test('suppression parsing validates positive integer counts', () => {
  assert.throws(
    () => parseSuppressions({ 'src/a.ts': { 'rule/a': { count: 0 } } }),
    /invalid count/,
  );
});

test('suppression ratchet arguments and output remain stable', () => {
  assert.deepEqual(
    parseSuppressionRatchetArgs(['--', 'base...head', '--suppressions', 'custom.json']),
    { diffRange: 'base...head', suppressionsPath: 'custom.json' },
  );
  assert.match(
    formatSuppressionGrowth([{
      addedCount: 2,
      count: 4,
      filePath: 'src/a.ts',
      previousCount: 2,
      ruleName: 'rule/a',
    }]),
    /src\/a\.ts :: rule\/a: 2 -> 4 \(\+2\)/,
  );
});
