import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AVATAR_PREFERENCE_STORAGE_KEY,
  AVATAR_UPLOAD_MAX_BYTES,
  clearAvatarPreference,
  readAvatarPreference,
  writeAvatarPreference,
} from '../src/features/cloud/avatarPreference';
import {
  LOGIN_MODE_STORAGE_KEY,
  readLoginModePreference,
  writeLoginModePreference,
} from '../src/features/cloud/loginModePreference';

function makeStorageStub(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

test('avatarPreference clears legacy seed entries instead of restoring random avatars', () => {
  const storage = makeStorageStub();
  storage.setItem(AVATAR_PREFERENCE_STORAGE_KEY, JSON.stringify({ kind: 'seed', seed: 'cloud-signup:abc' }));

  assert.equal(readAvatarPreference(storage), null);
  assert.equal(storage.getItem(AVATAR_PREFERENCE_STORAGE_KEY), null);
});

test('avatarPreference round-trips a small upload data URL', () => {
  const storage = makeStorageStub();
  const dataUrl = `data:image/jpeg;base64,${'A'.repeat(64)}`;
  const written = writeAvatarPreference({ kind: 'upload', dataUrl }, storage);
  assert.equal(written, true);

  const restored = readAvatarPreference(storage);
  assert.deepEqual(restored, { kind: 'upload', dataUrl });
});

test('avatarPreference rejects oversized uploads without writing', () => {
  const storage = makeStorageStub();
  const oversizedPayload = 'A'.repeat(Math.ceil((AVATAR_UPLOAD_MAX_BYTES + 1) * 4 / 3));
  const dataUrl = `data:image/jpeg;base64,${oversizedPayload}`;
  const written = writeAvatarPreference({ kind: 'upload', dataUrl }, storage);
  assert.equal(written, false);
  assert.equal(storage.getItem(AVATAR_PREFERENCE_STORAGE_KEY), null);
});

test('avatarPreference rejects legacy seed writes', () => {
  const storage = makeStorageStub();
  const written = writeAvatarPreference({ kind: 'seed', seed: 'cloud-signup:abc' } as never, storage);
  assert.equal(written, false);
  assert.equal(storage.getItem(AVATAR_PREFERENCE_STORAGE_KEY), null);
});

test('avatarPreference clears malformed JSON and returns null', () => {
  const storage = makeStorageStub();
  storage.setItem(AVATAR_PREFERENCE_STORAGE_KEY, '{not json');
  const restored = readAvatarPreference(storage);
  assert.equal(restored, null);
  assert.equal(storage.getItem(AVATAR_PREFERENCE_STORAGE_KEY), null);
});

test('avatarPreference clears entries that fail validation', () => {
  const storage = makeStorageStub();
  storage.setItem(
    AVATAR_PREFERENCE_STORAGE_KEY,
    JSON.stringify({ kind: 'upload', dataUrl: 'not-a-data-url' }),
  );
  const restored = readAvatarPreference(storage);
  assert.equal(restored, null);
  assert.equal(storage.getItem(AVATAR_PREFERENCE_STORAGE_KEY), null);
});

test('clearAvatarPreference removes the stored value', () => {
  const storage = makeStorageStub();
  writeAvatarPreference({ kind: 'upload', dataUrl: 'data:image/jpeg;base64,abc' }, storage);
  clearAvatarPreference(storage);
  assert.equal(storage.getItem(AVATAR_PREFERENCE_STORAGE_KEY), null);
});

test('avatarPreference returns null when no storage is available', () => {
  // No global localStorage in node:test — call with undefined explicitly.
  assert.equal(readAvatarPreference(undefined), null);
  assert.equal(writeAvatarPreference({ kind: 'upload', dataUrl: 'data:image/jpeg;base64,abc' }, undefined), false);
});

test('loginModePreference round-trips login and signup', () => {
  const storage = makeStorageStub();
  writeLoginModePreference('signup', storage);
  assert.equal(readLoginModePreference(storage), 'signup');
  writeLoginModePreference('login', storage);
  assert.equal(readLoginModePreference(storage), 'login');
});

test('loginModePreference clears unknown values', () => {
  const storage = makeStorageStub();
  storage.setItem(LOGIN_MODE_STORAGE_KEY, 'bogus');
  assert.equal(readLoginModePreference(storage), null);
  assert.equal(storage.getItem(LOGIN_MODE_STORAGE_KEY), null);
});
