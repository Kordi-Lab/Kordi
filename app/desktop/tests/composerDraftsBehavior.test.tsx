import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_COMPOSER_DRAFT_STATE,
  updateScopeDraft,
  parseStoredComposerDrafts,
  serializeStoredComposerDrafts,
  readStoredComposerDrafts,
  writeStoredComposerDrafts,
  COMPOSER_DRAFTS_STORAGE_KEY,
} from '../src/features/chat/composerDrafts';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem:    (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem:    (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('typing in chat A then switching active id to chat B leaves B empty and preserves A', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'hello A', 1000);

  // Switching the active id is a UI concern; the projection chooses which entry to display.
  const viewForA = state.chat['session-A']?.text ?? '';
  const viewForB = state.chat['session-B']?.text ?? '';
  assert.equal(viewForA, 'hello A');
  assert.equal(viewForB, '');

  // Switch back: A still has its draft.
  assert.equal(state.chat['session-A']?.text ?? '', 'hello A');
});

test('sending in A clears A but leaves B untouched', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'hello A', 1000);
  state = updateScopeDraft(state, 'chat', 'session-B', 'hello B', 1500);

  // Send-clear for A:
  state = updateScopeDraft(state, 'chat', 'session-A', '', 2000);

  assert.equal(state.chat['session-A'], undefined);
  assert.equal(state.chat['session-B']?.text ?? '', 'hello B');
});

test('drafts survive a write/read round-trip via storage helpers', () => {
  const storage = fakeStorage();
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'persistent draft', 1000);

  writeStoredComposerDrafts(state, storage);
  const restored = readStoredComposerDrafts(storage, 1500);

  assert.deepEqual(restored, state);
});

test('manual clear (deleting all text) deletes the entry from storage on the next write', () => {
  const storage = fakeStorage();
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'will be deleted', 1000);
  writeStoredComposerDrafts(state, storage);
  assert.ok(storage.data.has(COMPOSER_DRAFTS_STORAGE_KEY));

  state = updateScopeDraft(state, 'chat', 'session-A', '', 2000);
  writeStoredComposerDrafts(state, storage);
  // Both scopes empty → storage key is removed:
  assert.equal(storage.data.has(COMPOSER_DRAFTS_STORAGE_KEY), false);
});

test('project scope mirrors chat scope behavior', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'project', 'project-session-A', 'project text', 1000);
  state = updateScopeDraft(state, 'project', 'project-session-B', 'other project text', 1500);

  state = updateScopeDraft(state, 'project', 'project-session-A', '', 2000);
  assert.equal(state.project['project-session-A'], undefined);
  assert.equal(state.project['project-session-B']?.text ?? '', 'other project text');
});

test('serialization round-trips an arbitrary state', () => {
  const state = updateScopeDraft(
    updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-A', 'A', 1000),
    'project', 'project-A', 'P', 2000,
  );
  assert.deepEqual(parseStoredComposerDrafts(serializeStoredComposerDrafts(state)), state);
});

test('prune-on-delete removes the entry for a session', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'leftover', 1000);
  state = updateScopeDraft(state, 'chat', 'session-B', 'untouched', 1500);

  // Simulate the prune that runs on optimisticallyRemoveChatSession:
  state = updateScopeDraft(state, 'chat', 'session-A', '', 2000);

  assert.equal(state.chat['session-A'], undefined);
  assert.equal(state.chat['session-B']?.text ?? '', 'untouched');
});
