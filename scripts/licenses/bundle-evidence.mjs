import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerSourceDigest } from './relink-evidence.mjs';
export function verifyRuntimeBundleEvidence(root, addon) {
  const proof = JSON.parse(readFileSync(join(root, 'legal/runtime-bundle-review.json'), 'utf8'));
  const runtime = JSON.parse(readFileSync(join(root, 'shared/omp-runtime/package.json'), 'utf8'));
  if (proof.schemaVersion !== 1 || proof.targetTriple !== 'aarch64-apple-darwin' || proof.workerSourceSha256 !== workerSourceDigest(root) || runtime.packageManager !== `bun@${proof.bunVersion}` || proof.ompVersion !== runtime.dependencies['@oh-my-pi/pi-coding-agent'] || proof.optionalLibvips?.present !== false || proof.optionalLibvips?.matchingBundledInputCount !== 0) throw new Error('Repeat the runtime bundle and native dependency review.');
  const result = spawnSync('python3', ['-B', '-c', "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from macho_sections import section_digest; print(section_digest(Path(sys.argv[2]).read_bytes()))", join(root, 'scripts/licenses'), addon], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== proof.nativeAddon?.sectionSha256) throw new Error('Unreviewed native addon contents.');
  return proof;
}
