import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readKordiAppModelImplementationSource } from './helpers/appModelSource';

const contractSource = readFileSync(
  new URL('../src/features/chat/composerController.types.ts', import.meta.url),
  'utf8',
);
const appModelSource = readKordiAppModelImplementationSource();

const expectedContexts = [
  ['environment', 'ComposerEnvironmentContext'],
  ['conversation', 'ComposerConversationContext'],
  ['project', 'ComposerProjectContext'],
  ['runtime', 'ComposerRuntimeContext'],
  ['draft', 'ComposerDraftContext'],
  ['authNavigation', 'ComposerAuthNavigationContext'],
  ['messageRuntime', 'ComposerMessageRuntimeContext'],
] as const;

function contextFieldCount(typeName: string) {
  const match = contractSource.match(
    new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`),
  );
  assert.ok(match, `${typeName} must remain an explicit owned context`);
  return [...match[1].matchAll(/^ {2}[A-Za-z][A-Za-z0-9]*\\??:/gm)].length;
}

test('composer controller exposes cohesive contexts below the 50-field boundary', () => {
  const argsMatch = contractSource.match(
    /export type UseComposerControllerArgs = \{([\s\S]*?)\n\};/,
  );
  assert.ok(argsMatch);

  const publicFields = [...argsMatch[1].matchAll(
    /^ {2}(\w+): (\w+);$/gm,
  )].map((match) => [match[1], match[2]]);
  assert.deepEqual(publicFields, expectedContexts);

  for (const [, typeName] of expectedContexts) {
    const fieldCount = contextFieldCount(typeName);
    assert.ok(fieldCount > 0, `${typeName} must own at least one field`);
    assert.ok(
      fieldCount <= 50,
      `${typeName} owns ${fieldCount} fields; split it before exceeding 50`,
    );
  }
});

test('application composition supplies every composer context explicitly', () => {
  const composerCall = appModelSource.slice(
    appModelSource.indexOf('useComposerController({'),
    appModelSource.indexOf('\n  });', appModelSource.indexOf('useComposerController({')),
  );
  for (const [field] of expectedContexts) {
    assert.match(composerCall, new RegExp(`\\n {4}${field}: \\{`));
  }
});
