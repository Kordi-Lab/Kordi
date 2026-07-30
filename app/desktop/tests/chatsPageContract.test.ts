import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const contractSource = readFileSync(
  new URL('../src/pages/chatsPage.types.ts', import.meta.url),
  'utf8',
);
const compositionSource = readFileSync(
  new URL('../src/app/mainContentShellBuilders.ts', import.meta.url),
  'utf8',
);

const expectedContexts = [
  ['layout', 'ChatsPageLayout'],
  ['session', 'ChatsPageSession'],
  ['transcript', 'ChatsPageTranscript'],
  ['composer', 'ChatsPageComposer'],
  ['runtime', 'ChatsPageRuntime'],
  ['auth', 'ChatsPageAuth'],
] as const;

function contextFieldCount(typeName: string) {
  const match = contractSource.match(
    new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`),
  );
  assert.ok(match, `${typeName} must remain an explicit owned context`);
  return [...match[1].matchAll(/^ {2}[A-Za-z][A-Za-z0-9]*\\??:/gm)].length;
}

test('ChatsPage exposes cohesive contexts below the 50-field boundary', () => {
  const propsMatch = contractSource.match(
    /export type ChatsPageProps = \{([\s\S]*?)\n\};/,
  );
  assert.ok(propsMatch);

  const publicFields = [...propsMatch[1].matchAll(
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

test('application composition supplies every ChatsPage context explicitly', () => {
  const builderStart = compositionSource.indexOf('export function buildChatsPageProps');
  const builderEnd = compositionSource.indexOf('\n}', builderStart);
  const builder = compositionSource.slice(builderStart, builderEnd);

  for (const [field] of expectedContexts) {
    assert.match(builder, new RegExp(`\\n {4}${field}: \\{`));
  }
});
