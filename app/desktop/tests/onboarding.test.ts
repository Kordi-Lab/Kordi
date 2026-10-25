import assert from 'node:assert/strict';
import test from 'node:test';
import { helpTourSteps } from '../src/features/onboarding/helpTourSteps';
import { HELP_TOUR_STEP_COUNT } from '../src/features/onboarding/helpProgress';
import { helpTourGeometry } from '../src/features/onboarding/helpTourGeometry';
import { helpProgressKey, readHelpProgress, saveHelpProgress, markHelpWelcome } from '../src/features/onboarding/helpProgress';
import { normalizePermission, permissionAction } from '../src/features/onboarding/permissionAccess';
import { consumeHelpGrounding, hasHelpGrounding, requestHelpGrounding } from '../src/features/onboarding/helpNavigation';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); }, key: (index) => [...values.keys()][index] ?? null };
}

test('the workspace tour covers setup, cards, social, conversations, Factory, Digest, and access', () => {
  assert.equal(helpTourSteps.length, HELP_TOUR_STEP_COUNT);
  assert.deepEqual(helpTourSteps.map((step) => step.target), ['settings-auth', 'grounding', 'nav-contacts', 'nav-chats', 'nav-agents', 'nav-digest', 'help']);
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
  assert.deepEqual(readHelpProgress(first, storage), { step: 6, completed: false, welcome: false });
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


test('coachmarks stay next to targets and within small viewports', () => {
  for (const width of [390, 900, 1440]) {
    for (const left of [10, width - 42]) {
      for (const top of [20, 620]) {
        const position = helpTourGeometry({ left, top, width: 32, height: 32 }, { width, height: 740 }, { width: 320, height: 270 });
        assert.ok(position.left >= 12 && position.left + 320 <= width - 12);
        assert.ok(position.top >= 12 && position.top + 270 <= 740 - 12);
        assert.notEqual(position.side, 'none');
      }
    }
  }
});
