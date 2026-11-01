import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function stageRuntimeLicenses(runtimeDir, outputDir, compilerVersion, targetTriple) {
  const root = resolve(runtimeDir, '../..');
  const payload = join(root, 'legal/distribution');
  const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8'));
  for (const relative of ['shared/omp-runtime/bun.lock', 'shared/omp-runtime/package.json']) {
    if (hash(readFileSync(join(root, relative))) !== manifest.inputs[relative]) throw new Error('Runtime license data is stale; refresh the reviewed catalog.');
  }
  const runtime = JSON.parse(readFileSync(join(runtimeDir, 'package.json'), 'utf8'));
  const expected = runtime.packageManager.replace(/^bun@/, '');
  if (compilerVersion !== expected) throw new Error(`The licensed runtime is Bun ${expected}; found ${compilerVersion}. Review a runtime upgrade before compiling.`);
  for (const [name, expectedHash] of Object.entries(manifest.files)) {
    if (!/^[A-Za-z0-9.-]+$/.test(name)) throw new Error('Unsafe license payload path.');
    if (hash(readFileSync(join(payload, name))) !== expectedHash) throw new Error(`Corrupt runtime license file: ${name}`);
  }
  const destination = join(outputDir, 'licenses');
  mkdirSync(destination, { recursive: true });
  cpSync(payload, destination, { recursive: true });
  writeFileSync(join(destination, 'runtime-build.json'), `${JSON.stringify({ schemaVersion: 1, bunVersion: compilerVersion, ompVersion: runtime.dependencies['@oh-my-pi/pi-coding-agent'], targetTriple, bunLockSha256: manifest.inputs['shared/omp-runtime/bun.lock'] }, null, 2)}\n`);
}
