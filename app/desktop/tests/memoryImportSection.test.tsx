import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import type { MemoryImportSave, MemoryImporter } from '../src/features/memory/memoryImport';
import { createPreviewMemoryImporter } from '../src/features/memory/memoryImportClient';
import { MemoryImportSection } from '../src/features/memory/MemoryImportSection';
import type { MemoryLesson } from '../src/features/memory/memoryModel';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
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
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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

async function render(element: React.ReactElement) {
  const env = installDom();
  const container = env.dom.window.document.createElement('div');
  env.dom.window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    container,
    async cleanup() {
      await act(async () => { root.unmount(); });
      env.restore();
    },
  };
}

const button = (container: HTMLElement, name: string) => Array.from(container.querySelectorAll('button')).find((element) => element.textContent === name);
const importButton = (container: HTMLElement) => button(container, 'Import');

test('importing agent files saves new memories per file and reports the total', async () => {
  const saves: MemoryImportSave[] = [];
  let imported = 0;
  const existing = [{ text: 'use pnpm for every script in this repository.' }] as Pick<MemoryLesson, 'text'>[];
  const view = await render(
    <MemoryImportSection
      client={{ importLesson: async (save) => { saves.push(save); return {} as MemoryLesson; } }}
      importer={createPreviewMemoryImporter({ latencyMs: 0, now: () => Date.parse('2026-10-20T10:00:00Z') })}
      lessons={existing}
      providerReady
      onImported={() => { imported += 1; }}
    />,
  );
  try {
    const text = () => view.container.textContent ?? '';
    assert.match(text(), /Import/);
    assert.match(text(), /launch-site/);
    assert.match(text(), /AGENTS\.md · 4 KB/);
    assert.match(text(), /Home/);
    assert.deepEqual(Array.from(view.container.querySelectorAll('[data-memory-import-source]'), (group) => group.getAttribute('data-memory-import-source')), ['Claude Code', 'Project file']);
    assert.equal(view.container.querySelectorAll('input[type="checkbox"]:checked').length, 2);
    await act(async () => { importButton(view.container)?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.deepEqual(saves, [{
      scope: 'project',
      scopeId: '/sample/Projects/launch-site',
      scopeLabel: 'launch-site',
      source: 'import',
      text: 'Run the image size check before every site build.',
      category: 'hcp-custom:task_lessons',
    }], 'the repeat of an existing memory is skipped');
    assert.match(text(), /Imported 1 memory/);
    assert.match(text(), /Nothing new/);
    assert.match(text(), /Imported 1 memory\./);
    assert.equal(imported, 1);
  } finally {
    await view.cleanup();
  }
});

test('without a provider the import cannot start; without files the section says so', async () => {
  const noProvider = await render(
    <MemoryImportSection client={{ importLesson: async () => ({}) as MemoryLesson }} importer={createPreviewMemoryImporter({ latencyMs: 0 })} lessons={[]} providerReady={false} onImported={() => undefined} />,
  );
  try {
    assert.match(noProvider.container.textContent ?? '', /No provider configured yet\./);
    assert.equal(importButton(noProvider.container)?.disabled, true);
  } finally {
    await noProvider.cleanup();
  }
  const emptyImporter: MemoryImporter = { discover: async () => [], extract: async () => '{}' };
  const empty = await render(
    <MemoryImportSection client={{ importLesson: async () => ({}) as MemoryLesson }} importer={emptyImporter} lessons={[]} providerReady onImported={() => undefined} />,
  );
  try {
    assert.match(empty.container.textContent ?? '', /No agent files found\.Finds instructions and memories from your coding agents\./);
    assert.equal(importButton(empty.container), undefined);
  } finally {
    await empty.cleanup();
  }
});

test('chosen files join the list checked, once, and import into their folder', async () => {
  const saves: MemoryImportSave[] = [];
  const view = await render(
    <MemoryImportSection
      client={{ importLesson: async (save) => { saves.push(save); return {} as MemoryLesson; } }}
      importer={createPreviewMemoryImporter({ latencyMs: 0 })}
      lessons={[]}
      providerReady
      onImported={() => undefined}
    />,
  );
  try {
    const checkboxes = () => Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    await act(async () => { button(view.container, 'Choose files…')?.click(); });
    assert.deepEqual(checkboxes().map((box) => [box.getAttribute('aria-label'), box.checked]), [
      ['Home .claude/CLAUDE.md', true],
      ['launch-site AGENTS.md', true],
      ['Notes writing.md', true],
    ], 'the chosen copy of a listed file is not added twice');
    await act(async () => { checkboxes()[0].click(); checkboxes()[1].click(); });
    await act(async () => { importButton(view.container)?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.deepEqual(saves.map((save) => [save.scopeId, save.scopeLabel, save.text]), [
      ['/sample/Notes', 'Notes', 'Keep release notes to five bullets.'],
    ]);
  } finally {
    await view.cleanup();
  }
});

test('a file that cannot be imported shows the reason on its row', async () => {
  const preview = createPreviewMemoryImporter({ latencyMs: 0 });
  const importer: MemoryImporter = {
    ...preview,
    extract: async () => { throw new Error('Import needs a provider signed in on this Mac.'); },
  };
  const view = await render(
    <MemoryImportSection client={{ importLesson: async () => ({}) as MemoryLesson }} importer={importer} lessons={[]} providerReady onImported={() => undefined} />,
  );
  try {
    await act(async () => { importButton(view.container)?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const text = view.container.textContent ?? '';
    assert.match(text, /AGENTS\.md · 4 KB · .*Import needs a provider signed in on this Mac\./);
    assert.match(text, /Could not import/);
    assert.match(text, /Nothing new\./);
  } finally {
    await view.cleanup();
  }
});

test('a refused import run shows the server line on every row and finishes no run', async () => {
  const preview = createPreviewMemoryImporter({ latencyMs: 0 });
  const importer: MemoryImporter = {
    ...preview,
    start: async () => { throw new Error('Another import is running.'); },
  };
  const view = await render(
    <MemoryImportSection client={{ importLesson: async () => ({}) as MemoryLesson }} importer={importer} lessons={[]} providerReady onImported={() => undefined} />,
  );
  try {
    await act(async () => { importButton(view.container)?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const text = view.container.textContent ?? '';
    assert.equal(text.match(/Another import is running\./g)?.length, 2);
    assert.equal(text.match(/Could not import/g)?.length, 2);
  } finally {
    await view.cleanup();
  }
});

test('an import run reads each file under it and is completed once', async () => {
  const preview = createPreviewMemoryImporter({ latencyMs: 0 });
  const finished: boolean[] = [];
  const read: string[] = [];
  const importer: MemoryImporter = {
    ...preview,
    start: async () => ({
      extract: (file, existing) => { read.push(file.path); return preview.extract(file, existing); },
      finish: async (ok) => { finished.push(ok); },
    }),
  };
  const view = await render(
    <MemoryImportSection client={{ importLesson: async () => ({}) as MemoryLesson }} importer={importer} lessons={[]} providerReady onImported={() => undefined} />,
  );
  try {
    await act(async () => { importButton(view.container)?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(read.length, 2);
    assert.deepEqual(finished, [true]);
  } finally {
    await view.cleanup();
  }
});
