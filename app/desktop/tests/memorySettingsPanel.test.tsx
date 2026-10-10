import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemorySettingsPanel } from '../src/features/memory/MemorySettingsPanel';
import {
  createPreviewMemoryClient,
  memoryClientForEnvironment,
  memoryClientForFlag,
  memorySectionAvailable,
  type MemoryClient,
} from '../src/features/memory/memoryClient';
import {
  LESSON_MAX_CHARS,
  forgetConsequences,
  isGlobalMemory,
  lessonSourceLabel,
  validateLessonText,
  type MemoryLesson,
} from '../src/features/memory/memoryModel';
import { settingsSections } from '../src/kordi-app/data/settings';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { CloudAccountSettingsDialog } from '../src/pages/CloudAccountSettingsDialog';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  // react-dom loads before this DOM exists, so it falls back to the legacy input event polyfill.
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => undefined },
    detachEvent: { configurable: true, value: () => undefined },
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

function sampleLesson(overrides: Partial<MemoryLesson>): MemoryLesson {
  return {
    lessonId: 'lesson',
    scope: 'conversation',
    scopeId: 'scope',
    scopeLabel: 'Scope',
    source: 'manual',
    text: 'Sample memory text.',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

test('only global memories count as global', () => {
  assert.equal(isGlobalMemory(sampleLesson({ scope: 'global', scopeId: 'account' })), true);
  for (const scope of ['conversation', 'group', 'project'] as const) {
    assert.equal(isGlobalMemory(sampleLesson({ scope })), false);
  }
});

test('memory text is normalized and limited', () => {
  assert.deepEqual(validateLessonText('  Keep   it\n short. '), { ok: true, text: 'Keep it short.' });
  assert.deepEqual(validateLessonText('   '), { ok: false, reason: 'Enter a memory.' });
  assert.equal(validateLessonText('a'.repeat(LESSON_MAX_CHARS)).ok, true);
  assert.deepEqual(validateLessonText(''), { ok: false, reason: 'Enter a memory.' });
  assert.deepEqual(validateLessonText('a'.repeat(LESSON_MAX_CHARS + 1)), { ok: false, reason: 'Memories are 500 characters or fewer.' });
});

test('source labels and forget copy read plainly', () => {
  assert.equal(lessonSourceLabel('user_correction'), 'From a correction');
  assert.equal(lessonSourceLabel('repeated_failure'), 'From a repeated failure');
  assert.equal(lessonSourceLabel('outcome'), 'From an outcome');
  assert.equal(lessonSourceLabel('manual'), 'Added by hand');
  assert.equal(
    forgetConsequences(7),
    'This deletes 7 memories from your account and every signed-in device. It cannot be undone.',
  );
  assert.equal(
    forgetConsequences(1),
    'This deletes 1 memory from your account and every signed-in device. It cannot be undone.',
  );
});

test('preview memories are short, varied, and free of em-dashes', async () => {
  const lessons = await createPreviewMemoryClient({ latencyMs: 0 }).listLessons();
  assert.equal(lessons.length, 9);
  assert.deepEqual(lessons.filter(isGlobalMemory).map((lesson) => lesson.lessonId), ['lesson-8', 'lesson-9']);
  assert.deepEqual(new Set(lessons.map((lesson) => lesson.source)).size, 4);
  for (const lesson of lessons) {
    assert.ok(lesson.text.length >= 60 && lesson.text.length <= 220, lesson.text);
    assert.doesNotMatch(lesson.text, /\u2014/);
  }
});

test('the preview client only comes from the preview flag', () => {
  assert.equal(memoryClientForFlag(undefined), null);
  assert.equal(memoryClientForFlag('0'), null);
  assert.notEqual(memoryClientForFlag('1'), null);
  assert.notEqual(memoryClientForFlag('true'), null);
});

test('without the preview flag the environment uses the account memory client', async () => {
  const client = memoryClientForEnvironment();
  assert.notEqual(client, null);
  assert.equal(memoryClientForEnvironment(), client);
  // The account client reads no sample data: signed out outside the native shell it lists nothing.
  assert.deepEqual(await client.listLessons(), []);
  assert.deepEqual(await client.syncState(), { accountLabel: '', lastSyncedAt: null });
});

test('the Memory section needs the server memory version', () => {
  assert.equal(memorySectionAvailable(undefined), false);
  assert.equal(memorySectionAvailable(null), false);
  assert.equal(memorySectionAvailable(0), false);
  assert.equal(memorySectionAvailable(1), true);
});

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(element: Element | null | undefined, window: JSDOM['window']) {
  assert.ok(element, 'expected an element to click');
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await flush();
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text);
}

async function withPanel(
  client: MemoryClient,
  run: (host: HTMLElement, window: JSDOM['window']) => Promise<void>,
) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<MemorySettingsPanel accountId="account-1" client={client} isNativeShell />);
    });
    await flush();
    await run(host, installed.dom.window);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

