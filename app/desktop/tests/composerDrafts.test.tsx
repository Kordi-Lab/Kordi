import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_COMPOSER_DRAFT_STATE,
  updateScopeDraft,
  parseStoredComposerDrafts,
  serializeStoredComposerDrafts,
  COMPOSER_DRAFTS_STORAGE_KEY,
  COMPOSER_DRAFT_TTL_MS,
  COMPOSER_DRAFT_SCOPE_CAP,
  readStoredComposerDrafts,
  writeStoredComposerDrafts,
} from '../src/features/chat/composerDrafts';

test('updateScopeDraft inserts a new entry with text and timestamp', () => {
  const next = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  assert.deepEqual(next.chat['session-a'], { text: 'hello', updatedAt: 1000 });
  assert.deepEqual(next.project, {});
});

test('updateScopeDraft updates an existing entry and bumps the timestamp', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  const next = updateScopeDraft(seeded, 'chat', 'session-a', 'hello world', 2000);
  assert.deepEqual(next.chat['session-a'], { text: 'hello world', updatedAt: 2000 });
});

test('updateScopeDraft is a no-op when the value did not change', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  const next = updateScopeDraft(seeded, 'chat', 'session-a', 'hello', 9999);
  assert.equal(next, seeded);
});

test('updateScopeDraft deletes the entry when the value is empty', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  const next = updateScopeDraft(seeded, 'chat', 'session-a', '', 2000);
  assert.equal('session-a' in next.chat, false);
});

test('updateScopeDraft empty-on-missing is a no-op (returns same reference)', () => {
  const next = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', '', 1000);
  assert.equal(next, EMPTY_COMPOSER_DRAFT_STATE);
});

test('updateScopeDraft scopes are independent', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'chat-text', 1000);
  const next = updateScopeDraft(seeded, 'project', 'session-a', 'project-text', 2000);
  assert.deepEqual(next.chat['session-a'], { text: 'chat-text', updatedAt: 1000 });
  assert.deepEqual(next.project['session-a'], { text: 'project-text', updatedAt: 2000 });
});

test('updateScopeDraft ignores empty session ids', () => {
  const next = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', '', 'hello', 1000);
  assert.equal(next, EMPTY_COMPOSER_DRAFT_STATE);
});

test('parseStoredComposerDrafts returns the empty state for invalid input', () => {
  for (const raw of [null, undefined, '', 'not json', '[]', '{"chat": "wrong"}']) {
    assert.deepEqual(parseStoredComposerDrafts(raw), { chat: {}, project: {} });
  }
});

test('parseStoredComposerDrafts drops malformed entries but keeps valid ones', () => {
  const raw = JSON.stringify({
    chat: {
      good:  { text: 'ok', updatedAt: 1000 },
      blank: { text: '', updatedAt: 1000 },
      bad1:  { text: 42, updatedAt: 1000 },
      bad2:  { text: 'ok', updatedAt: 'soon' },
      bad3:  { text: 'ok', updatedAt: Number.NaN },
    },
    project: {},
  });
  const parsed = parseStoredComposerDrafts(raw);
  assert.deepEqual(parsed.chat, { good: { text: 'ok', updatedAt: 1000 } });
  assert.deepEqual(parsed.project, {});
});

test('serializeStoredComposerDrafts round-trips a valid state', () => {
  const state = {
    chat:    { 'session-a': { text: 'hello', updatedAt: 1000 } },
    project: { 'session-b': { text: 'world', updatedAt: 2000 } },
  };
  const json = serializeStoredComposerDrafts(state);
  assert.deepEqual(parseStoredComposerDrafts(json), state);
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem:    (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem:    (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('readStoredComposerDrafts drops entries older than the TTL', () => {
  const now = 1_700_000_000_000;
  const fresh = now - 1000;
  const stale = now - COMPOSER_DRAFT_TTL_MS - 1;
  const storage = fakeStorage({
    [COMPOSER_DRAFTS_STORAGE_KEY]: JSON.stringify({
      chat: {
        fresh: { text: 'fresh', updatedAt: fresh },
        stale: { text: 'stale', updatedAt: stale },
      },
      project: {},
    }),
  });
  const result = readStoredComposerDrafts(storage, now);
  assert.deepEqual(Object.keys(result.chat), ['fresh']);
});

test('readStoredComposerDrafts caps each scope to COMPOSER_DRAFT_SCOPE_CAP, keeping the most recent', () => {
  const now = 1_700_000_000_000;
  const overflow = COMPOSER_DRAFT_SCOPE_CAP + 50;
  const chat: Record<string, { text: string; updatedAt: number }> = {};
  for (let i = 0; i < overflow; i++) {
    chat[`session-${i}`] = { text: `text ${i}`, updatedAt: now - (overflow - i) };
  }
  const storage = fakeStorage({
    [COMPOSER_DRAFTS_STORAGE_KEY]: JSON.stringify({ chat, project: {} }),
  });
  const result = readStoredComposerDrafts(storage, now);
  assert.equal(Object.keys(result.chat).length, COMPOSER_DRAFT_SCOPE_CAP);
  assert.equal(`session-${overflow - 1}` in result.chat, true);
  assert.equal(`session-0` in result.chat, false);
});

test('writeStoredComposerDrafts removes the storage key when both scopes are empty', () => {
  const storage = fakeStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: 'leftover' });
  writeStoredComposerDrafts({ chat: {}, project: {} }, storage);
  assert.equal(storage.data.has(COMPOSER_DRAFTS_STORAGE_KEY), false);
});

test('writeStoredComposerDrafts persists a non-empty state', () => {
  const storage = fakeStorage();
  writeStoredComposerDrafts(
    { chat: { 'session-a': { text: 'hi', updatedAt: 1000 } }, project: {} },
    storage,
  );
  const json = storage.data.get(COMPOSER_DRAFTS_STORAGE_KEY);
  assert.ok(json, 'expected storage to contain the key');
  assert.deepEqual(JSON.parse(json), {
    chat:    { 'session-a': { text: 'hi', updatedAt: 1000 } },
    project: {},
  });
});

test('readStoredComposerDrafts returns the empty state when storage is null', () => {
  assert.deepEqual(readStoredComposerDrafts(null, 1_700_000_000_000), { chat: {}, project: {} });
});

test('writeStoredComposerDrafts is a no-op when storage is null', () => {
  // Should not throw.
  writeStoredComposerDrafts({ chat: { 'session-a': { text: 'hi', updatedAt: 1000 } }, project: {} }, null);
});
