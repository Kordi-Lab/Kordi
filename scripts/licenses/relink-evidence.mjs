import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../licenses.mjs';
export function workerSourceDigest(root) {
  const prefix = 'shared/omp-runtime/';
  const files = readdirSync(join(root, prefix, 'src'), { recursive: true }).filter((name) => name.endsWith('.ts')).map((name) => prefix + 'src/' + name.split('\\').join('/'));
  files.push(prefix + 'package.json', prefix + 'bun.lock', prefix + 'scripts/build-standalone.mjs', prefix + 'scripts/native-addon.mjs');
  return sha256(files.sort().map((name) => `${name}\0${sha256(readFileSync(join(root, name)))}\n`).join(''));
}
export function verifyRelinkEvidence(root, target = 'aarch64-apple-darwin') {
  const proof = JSON.parse(readFileSync(join(root, 'legal/runtime-relink-verification.json'), 'utf8'));
  const pins = readFileSync(join(root, 'legal/runtime-sources.json'));
  if (proof.schemaVersion !== 1 || proof.status !== 'verified' || proof.targetTriple !== target || proof.bunVersion !== JSON.parse(pins).bunVersion || proof.sourcePinsSha256 !== sha256(pins) || proof.workerSourceSha256 !== workerSourceDigest(root)) throw new Error('Repeat the LGPL relinking probes for the current runtime sources and target.');
  for (const [group, checks] of Object.entries({ baseline: ['ready', 'workerProtocol', 'expectedJscMarker'], modified: ['ready', 'workerProtocol', 'expectedJscMarker'], tinycc: ['modifiedLibraryExecuted', 'compiledCExecuted'] })) {
    for (const name of checks) if (proof.checks?.[group]?.[name] !== true) throw new Error('The LGPL relinking proof is incomplete.');
  }
  for (const name of ['baselineWorker', 'modifiedWorker', 'modifiedBun']) if (!/^[a-f0-9]{64}$/.test(proof.binarySha256?.[name] ?? '')) throw new Error('Missing relinking binary identity.');
  if (proof.binarySha256.baselineWorker === proof.binarySha256.modifiedWorker) throw new Error('Relinking must demonstrate changed executable contents.');
  return proof;
}
