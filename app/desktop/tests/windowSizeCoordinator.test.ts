import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWindowSizeCoordinator } from '../src/features/cloud/windowSizeCoordinator';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('rapid surface requests coalesce before native work starts', async () => {
  const calls: string[] = [];
  const resize = createWindowSizeCoordinator((surface: string) => {
    calls.push(surface);
    return Promise.resolve();
  });
  await Promise.all([resize('login'), resize('signup'), resize('main')]);
  assert.deepEqual(calls, ['main']);
  await resize('main');
  assert.deepEqual(calls, ['main'], 'StrictMode remount must not resize again');
});

test('a slow native resize cannot finish after the newest surface', async () => {
  const first = deferred();
  const calls: string[] = [];
  const resize = createWindowSizeCoordinator((surface: string) => {
    calls.push(surface);
    return calls.length === 1 ? first.promise : Promise.resolve();
  });
  const login = resize('login');
  await Promise.resolve();
  const signup = resize('signup');
  const main = resize('main');
  assert.deepEqual(calls, ['login']);
  first.resolve();
  await Promise.all([login, signup, main]);
  assert.deepEqual(calls, ['login', 'main']);
});

test('failed partial mutations do not poison retries or previous targets', async () => {
  let fail = false;
  const calls: string[] = [];
  const resize = createWindowSizeCoordinator((surface: string) => {
    calls.push(surface);
    return fail ? Promise.reject(new Error('Window closed')) : Promise.resolve();
  });
  await resize('login');
  fail = true;
  await assert.rejects(resize('main'), /Window closed/);
  fail = false;
  await resize('login');
  assert.deepEqual(calls, ['login', 'main', 'login']);
});
