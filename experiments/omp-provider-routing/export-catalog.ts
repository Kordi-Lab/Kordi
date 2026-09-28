import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildCatalogOutput } from './catalog-builder';

const SECRET_PATTERN = /(sk-|key=|token=)/i;

// `auth.placeholder` is a UI format hint shown in an API-key input (e.g. "sk-...",
// "csk-...") — never a URL and never a real secret — so it is expected to match
// the "sk-" half of SECRET_PATTERN and is excluded from this scan. Every other
// field (in particular `auth.authUrl`, which is the field this check exists to
// protect) is still scanned.
const EXCLUDED_KEYS = new Set(['placeholder']);

function assertNoSecrets(value: unknown, trail: string, key?: string): void {
  if (key && EXCLUDED_KEYS.has(key)) return;
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value)) {
      throw new Error(`Refusing to write catalog: value at ${trail} looks like it embeds a secret: ${JSON.stringify(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${trail}[${index}]`, key));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [nestedKey, nested] of Object.entries(value)) {
      assertNoSecrets(nested, `${trail}.${nestedKey}`, nestedKey);
    }
  }
}

async function main() {
  const output = await buildCatalogOutput();

  assertNoSecrets(output, '$');

  const outDir = path.join(import.meta.dir, '../../shared/omp-catalog');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'omp-provider-catalog.json');
  await Bun.write(outPath, `${JSON.stringify(output, null, 2)}\n`);

  const withModels = output.providers.filter((provider) => provider.models.length > 0).length;
  console.log(`Wrote ${outPath}`);
  console.log(`Providers: ${output.providers.length} (with at least one text model: ${withModels})`);
}

await main();
