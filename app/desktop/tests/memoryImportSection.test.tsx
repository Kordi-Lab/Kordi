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

const importButton = (container: HTMLElement) => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Import');

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
    assert.match(empty.container.textContent ?? '', /No agent files found\.Finds AGENTS\.md and CLAUDE\.md files for your projects\./);
    assert.equal(importButton(empty.container), undefined);
  } finally {
    await empty.cleanup();
  }
});
