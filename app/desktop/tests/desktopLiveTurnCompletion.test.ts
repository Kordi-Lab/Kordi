import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('completed live turn appends historical reply before removing live snapshot to avoid a blank frame', () => {
  const source = readFileSync(new URL('../src/features/chat/useDesktopChatState.ts', import.meta.url), 'utf8');
  const functionStart = source.indexOf('const mergeCompletedDesktopTurn = useCallback');
  assert.notEqual(functionStart, -1);
  const functionEnd = source.indexOf('  const watchDesktopLiveTurn = useCallback', functionStart);
  assert.notEqual(functionEnd, -1);
  const body = source.slice(functionStart, functionEnd);

  const firstAppend = body.indexOf('setDesktopChatState((current) => {');
  const firstRemove = body.indexOf('removeLiveTurnSnapshot(turn.sessionId, turn.id)');
  assert.notEqual(firstAppend, -1);
  assert.notEqual(firstRemove, -1);
  assert.ok(
    firstAppend < firstRemove,
    'the completed assistant message should be queued before live snapshot removal so the transcript never renders without either row',
  );
  assert.match(
    body,
    /window\.setTimeout\(\(\) => removeLiveTurnSnapshot\(turn\.sessionId, turn\.id\), 180\)/,
    'live snapshot removal should be delayed briefly and guarded by turn id so the historical row can hydrate without a completion flash',
  );
});
