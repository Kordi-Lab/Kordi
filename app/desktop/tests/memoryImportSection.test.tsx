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
const settle = async (ms = 20) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const rows = (container: HTMLElement, kind?: 'app' | 'project' | 'file') =>
  Array.from(container.querySelectorAll<HTMLElement>(kind ? `[data-memory-import-row="${kind}"]` : '[data-memory-import-row]'));
const row = (container: HTMLElement, label: string) => {
  const found = rows(container).find((element) => element.getAttribute('aria-label') === label);
  assert.ok(found, `row ${label}`);
  return found;
};
/** The row's own line, without the rows nested under it. */
// File dates show the year only for another year, so the assertions drop the fixture's year.
const line = (container: HTMLElement, label: string) => (row(container, label).firstElementChild?.textContent ?? '').replace(', 2026', '');
const box = (container: HTMLElement, label: string) => row(container, label).querySelector<HTMLInputElement>(':scope > div input[type="checkbox"]')!;
const expand = async (container: HTMLElement, label: string) => {
  await act(async () => { row(container, label).querySelector<HTMLButtonElement>(':scope > div > button:not([aria-hidden])')?.click(); });
};
const NOW = () => Date.parse('2026-10-20T10:00:00Z');

function renderSection(overrides: Partial<React.ComponentProps<typeof MemoryImportSection>> = {}) {
  return render(
    <MemoryImportSection
      client={{ importLesson: async () => ({}) as MemoryLesson }}
      importer={createPreviewMemoryImporter({ latencyMs: 0, now: NOW })}
      lessons={[]}
      providerReady
      onImported={() => undefined}
      {...overrides}
    />,
  );
}

test('the list starts collapsed by app, all selected, and opens app, project and file layers', async () => {
  const view = await renderSection();
  try {
    const { container } = view;
    assert.deepEqual(rows(container).map((element) => element.getAttribute('aria-label')), ['Claude Code', 'Project files']);
    assert.equal(line(container, 'Claude Code'), 'Claude Code3 projects · 6 files');
    assert.equal(line(container, 'Project files'), 'Project files2 projects · 3 files');
    assert.match(container.textContent ?? '', /9 files selected/);
    assert.equal(box(container, 'Claude Code').checked, true);
    assert.equal(row(container, 'Claude Code').getAttribute('aria-expanded'), 'false');

    await expand(container, 'Claude Code');
    assert.equal(row(container, 'Claude Code').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(rows(container, 'project').map((element) => element.firstElementChild?.textContent), [
      'launch-site3 files · 4 KB',
      'docs-site2 files · 3 KB',
      'Home1 file · 1 KB',
    ]);
    assert.equal(rows(container, 'file').length, 0);

    await expand(container, 'Claude Code launch-site');
    assert.deepEqual(rows(container, 'file').map((element) => line(container, element.getAttribute('aria-label') ?? '')), [
      'memory/feedback-always-checkpoint.md· 1 KB · Oct 17',
      'memory/project-image-budget.md· 800 B · Oct 15',
      'memory/reference-deploy-steps.md· 3 KB · Oct 8',
    ]);
    await expand(container, 'Claude Code');
    assert.equal(rows(container, 'project').length, 0, 'closing an app hides its projects');
  } finally {
    await view.cleanup();
  }
});

test('app and project checkboxes select their whole subtree and show some as mixed', async () => {
  const view = await renderSection();
  try {
    const { container } = view;
    await expand(container, 'Claude Code');
    await expand(container, 'Claude Code launch-site');
    await act(async () => { box(container, 'launch-site memory/project-image-budget.md').click(); });
    assert.equal(box(container, 'Claude Code launch-site').indeterminate, true);
    assert.equal(box(container, 'Claude Code launch-site').checked, false);
    assert.equal(box(container, 'Claude Code').indeterminate, true);
    assert.equal(box(container, 'Claude Code docs-site').indeterminate, false);
    assert.match(container.textContent ?? '', /8 files selected/);

    await act(async () => { box(container, 'Claude Code launch-site').click(); });
    assert.equal(box(container, 'Claude Code launch-site').checked, true);
    assert.equal(box(container, 'launch-site memory/project-image-budget.md').checked, true);
    assert.equal(box(container, 'Claude Code').indeterminate, false);

    await act(async () => { box(container, 'Claude Code').click(); });
    assert.equal(box(container, 'Claude Code').checked, false);
    assert.equal(rows(container, 'file').filter((element) => element.querySelector('input')?.checked).length, 0);
    assert.match(container.textContent ?? '', /3 files selected/);
    await act(async () => { box(container, 'Project files').click(); });
    assert.match(container.textContent ?? '', /0 files selected/);
    assert.equal(importButton(container)?.disabled, true);
  } finally {
    await view.cleanup();
  }
});

test('Enter and Space on a focused row open and close it', async () => {
  const view = await renderSection();
  try {
    const { container } = view;
    const press = async (key: string) => {
      const target = row(container, 'Project files');
      target.focus();
      await act(async () => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })); });
    };
    await press('Enter');
    assert.equal(row(container, 'Project files').getAttribute('aria-expanded'), 'true');
    assert.equal(rows(container, 'project').length, 2);
    await press(' ');
    assert.equal(row(container, 'Project files').getAttribute('aria-expanded'), 'false');
    assert.equal(rows(container, 'project').length, 0);
  } finally {
    await view.cleanup();
  }
});

