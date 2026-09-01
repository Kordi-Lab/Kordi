import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Cloud read repair does not require local canonical materialization', () => {
  const readSource = source('../src/features/cloud/useCanonicalActiveSessionRead.ts');
  assert.match(readSource, /markRead\(\[sessionId\]\)/);
  assert.doesNotMatch(readSource, /if \(!canonicalSession\) return/);
});

test('read cursors do not depend on optional manual-unread preferences', () => {
  const actionsSource = source('../src/features/cloud/useCloudSessionActions.ts');
  assert.match(
    actionsSource,
    /await client\.markSessionMessagesRead\(session\.token, sessionId\);[\s\S]*try \{[\s\S]*client\.setCloudSessionUnread[\s\S]*catch/,
  );
  assert.match(
    actionsSource,
    /setLocallyReadIds\([\s\S]*try \{[\s\S]*await Promise\.all/,
    'the local unread badge must clear before waiting for the server cursor',
  );
});
