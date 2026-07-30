import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const priorityUnits = [
  ['src/features/cloud/useCloudCollaborationState.ts', 'useCloudCollaborationState'],
  ['src/app/useKordiAppModel.ts', 'useKordiAppModel'],
  ['src/pages/ChatsPage.tsx', 'ChatsPage'],
  ['src/pages/WorkspaceSidebar.tsx', 'WorkspaceSidebar'],
] as const;

function functionLineCount(relativePath: string, functionName: string) {
  const source = readFileSync(
    new URL(`../${relativePath}`, import.meta.url),
    'utf8',
  );
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement)
      && statement.name?.text === functionName
    ),
  );
  assert.ok(declaration, `${functionName} must remain a top-level function`);

  const firstLine = sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(sourceFile),
  ).line;
  const lastLine = sourceFile.getLineAndCharacterOfPosition(
    declaration.end,
  ).line;
  return lastLine - firstLine + 1;
}

test('priority frontend units remain below the 500-line boundary', () => {
  for (const [relativePath, functionName] of priorityUnits) {
    const lineCount = functionLineCount(relativePath, functionName);
    assert.ok(
      lineCount <= 500,
      `${functionName} owns ${lineCount} lines; split it before exceeding 500`,
    );
  }
});
