import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(process.argv[2] ?? join(repository, 'agent/dist/runtime'));
const triple = process.argv[3];
if (!triple) throw new Error('Pass an output directory and the native target triple.');
const npm = JSON.parse(readFileSync(join(repository, 'agent/package.json'), 'utf8'));
const runtime = JSON.parse(readFileSync(join(repository, 'shared/omp-runtime/package.json'), 'utf8'));
if (npm.ompRuntimeVersion !== runtime.dependencies['@oh-my-pi/pi-coding-agent']) {
  throw new Error('The npm runtime version must match the pinned OMP worker.');
}
mkdirSync(output, { recursive: true });
const build = spawnSync('node', [join(repository, 'shared/omp-runtime/scripts/build-standalone.mjs'), output, triple], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const worker = `kordi-omp-${triple}${process.platform === 'win32' ? '.exe' : ''}`;
const sibling = process.platform === 'win32' ? 'kordi-omp.exe' : 'kordi-omp';
copyFileSync(join(output, worker), join(output, sibling));
const boot = spawnSync(join(output, sibling), [], { input: '', encoding: 'utf8', timeout: 15_000 });
if (boot.status !== 0 || boot.stdout.trim() !== '{"schemaVersion":1,"type":"ready"}') {
  throw new Error('The CLI runtime assets did not pass the worker startup probe.');
}
console.log('CLI runtime assets are ready to ship alongside the native Kordi executable.');