test('panel lists only global memories and points to the conversation tabs for the rest', async () => {
  await withPanel(createPreviewMemoryClient({ latencyMs: 0 }), async (host) => {
    const headings = Array.from(host.querySelectorAll('h2')).map((heading) => heading.textContent);
    assert.ok(headings.includes('Global memories · 2'));
    assert.equal(headings.some((heading) => ['Conversations', 'Projects', 'Groups'].includes(heading ?? '')), false);
    assert.deepEqual(
      Array.from(host.querySelectorAll('[data-memory-lesson]')).map((row) => row.getAttribute('data-memory-lesson')),
      ['lesson-8', 'lesson-9'],
    );
    assert.doesNotMatch(host.querySelector('[data-memory-lesson="lesson-8"]')?.textContent ?? '', /Global/);
    assert.match(host.textContent ?? '', /Other memories are on each conversation's Memory tab\./);
    assert.doesNotMatch(host.textContent ?? '', /[Rr]eplay/);
    assert.match(host.textContent ?? '', /Bridge conversation memory/);
  });
});

test('turning memory off saves the setting and explains the kept memories', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  const patches: unknown[] = [];
  const updateSettings = client.updateSettings.bind(client);
  client.updateSettings = async (patch) => {
    patches.push(patch);
    return updateSettings(patch);
  };
  await withPanel(client, async (host, window) => {
    assert.doesNotMatch(host.textContent ?? '', /kept but not read/);
    await click(host.querySelector('[aria-label="Let Kordi save memories"]'), window);
    assert.deepEqual(patches, [{ lessonsEnabled: false }]);
    assert.equal(host.querySelector('[aria-label="Let Kordi save memories"]')?.getAttribute('aria-checked'), 'false');
    assert.match(host.textContent ?? '', /Memory is off\. These are kept but not read\./);
  });
});

test('editing past the limit shows the error without saving', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  let updates = 0;
  const updateLesson = client.updateLesson.bind(client);
  client.updateLesson = async (lessonId, text) => {
    updates += 1;
    return updateLesson(lessonId, text);
  };
  await withPanel(client, async (host, window) => {
    await click(host.querySelector('[data-memory-lesson="lesson-8"] button[aria-label^="Edit memory"]'), window);
    const textarea = host.querySelector<HTMLTextAreaElement>('[data-memory-lesson="lesson-8"] textarea');
    assert.ok(textarea);
    const type = async (value: string) => {
      await act(async () => {
        textarea.focus();
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
        textarea.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
      });
    };
    await type('a'.repeat(501));
    assert.match(host.textContent ?? '', /501 \/ 500/);
    await click(buttonByText(host, 'Save'), window);
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? '', /Memories are 500 characters or fewer\./);
    assert.equal(updates, 0);

    await type('Keep launch headlines short and in sentence case.');
    await click(buttonByText(host, 'Save'), window);
    assert.equal(updates, 1);
    assert.equal(host.querySelector('textarea'), null);
    assert.match(host.textContent ?? '', /Keep launch headlines short and in sentence case\./);
  });
});

