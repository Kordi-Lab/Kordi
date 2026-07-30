import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebarTypesSource = readFileSync(
  new URL('../src/pages/workspaceSidebar.types.ts', import.meta.url),
  'utf8',
);
const compositionSource = readFileSync(
  new URL('../src/app/assembleSidebarSlot.tsx', import.meta.url),
  'utf8',
);

const expectedContexts = [
  ['layout', 'WorkspaceSidebarLayout'],
  ['chats', 'WorkspaceSidebarChats'],
  ['projects', 'WorkspaceSidebarProjects'],
  ['directory', 'WorkspaceSidebarDirectory'],
  ['account', 'WorkspaceSidebarAccount'],
] as const;

function contextFieldCount(typeName: string) {
  const match = sidebarTypesSource.match(
    new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`),
  );
  assert.ok(match, `${typeName} must remain an explicit owned context`);
  return [...match[1].matchAll(/^ {2}[A-Za-z][A-Za-z0-9]*\??:/gm)].length;
}

test('WorkspaceSidebar exposes cohesive contexts below the 50-field boundary', () => {
  const propsMatch = sidebarTypesSource.match(
    /export type WorkspaceSidebarProps = \{([\s\S]*?)\n\};/,
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

test('sidebar composition supplies every context explicitly', () => {
  for (const [field] of expectedContexts) {
    assert.match(compositionSource, new RegExp(`\\n {6}${field}=\\{\\{`));
  }
});
