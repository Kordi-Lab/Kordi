import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_EXTENSIONS,
  DEFAULT_SKIP_DIRS,
  formatOverlongFileRows,
  parseOverlongFileArgs,
  scanOverlongFiles,
} from './report-overlong-files.mjs';

async function writeLines(root, relativePath, count) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n'));
  return filePath;
}

test('scanOverlongFiles reports supported source files at or above the threshold', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-overlong-scan-'));
  try {
    await writeLines(temp, 'src/small.ts', 4);
    await writeLines(temp, 'src/large.ts', 5);
    await writeLines(temp, 'src/large.rs', 7);
    await writeLines(temp, 'src/ignored.md', 20);

    const rows = await scanOverlongFiles(temp, { minLines: 5 });

    assert.deepEqual(rows, [
      { lineCount: 7, path: 'src/large.rs' },
      { lineCount: 5, path: 'src/large.ts' },
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('scanOverlongFiles skips generated and dependency directories by default', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-overlong-scan-'));
  try {
    await writeLines(temp, 'node_modules/pkg/index.ts', 100);
    await writeLines(temp, 'target/debug/build.rs', 100);
    await writeLines(temp, 'app/desktop/dist/index.js', 100);
    await writeLines(temp, 'app/desktop/src-tauri/gen/schemas.ts', 100);
    await writeLines(temp, 'app/desktop/src/main.tsx', 100);

    const rows = await scanOverlongFiles(temp, { minLines: 50 });

    assert.deepEqual(rows, [{ lineCount: 100, path: 'app/desktop/src/main.tsx' }]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('parseOverlongFileArgs ignores pnpm separator arguments', () => {
  const options = parseOverlongFileArgs(['--', '--min-lines', '1000', '--limit', '10']);

  assert.equal(options.minLines, 1000);
  assert.equal(options.limit, 10);
});

test('formatOverlongFileRows keeps issue scan output stable', () => {
  const output = formatOverlongFileRows([
    { lineCount: 1234, path: 'src/a.ts' },
    { lineCount: 78, path: 'src/b.rs' },
  ]);

  assert.equal(output, '1234 src/a.ts\n  78 src/b.rs');
  assert.equal(DEFAULT_EXTENSIONS.has('.tsx'), true);
  assert.equal(DEFAULT_SKIP_DIRS.has('node_modules'), true);
});
