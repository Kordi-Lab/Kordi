import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isDiffLikeOutput, parseDiffOutput, stripAnsi } from '../src/kordi-app/components/diffOutput';

const ansiPatch = "\u001b[38;2;128;128;128m  1   || trimmed.startsWith('draft:')\u001b[0m\n\u001b[48;2;58;30;30m- 5   return participants\u001b[0m\n\u001b[48;2;30;58;30m+ 5   const nonSelf = participants\u001b[0m";

test('strips ANSI escape sequences from tool output', () => {
  assert.equal(stripAnsi(ansiPatch).includes('\u001b['), false);
});

test('detects ANSI-colored edit output as diff-like output', () => {
  assert.equal(isDiffLikeOutput(ansiPatch), true);
});

test('parses ANSI-colored edit output into semantic diff rows', () => {
  const parsedAnsiPatch = parseDiffOutput(ansiPatch);

  assert.deepEqual(parsedAnsiPatch.map((line) => line.kind), ['context', 'delete', 'add']);
  assert.equal(parsedAnsiPatch[1].content.trim(), 'return participants');
  assert.equal(parsedAnsiPatch[2].content.trim(), 'const nonSelf = participants');
});

test('does not treat a single plus-prefixed normal line as a patch', () => {
  assert.equal(isDiffLikeOutput('normal command output\n+ not enough context'), false);
});

test('parses unified diffs with file, hunk, context, addition, and deletion rows', () => {
  const unifiedDiff = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -10,2 +10,3 @@
 const keep = true;
-oldValue();
+newValue();
+extraValue();`;

  const parsedUnifiedDiff = parseDiffOutput(unifiedDiff);

  assert.deepEqual(
    parsedUnifiedDiff.map((line) => line.kind),
    ['file', 'file', 'file', 'hunk', 'context', 'delete', 'add', 'add'],
  );
  assert.equal(parsedUnifiedDiff[4].oldLineNumber, 10);
  assert.equal(parsedUnifiedDiff[4].newLineNumber, 10);
  assert.equal(parsedUnifiedDiff[5].oldLineNumber, 11);
  assert.equal(parsedUnifiedDiff[6].newLineNumber, 11);
  assert.equal(parsedUnifiedDiff[7].newLineNumber, 12);
});

test('parses edit tool output header and embedded line numbers for diff gutters', () => {
  const editOutput = [
    'Applied 1/1 edit(s) to app/example.ts',
    '\u001b[38;2;128;128;128m     1 const before = true;\u001b[0m',
    '\u001b[48;2;58;30;30m    \u001b[38;2;204;102;102m-2 oldValue();\u001b[0m',
    '\u001b[48;2;30;58;30m    \u001b[38;2;181;189;104m+2 newValue();\u001b[0m',
  ].join('\n');

  const parsed = parseDiffOutput(editOutput);

  assert.deepEqual(parsed.map((line) => line.kind), ['file', 'context', 'delete', 'add']);
  assert.equal(parsed[0].content, 'app/example.ts');
  assert.equal(parsed[1].oldLineNumber, 1);
  assert.equal(parsed[1].newLineNumber, 1);
  assert.equal(parsed[2].oldLineNumber, 2);
  assert.equal(parsed[2].newLineNumber, undefined);
  assert.equal(parsed[3].oldLineNumber, undefined);
  assert.equal(parsed[3].newLineNumber, 2);
});
