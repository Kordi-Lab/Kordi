import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Prefer the portable x64 addon; never ship a modern-only CPU requirement. */
export function resolveNativeAddon(packageDir, platform, arch) {
  const tag = `${platform}-${arch}`;
  const names = arch === 'x64'
    ? [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}.node`]
    : [`pi_natives.${tag}.node`];
  const candidate = names.map(name => join(packageDir, name)).find(existsSync);
  if (!candidate) throw new Error(`A portable OMP native addon is required for ${tag}.`);
  return candidate;
}