test('deleting a memory asks first, then removes the row', async () => {
  await withPanel(createPreviewMemoryClient({ latencyMs: 0 }), async (host, window) => {
    await click(host.querySelector('[data-memory-lesson="lesson-9"] button[aria-label^="Delete memory"]'), window);
    assert.match(document.body.textContent ?? '', /Delete this memory\?/);
    assert.match(document.body.textContent ?? '', /Kordi will not read it again on any device\. This cannot be undone\./);
    const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]') ?? document.body;
    await click(buttonByText(dialog, 'Delete'), window);
    assert.equal(host.querySelector('[data-memory-lesson="lesson-9"]'), null);
    assert.equal(host.querySelectorAll('[data-memory-lesson]').length, 1);
    assert.match(host.textContent ?? '', /Global memories · 1/);
    assert.doesNotMatch(document.body.textContent ?? '', /Delete this memory\?/);
  });
});

test('forget everything leaves the empty state', async () => {
  await withPanel(createPreviewMemoryClient({ latencyMs: 0 }), async (host, window) => {
    await click(buttonByText(host, 'Forget everything'), window);
    assert.match(document.body.textContent ?? '', /Forget all memories\?/);
    // Forget everything still clears every scope, not only the listed global memories.
    assert.match(document.body.textContent ?? '', /This deletes 9 memories from your account and every signed-in device/);
    const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]');
    assert.ok(dialog);
    await click(buttonByText(dialog, 'Forget everything'), window);
    assert.equal(host.querySelectorAll('[data-memory-lesson]').length, 0);
    assert.match(host.textContent ?? '', /No global memories yet\./);
    assert.match(host.textContent ?? '', /Global memories · 0/);
    assert.equal(buttonByText(host, 'Forget everything'), undefined);
  });
});

test('sync status names the account', async () => {
  await withPanel(createPreviewMemoryClient({ latencyMs: 0 }), async (host) => {
    assert.match(host.textContent ?? '', /Synced with taylor@memory\.example/);
    assert.match(host.textContent ?? '', /2 minutes ago/);
    assert.doesNotMatch(host.textContent ?? '', /Kordi saves short memories/);
  });
});

const account: CloudAccount = {
  accountId: 'acct_memory_test',
  kordiId: '517309264',
  displayName: 'Taylor Preview',
  primaryEmail: 'taylor@memory.example',
  avatarUrl: null,
  avatar: {
    entityType: 'human',
    entityId: 'acct_memory_test',
    source: 'generated',
    style: 'lorelei',
    seed: 'memory_test_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 1,
    updatedAt: '2026-10-01T00:00:00Z',
  },
  nodeId: 'node-memory-test',
  passwordSet: false,
};

async function navLabels(memoryClient: MemoryClient | null): Promise<string[]> {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => undefined;
  const resolved = async () => undefined;
  try {
    await act(async () => {
      root.render(
        <CloudAccountSettingsDialog
          isOpen
          account={account}
          onClose={noop}
          onUpdateProfile={resolved}
          memoryClient={memoryClient}
          settingsSections={settingsSections}
          activeSettingsSectionId="auth"
          setActiveSettingsSectionId={noop}
          authSettingsLayoutWidth={620}
          isNativeShell={false}
          desktopAuthState={null}
          isDesktopAuthLoading={false}
          desktopAuthError={null}
          activeLoginProviderId={null}
          selectAuthProvider={noop}
          openLoginFlow={noop}
          refreshDesktopAuth={resolved}
          handleSelectAuthChoice={resolved}
          handleRemoveAuthProfile={resolved}
          handleLogoutProvider={resolved}
          themeMode="dark"
          setThemeMode={noop}
        />,
      );
    });
    const nav = document.body.querySelector('nav[aria-label="Settings"]');
    assert.ok(nav);
    return Array.from(nav.querySelectorAll('button')).map((button) => button.textContent?.trim() ?? '');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

test('account settings show Memory only when a client is available', async () => {
  assert.deepEqual(await navLabels(null), ['Profile', 'Active sessions', 'Authentication', 'Notifications', 'Appearance']);
  assert.deepEqual(
    await navLabels(createPreviewMemoryClient({ latencyMs: 0 })),
    ['Profile', 'Active sessions', 'Authentication', 'Notifications', 'Memory', 'Appearance'],
  );
});
