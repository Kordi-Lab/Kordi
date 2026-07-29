import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countSourceLines,
  evaluateMaintainabilityChanges,
  formatMaintainabilityViolations,
  isScannableSourcePath,
  parseMaintainabilityArgs,
} from './check-maintainability-ratchet.mjs';

test('evaluateMaintainabilityChanges allows small files and shrinking hotspots', () => {
  const violations = evaluateMaintainabilityChanges([
    {
      path: 'src/new-small.ts',
      previousLineCount: 0,
      currentLineCount: 499,
    },
    {
      path: 'src/shrinking-hotspot.tsx',
      previousLineCount: 800,
      currentLineCount: 700,
    },
    {
      path: 'src/unchanged-hotspot.rs',
      previousLineCount: 600,
      currentLineCount: 600,
    },
  ]);

  assert.deepEqual(violations, []);
});

test('evaluateMaintainabilityChanges blocks new and growing hotspots', () => {
  const violations = evaluateMaintainabilityChanges([
    {
      path: 'src/new-hotspot.ts',
      previousLineCount: 0,
      currentLineCount: 500,
    },
    {
      path: 'src/growing-hotspot.tsx',
      previousLineCount: 800,
      currentLineCount: 803,
    },
    {
      path: 'src/crossing-threshold.rs',
      previousLineCount: 499,
      currentLineCount: 501,
    },
  ]);

  assert.deepEqual(violations, [
    {
      path: 'src/growing-hotspot.tsx',
      previousLineCount: 800,
      currentLineCount: 803,
      addedLineCount: 3,
    },
    {
      path: 'src/crossing-threshold.rs',
      previousLineCount: 499,
      currentLineCount: 501,
      addedLineCount: 2,
    },
    {
      path: 'src/new-hotspot.ts',
      previousLineCount: 0,
      currentLineCount: 500,
      addedLineCount: 500,
    },
  ]);
});

test('source path filtering matches the maintainability scanner exclusions', () => {
  assert.equal(isScannableSourcePath('app/desktop/src/main.tsx'), true);
  assert.equal(isScannableSourcePath('crates/server/src/routes.rs'), true);
  assert.equal(isScannableSourcePath('app/desktop/src-tauri/gen/schema.ts'), false);
  assert.equal(isScannableSourcePath('node_modules/pkg/index.ts'), false);
  assert.equal(isScannableSourcePath('docs/architecture.md'), false);
});

test('argument parsing accepts a CI diff range and custom threshold', () => {
  assert.deepEqual(
    parseMaintainabilityArgs(['--', 'base...head', '--max-lines', '700']),
    { diffRange: 'base...head', maxLines: 700 },
  );
});

test('line counts and failure output stay stable', () => {
  assert.equal(countSourceLines('one\ntwo'), 2);
  assert.equal(countSourceLines(''), 0);
  assert.match(
    formatMaintainabilityViolations([{
      path: 'src/hotspot.ts',
      previousLineCount: 700,
      currentLineCount: 702,
      addedLineCount: 2,
    }]),
    /src\/hotspot\.ts: 700 -> 702 lines \(\+2\)/,
  );
});
