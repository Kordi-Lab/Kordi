import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { ProjectImportDialog } from '../src/features/projects/ProjectImportDialog';
import { githubRepositoryFromInput, type ProjectImportApi } from '../src/features/projects/projectImportApi';

test('repository parser accepts GitHub forms and rejects credentials, other hosts and traversal', () => {
  for (const value of ['team/repo', 'https://github.com/team/repo.git', 'git@github.com:team/repo.git']) assert.equal(githubRepositoryFromInput(value), 'team/repo');
  for (const value of ['../repo', 'team/..', 'https://evil.example/team/repo', 'https://secret@github.com/team/repo', 'team/repo?token=x', 'team/-option']) assert.equal(githubRepositoryFromInput(value), null);
});

for (const mode of ['default', 'chosen', 'canceled', 'local'] as const) {
  test(`project creation supports the ${mode} folder flow and retries activation without recreating`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
    const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) };
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(document.getElementById('root')!);
    let creations = 0; let attempts = 0; let closed = false; let choices = 0;
    const api: ProjectImportApi = {
      chooseFolder: async () => { choices += 1; return mode === 'canceled' ? null : '/fixture/workspaces'; },
      create: async (name, parentDir) => {
        assert.notEqual(mode, 'local');
        assert.equal(name, 'My project');
        assert.equal(parentDir, mode === 'chosen' ? '/fixture/workspaces' : undefined);
        creations += 1;
        return { root: '/fixture/my-project', name };
      },
      addLocal: async (path) => {
        assert.equal(mode, 'local'); assert.equal(path, '/fixture/workspaces'); creations += 1;
        return { root: path, name: 'workspaces' };
      },
      repositories: async () => { throw new Error('Unexpected repository request'); },
      clone: async () => { throw new Error('Unexpected clone'); },
    };
    const click = async (label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.includes(label));
      assert(button, `Button ${label} exists`);
      await act(async () => button.click());
    };
    try {
      await act(async () => root.render(createElement(ProjectImportDialog, { api, onClose: () => { closed = true; }, onImported: async (project) => {
        assert.equal(project.root, mode === 'local' ? '/fixture/workspaces' : '/fixture/my-project');
        attempts += 1;
        if (attempts === 1) throw new Error('Session is busy');
      } })));
      await click(mode === 'local' ? 'Open local folder' : 'New project');
      assert.equal(document.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled, true);
      if (mode !== 'local') {
        const input = document.querySelector<HTMLInputElement>('input[required]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '  My project  ');
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        });
      }
      if (mode !== 'default') await click('Choose folder');
      assert.equal(choices, mode === 'default' ? 0 : 1);
      if (mode === 'canceled') assert.equal(document.querySelector<HTMLInputElement>('input:not([required])')?.value, '');
      assert.equal(document.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled, false);
      await act(async () => document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Session is busy');
      assert.equal(closed, false);
      assert([...document.querySelectorAll<HTMLInputElement>('input')].every((input) => input.disabled));
      await click('Retry opening project');
      assert.equal(creations, 1);
      assert.equal(attempts, 2);
      assert.equal(closed, true);
    } finally {
      await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
}

test('a successfully cloned project is reused when session activation must be retried', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  let clones = 0; let attempts = 0; let closed = false;
  const api: ProjectImportApi = {
    create: async () => { throw new Error('Unexpected project creation'); },
    chooseFolder: async () => null, addLocal: async () => { throw new Error('Unexpected local import'); },
    repositories: async () => ({ hasMore: false, repositories: [{ fullName: 'team/repo', description: null, language: null, private: true }] }),
    clone: async (repository) => { assert.equal(repository, 'team/repo'); clones += 1; return { root: '/fixture/repo', name: 'repo' }; },
  };
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.includes(label));
    assert(button, `Button ${label} exists`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(ProjectImportDialog, { api, onClose: () => { closed = true; }, onImported: async (project) => {
      assert.equal(project.root, '/fixture/repo'); attempts += 1;
      if (attempts === 1) throw new Error('Session is busy');
    } })));
    await click('Clone from GitHub');
    await click('team/repo');
    await click('Add project');
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Session is busy');
    assert.equal(closed, false);
    await click('Retry opening project');
    assert.equal(clones, 1);
    assert.equal(attempts, 2);
    assert.equal(closed, true);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
