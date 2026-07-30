import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySourcePath,
  formatMaintainabilityAudit,
  parseMaintainabilityAuditArgs,
  summarizeSourceInventory,
} from './report-maintainability-audit.mjs';

function lines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
}

test('source classification separates production, tests, and generated paths', () => {
  assert.equal(classifySourcePath('app/desktop/src/App.tsx'), 'production');
  assert.equal(classifySourcePath('app/desktop/tests/app.test.tsx'), 'test');
  assert.equal(classifySourcePath('agent/crates/core/src/tests.rs'), 'test');
  assert.equal(classifySourcePath('scripts/release.spec.mjs'), 'test');
  assert.equal(classifySourcePath('app/desktop/src-tauri/gen/schema.ts'), 'generated');
  assert.equal(classifySourcePath('vendor/client/index.ts'), 'generated');
});

test('inventory summary keeps category line and hotspot counts separate', () => {
  const report = summarizeSourceInventory([
    { path: 'src/app.ts', source: lines(600) },
    { path: 'tests/app.test.ts', source: lines(1200) },
    { path: 'app/desktop/src-tauri/gen/schema.ts', source: lines(1600) },
    { path: 'README.md', source: lines(2000) },
  ]);

  assert.deepEqual(report.categories.production, {
    fileCount: 1,
    lineCount: 600,
    hotspots: { 500: 1, 1000: 0, 1500: 0 },
  });
  assert.deepEqual(report.categories.test, {
    fileCount: 1,
    lineCount: 1200,
    hotspots: { 500: 1, 1000: 1, 1500: 0 },
  });
  assert.deepEqual(report.categories.generated, {
    fileCount: 1,
    lineCount: 1600,
    hotspots: { 500: 1, 1000: 1, 1500: 1 },
  });
  assert.deepEqual(
    report.hotspots.map(({ category, lineCount }) => ({ category, lineCount })),
    [
      { category: 'generated', lineCount: 1600 },
      { category: 'test', lineCount: 1200 },
      { category: 'production', lineCount: 600 },
    ],
  );
});

test('text report and argument parsing expose stable audit controls', () => {
  const report = summarizeSourceInventory([
    { path: 'src/app.ts', source: lines(510) },
  ]);
  const output = formatMaintainabilityAudit(report, { limit: 1 });

  assert.match(output, /production\s+1\s+510\s+1\s+0\s+0/u);
  assert.match(output, /510 production src\/app\.ts/u);
  assert.deepEqual(
    parseMaintainabilityAuditArgs(['--', '--min-lines', '750', '--limit', '12', '--json']),
    {
      root: process.cwd(),
      minLines: 750,
      limit: 12,
      json: true,
    },
  );
});
