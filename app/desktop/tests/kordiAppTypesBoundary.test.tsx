import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('kordi-app message types live in a focused module re-exported by the root type barrel', async () => {
  const messageTypesUrl = new URL('../src/kordi-app/types/message.ts', import.meta.url);

  assert.equal(existsSync(messageTypesUrl), true, 'expected focused message type module to exist');

  const rootTypesSource = readFileSync(new URL('../src/kordi-app/types.ts', import.meta.url), 'utf8');
  assert.match(rootTypesSource, /from ['"]\.\/types\/message['"]/);

  await import('../src/kordi-app/types/message.ts');
});
