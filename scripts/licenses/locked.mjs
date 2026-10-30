// Used only when refreshing reviewed license data, never by application builds.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../app/desktop/package.json', import.meta.url));
const { parse } = require('yaml');
const root = new URL('../../', import.meta.url);
const pnpm = parse(readFileSync(new URL('pnpm-lock.yaml', root), 'utf8'));
const bun = JSON.parse(readFileSync(new URL('shared/omp-runtime/bun.lock', root), 'utf8').replace(/,\s*([}\]])/g, '$1'));
const packages = new Map();
function add(identity, ecosystem, integrity) {
  const at = identity.lastIndexOf('@');
  if (at <= 0) throw new Error(`Unsupported locked identity: ${identity}`);
  const row = packages.get(identity) ?? { name: identity.slice(0, at), version: identity.slice(at + 1), ecosystems: [], integrity };
  row.ecosystems.push(ecosystem);
  packages.set(identity, row);
}
for (const [identity, entry] of Object.entries(pnpm.packages)) add(identity, 'pnpm', entry.resolution?.integrity);
for (const entry of Object.values(bun.packages)) add(entry[0], 'bun', entry.at(-1));
process.stdout.write(JSON.stringify([...packages.values()]));
