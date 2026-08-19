import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LOGIN_MODE_STORAGE_KEY,
  clearLoginModePreference,
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

test('Cloud preferences ignore unusable and inaccessible storage implementations', () => {
  const unusable = {} as Storage;
  const inaccessible = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  } as unknown as Storage;

  for (const storage of [unusable, inaccessible]) {
    assert.equal(readLoginModePreference(storage), null);
    assert.doesNotThrow(() => writeLoginModePreference('login', storage));
    assert.doesNotThrow(() => clearLoginModePreference(storage));
  }
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
