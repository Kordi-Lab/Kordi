import { expect, test } from 'bun:test';
import path from 'node:path';
import { buildCatalogOutput } from './catalog-builder';

// Regenerates the OMP provider catalog snapshot in memory (from the pinned
// @oh-my-pi/pi-catalog install in this package's node_modules) and asserts it
// deep-equals the checked-in shared/omp-catalog/omp-provider-catalog.json.
//
// If @oh-my-pi/pi-catalog is bumped in package.json without re-running
// `bun run export-catalog.ts`, this test fails so the checked-in snapshot can
// never silently drift from the pinned dependency.
test('checked-in OMP catalog snapshot matches the pinned @oh-my-pi/pi-catalog install', async () => {
  const regenerated = await buildCatalogOutput();

  const checkedInPath = path.join(import.meta.dir, '../../shared/omp-catalog/omp-provider-catalog.json');
  const checkedIn = await Bun.file(checkedInPath).json();

  expect(regenerated).toEqual(checkedIn);
});