test('importing rolls progress and results up to projects and apps', async () => {
  const saves: MemoryImportSave[] = [];
  let imported = 0;
  const existing = [{ text: 'use pnpm for every script in this repository.' }] as Pick<MemoryLesson, 'text'>[];
  const preview = createPreviewMemoryImporter({ latencyMs: 0, now: NOW });
  const gates: Array<() => void> = [];
  const importer: MemoryImporter = {
    ...preview,
    extract: async (file, memories) => {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      return preview.extract(file, memories);
    },
  };
  const view = await renderSection({
    importer,
    lessons: existing,
    client: { importLesson: async (save) => { saves.push(save); return {} as MemoryLesson; } },
    onImported: () => { imported += 1; },
  });
  try {
    const { container } = view;
    await expand(container, 'Claude Code');
    await act(async () => { importButton(container)?.click(); });
    await settle(0);
    assert.doesNotMatch(line(container, 'Claude Code'), /Importing/);
    assert.equal(button(container, 'Importing…')?.disabled, true);
    assert.equal(importButton(container), undefined);
    assert.match(line(container, 'Claude Code launch-site'), /Importing 0\/3…$/);
    await act(async () => { gates.shift()?.(); });
    await settle(0);
    assert.match(line(container, 'Claude Code launch-site'), /Importing 1\/3…$/);
    while (gates.length || button(container, 'Importing…')) {
      await act(async () => { gates.shift()?.(); });
      await settle(0);
    }
    assert.deepEqual(saves.map((save) => [save.scopeLabel, save.text]), [
      ['launch-site', 'Commit a checkpoint before each large refactor.'],
      ['docs-site', 'Keep docs headings under six words.'],
      ['launch-site', 'Run the image size check before every site build.'],
    ], 'the repeat of an existing memory is skipped');
    assert.match(line(container, 'Claude Code'), /Imported 2 memories$/);
    assert.match(line(container, 'Project files'), /Imported 1 memory$/);
    assert.match(line(container, 'Claude Code launch-site'), /Imported 1 memory$/);
    assert.match(line(container, 'Claude Code Home'), /Nothing new$/);
    await expand(container, 'Claude Code launch-site');
    assert.match(line(container, 'launch-site memory/feedback-always-checkpoint.md'), /Imported 1 memory$/);
    assert.match(line(container, 'launch-site memory/project-image-budget.md'), /Nothing new$/);
    assert.match(container.textContent ?? '', /Imported 3 memories\./);
    assert.equal(imported, 1);
  } finally {
    await view.cleanup();
  }
});

