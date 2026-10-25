import assert from 'node:assert/strict';
import test from 'node:test';
import { helpTopics, introduction, searchHelpTopics, contextualHelpTopic } from '../src/features/onboarding/helpContent';
import { helpProgressKey, readHelpProgress, saveHelpProgress, markHelpWelcome } from '../src/features/onboarding/helpProgress';
import { normalizePermission, permissionAction } from '../src/features/onboarding/permissionAccess';
import { consumeHelpGrounding, hasHelpGrounding, requestHelpGrounding } from '../src/features/onboarding/helpNavigation';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); }, key: (index) => [...values.keys()][index] ?? null };
}

test('help search finds setup, cards, social discovery, and permission recovery', () => {
  for (const [query, id] of [['api key', 'auth'], ['card sources', 'cards'], ['social qr', 'social'], ['microphone', 'media'], ['full disk', 'connectors'], ['calendar import', 'digest']]) {
    assert.ok(searchHelpTopics(query).some((topic) => topic.id === id), query);
  }
  assert.equal(searchHelpTopics('  ').length, helpTopics.length);
  assert.equal(searchHelpTopics('xyz-no-such-guide').length, 0);
  assert.equal(contextualHelpTopic('agents'), 'factory');
  assert.equal(contextualHelpTopic('agent-chats'), 'agents');
  for (const step of introduction) assert.ok(helpTopics.some((topic) => topic.id === step.topic));
});

test('progress is isolated by account and environment and tolerates damaged or unavailable storage', () => {
  const storage = memoryStorage();
  const first = helpProgressKey('user-a', 'http://127.0.0.1:18181');
  const second = helpProgressKey('user-b', 'http://127.0.0.1:18181');
  const otherEnvironment = helpProgressKey('user-a', 'http://127.0.0.1:17081');
  saveHelpProgress(first, { step: 3, completed: false, welcome: true }, storage);
  assert.equal(readHelpProgress(first, storage).step, 3);
  assert.deepEqual(readHelpProgress(second, storage), { step: 0, completed: false, welcome: false });
  assert.deepEqual(readHelpProgress(otherEnvironment, storage), { step: 0, completed: false, welcome: false });
  storage.setItem(first, '{');
  assert.equal(readHelpProgress(first, storage).step, 0);
  storage.setItem(first, '{"step":999,"completed":"true"}');
  assert.deepEqual(readHelpProgress(first, storage), { step: 4, completed: false, welcome: false });
  assert.equal(saveHelpProgress(first, { step: 1, completed: false, welcome: false }, null), false);
  assert.doesNotThrow(() => markHelpWelcome('test', 'loopback'));
});

test('permission recovery never offers another prompt for denied, restricted, or unknown access', () => {
  assert.equal(normalizePermission('default'), 'not-requested');
  assert.equal(normalizePermission('granted'), 'allowed');
  assert.equal(normalizePermission('new-native-value'), 'unknown');
  assert.equal(permissionAction('not-requested', true), 'Allow');
  assert.equal(permissionAction('denied', true), 'Open Settings');
  assert.equal(permissionAction('allowed', true), 'Open Settings');
  assert.equal(permissionAction('restricted', true), null);
  assert.equal(permissionAction('unavailable', true), null);
  assert.equal(permissionAction('unknown', true), 'Check again');
  assert.equal(permissionAction('denied', false), null);
});

test('Grounding navigation survives mounting and cannot cross into another account', () => {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: new EventTarget() });
  try {
    requestHelpGrounding('first-user');
    assert.equal(hasHelpGrounding('first-user'), true);
    assert.equal(hasHelpGrounding('first-user'), true, 'rendering twice must not consume the intent');
    assert.equal(consumeHelpGrounding('first-user'), true);
    assert.equal(hasHelpGrounding('first-user'), false);
    requestHelpGrounding('first-user');
    assert.equal(consumeHelpGrounding('second-user'), false);
    assert.equal(hasHelpGrounding('first-user'), false);
  } finally { Object.assign(globalThis, { window: previous }); }
});
