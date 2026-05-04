import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_COMPOSER_DRAFT_STATE,
  updateScopeDraft,
  parseStoredComposerDrafts,
  serializeStoredComposerDrafts,
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