test('without a provider the import cannot start; without files the section says so', async () => {
  const noProvider = await renderSection({ providerReady: false });
  try {
    assert.match(noProvider.container.textContent ?? '', /No provider configured yet\./);
    assert.equal(importButton(noProvider.container)?.disabled, true);
  } finally {
    await noProvider.cleanup();
  }
  const emptyImporter: MemoryImporter = { discover: async () => [], extract: async () => '{}' };
  const empty = await renderSection({ importer: emptyImporter });
  try {
    assert.match(empty.container.textContent ?? '', /No agent files found\.Finds instructions and memories from your coding agents\./);
    assert.equal(importButton(empty.container), undefined);
  } finally {
    await empty.cleanup();
  }
});

test('chosen files join as their own app, checked, once, and import into their folder', async () => {
  const saves: MemoryImportSave[] = [];
  const view = await renderSection({ client: { importLesson: async (save) => { saves.push(save); return {} as MemoryLesson; } } });
  try {
    const { container } = view;
    await act(async () => { button(container, 'Choose files…')?.click(); });
    assert.deepEqual(rows(container, 'app').map((element) => element.firstElementChild?.textContent), [
      'Claude Code3 projects · 6 files',
      'Project files2 projects · 3 files',
      'Chosen files1 file',
    ], 'the chosen copy of a listed file is not added twice');
    await expand(container, 'Chosen files');
    assert.equal(box(container, 'Notes writing.md').checked, true);
    await act(async () => { box(container, 'Claude Code').click(); box(container, 'Project files').click(); });
    await act(async () => { importButton(container)?.click(); });
    await settle();
    assert.deepEqual(saves.map((save) => [save.scopeId, save.scopeLabel, save.text]), [
      ['/sample/Notes', 'Notes', 'Keep release notes to five bullets.'],
    ]);
    assert.match(line(container, 'Chosen files'), /Imported 1 memory$/);
  } finally {
    await view.cleanup();
  }
});

test('a file that cannot be imported keeps its reason under its row', async () => {
  const preview = createPreviewMemoryImporter({ latencyMs: 0, now: NOW });
  const importer: MemoryImporter = {
    ...preview,
    extract: async () => { throw new Error('Import needs a provider signed in on this Mac.'); },
  };
  const view = await renderSection({ importer });
  try {
    const { container } = view;
    await act(async () => { importButton(container)?.click(); });
    await settle();
    assert.match(line(container, 'Project files'), /Could not import$/);
    assert.match(container.textContent ?? '', /Nothing new\./);
    await expand(container, 'Project files');
    await expand(container, 'Project files launch-site');
    assert.match(line(container, 'launch-site AGENTS.md'), /AGENTS\.md· 4 KB · Oct 18Could not import$/);
    assert.equal(row(container, 'launch-site AGENTS.md').textContent?.match(/Import needs a provider signed in on this Mac\./g)?.length, 1);
  } finally {
    await view.cleanup();
  }
});

test('a refused import run marks every file and finishes no run', async () => {
  const preview = createPreviewMemoryImporter({ latencyMs: 0, now: NOW });
  const importer: MemoryImporter = {
    ...preview,
    start: async () => { throw new Error('Another import is running.'); },
  };
  const view = await renderSection({ importer });
  try {
    const { container } = view;
    await act(async () => { importButton(container)?.click(); });
    await settle();
    assert.deepEqual(rows(container, 'app').map((element) => element.firstElementChild?.textContent?.endsWith('Could not import')), [true, true]);
    await expand(container, 'Project files');
    await expand(container, 'Project files launch-site');
    await expand(container, 'Project files docs-site');
    assert.equal(container.textContent?.match(/Another import is running\./g)?.length, 3);
  } finally {
    await view.cleanup();
  }
});

test('an import run reads each file under it and is completed once', async () => {
  const preview = createPreviewMemoryImporter({ latencyMs: 0, now: NOW });
  const finished: boolean[] = [];
  const read: string[] = [];
  const importer: MemoryImporter = {
    ...preview,
    start: async () => ({
      extract: (file, existing) => { read.push(file.path); return preview.extract(file, existing); },
      finish: async (ok) => { finished.push(ok); },
    }),
  };
  const view = await renderSection({ importer });
  try {
    await act(async () => { importButton(view.container)?.click(); });
    await settle();
    assert.equal(read.length, 9);
    assert.deepEqual(finished, [true]);
  } finally {
    await view.cleanup();
  }
});
