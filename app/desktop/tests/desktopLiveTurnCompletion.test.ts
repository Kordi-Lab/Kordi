import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('completed live turn installs the keyed transcript reply before removing the live snapshot', () => {
  const source = readFileSync(new URL('../src/features/chat/useDesktopChatState.ts', import.meta.url), 'utf8');
  const functionStart = source.indexOf('const mergeCompletedDesktopTurn = useCallback');
  assert.notEqual(functionStart, -1);
  const functionEnd = source.indexOf('  const watchDesktopLiveTurn = useCallback', functionStart);
  assert.notEqual(functionEnd, -1);
  const body = source.slice(functionStart, functionEnd);

  const firstAppend = body.indexOf('setDesktopChatState((current) => {');
  const firstCacheAppend = body.indexOf('appendSessionSourceMessage(');
  const completedMessageRemove = body.lastIndexOf('removeLiveTurnSnapshot(turn.sessionId, turn.id)');
  assert.notEqual(firstAppend, -1);
  assert.notEqual(firstCacheAppend, -1);
  assert.notEqual(completedMessageRemove, -1);
  assert.ok(
    firstAppend < completedMessageRemove,
    'the completed assistant message should be queued before live snapshot removal so the transcript never renders without either row',
  );
  assert.ok(
    firstCacheAppend < completedMessageRemove,
    'the completed assistant message should reach a hydrated inactive-session cache before the live row is removed',
  );
  assert.doesNotMatch(body, /setTimeout[\s\S]*removeLiveTurnSnapshot/);
  assert.doesNotMatch(
    body,
    /if \(!appendSessionSourceMessage\([^)]*\)\) return/,
    'a missing inactive-session cache must not leave a terminal live row stuck in Processing',
  );
  assert.match(body, /buildCompletedDesktopAssistantMessage\(turn, finishedAtMs\)/);
  assert.match(source, /desktopTurnRenderAliases\.register\(nextTurn\)[\s\S]*refreshCompletedDesktopTurnTranscript\(nextTurn\)/);
});

test('live replies render inside the keyed transcript item collection instead of a separate tail row', () => {
  const source = readFileSync(new URL('../src/pages/chatsPage.sessionPane.tsx', import.meta.url), 'utf8');

  assert.match(source, /buildDesktopLiveTurnTranscriptMessage/);
  assert.match(source, /\[\.\.\.attributedTranscript\.messages, liveTurnMessage\]/);
  assert.doesNotMatch(source, /<LiveChatTurnMessage/);
});
