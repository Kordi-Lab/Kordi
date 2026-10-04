import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MESSAGE_LAYOUT_STORAGE_KEY, readStoredMessageLayout } from '../src/app/messageLayoutPreference';

test('message layout defaults to Chat for empty, obsolete, or unavailable storage', () => {
  for (const value of [null, '', 'cards', 'THREADS']) {
    assert.equal(readStoredMessageLayout({ getItem: () => value }), 'chat');
  }
  assert.equal(readStoredMessageLayout({ getItem: () => { throw new Error('Unavailable'); } }), 'chat');
});

test('message layout restores Threads independently of the chat theme', () => {
  assert.equal(readStoredMessageLayout({ getItem: (key) => {
    assert.equal(key, MESSAGE_LAYOUT_STORAGE_KEY);
    return 'threads';
  } }), 'threads');
});
