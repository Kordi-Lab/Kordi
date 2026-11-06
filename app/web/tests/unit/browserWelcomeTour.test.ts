import assert from 'node:assert/strict';
import test from 'node:test';

import { takeBrowserWelcomeLink } from '@web/app/browserWelcomeLink';
import { helpTourAvailable, helpTourStepAvailable, helpTourStepBody, helpTours, helpTourSteps } from '@/features/onboarding/helpTourSteps';
import { helpProgressKey, markHelpWelcome, readHelpProgress } from '@/features/onboarding/helpProgress';

function fakeWindow(href: string, state: unknown = { kordiWorkspace: true }) {
  const replaced: { state: unknown; url: string }[] = [];
  const browser = {
    location: { href } as Location,
    history: {
      state,
      replaceState(nextState: unknown, _title: string, url: string) {
        replaced.push({ state: nextState, url });
        browser.location = { href: new URL(url, href).href } as Location;
      },
    } as unknown as History,
  };
  return { browser, replaced };
}

test('a new account link is read once and removed without touching the route, other queries, or history state', () => {
  const { browser, replaced } = fakeWindow('https://app.kordi.test/app/chats?welcome=1&ref=invite#composer');
  assert.equal(takeBrowserWelcomeLink(browser), true);
  assert.deepEqual(replaced, [{ state: { kordiWorkspace: true }, url: '/app/chats?ref=invite#composer' }]);
  assert.equal(takeBrowserWelcomeLink(browser), false, 'a reload does not repeat the welcome');
  assert.equal(replaced.length, 1);
});

test('a returning sign-in or another welcome value never starts first-run help', () => {
  const plain = fakeWindow('https://app.kordi.test/app/');
  assert.equal(takeBrowserWelcomeLink(plain.browser), false);
  assert.equal(plain.replaced.length, 0);
  const other = fakeWindow('https://app.kordi.test/app/?welcome=yes');
  assert.equal(takeBrowserWelcomeLink(other.browser), false);
  assert.deepEqual(other.replaced.map(({ url }) => url), ['/app/'], 'an unusable value is still cleared');
});

test('the welcome link marks the same first-run progress as a desktop sign-up', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const { browser } = fakeWindow('https://app.kordi.test/app/?welcome=1');
    if (takeBrowserWelcomeLink(browser)) markHelpWelcome('acct_new', 'https://app.kordi.test');
    const key = helpProgressKey('acct_new', 'https://app.kordi.test');
    assert.equal(readHelpProgress(key, storage as unknown as Storage).welcome, true);
    assert.equal(readHelpProgress(helpProgressKey('acct_other', 'https://app.kordi.test'), storage as unknown as Storage).welcome, false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('the browser tour keeps every step, with file import worded for the upload flow', () => {
  assert.ok(helpTourSteps.every((step) => helpTourStepAvailable(step, true)), 'the browser tour shows every step');
  assert.ok(helpTourSteps.every((step) => helpTourStepAvailable(step, false)), 'the desktop tour is unchanged');
  for (const id of ['workspace', 'grounding', 'cards', 'imports'] as const) {
    assert.equal(helpTourAvailable(id, true), true);
    assert.equal(helpTourAvailable(id, false), true);
  }
  const files = helpTours.imports.find((step) => step.target === 'memory-import-files')!;
  assert.match(helpTourStepBody(files, true), /Choose files/);
  assert.doesNotMatch(helpTourStepBody(files, true), /detected/);
  assert.match(helpTourStepBody(files, false), /detected files/);
  const run = helpTours.imports.find((step) => step.target === 'memory-import-run')!;
  assert.equal(helpTourStepBody(run, true), run.body, 'the server model extracts memories as the Mac does');
});

test('the browser tour does not promise Mac-only calendar access', () => {
  const help = helpTours.workspace.find((step) => step.target === 'help')!;
  assert.match(helpTourStepBody(help, false), /calendar/);
  assert.doesNotMatch(helpTourStepBody(help, true), /calendar/);
  const chats = helpTours.workspace.find((step) => step.target === 'nav-chats')!;
  assert.equal(helpTourStepBody(chats, true), chats.body);
});
