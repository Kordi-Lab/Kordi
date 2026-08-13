import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  displayAttachmentName,
  friendlyAttachmentName,
  parseStoredComposerAttachments,
  serializeStoredComposerAttachments,
} from '../src/features/chat/composerAttachments';
import {
  ComposerAttachmentAddMenu,
  ComposerAttachmentList,
} from '../src/kordi-app/components/composerAttachments';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
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

test('friendlyAttachmentName replaces generic clipboard image names with timestamped screenshot names', () => {
  assert.equal(
    friendlyAttachmentName('image.png', 'image', new Date(2026, 3, 30, 18, 30, 7).getTime()),
    'Screenshot 2026-04-30 18.30.07.png',
  );
  assert.equal(
    friendlyAttachmentName('pi-clipboard-02f68383-cadc-4d8f-83ec-7067805155b7.png', 'image', new Date(2026, 3, 30, 18, 30, 7).getTime()),
    'Screenshot 2026-04-30 18.30.07.png',
  );
});

test('friendlyAttachmentName preserves user-provided image and file names', () => {
  assert.equal(friendlyAttachmentName('architecture-diagram.png', 'image', Date.UTC(2026, 3, 30)), 'architecture-diagram.png');
  assert.equal(friendlyAttachmentName('package.json', 'file', Date.UTC(2026, 3, 30)), 'package.json');
});

test('displayAttachmentName hides generic image filenames in visible image chrome', () => {
  assert.equal(displayAttachmentName('image.png', 'image'), 'Image attachment');
  assert.equal(displayAttachmentName('architecture-diagram.png', 'image'), 'architecture-diagram.png');
  assert.equal(displayAttachmentName('image.png', 'file'), 'image.png');
});

test('stored composer attachments persist durable local paths but drop stale blob preview urls', () => {
  const serialized = serializeStoredComposerAttachments([{
    id: 'first',
    name: 'Screenshot 2026-04-30 18.30.07.png',
    path: '/Users/example/Library/Application Support/Kordi/tmp/attachments/Screenshot-uuid.png',
    kind: 'image',
    formatLabel: 'PNG',
    mimeType: 'image/png',
    previewUrl: 'blob:http://127.0.0.1:1484/stale',
    sizeBytes: 276000,
  }]);

  assert.deepEqual(parseStoredComposerAttachments(serialized), [{
    id: 'first',
    name: 'Screenshot 2026-04-30 18.30.07.png',
    path: '/Users/example/Library/Application Support/Kordi/tmp/attachments/Screenshot-uuid.png',
    kind: 'image',
    formatLabel: 'PNG',
    mimeType: 'image/png',
    localPath: '/Users/example/Library/Application Support/Kordi/tmp/attachments/Screenshot-uuid.png',
    previewUrl: null,
    sizeBytes: 276000,
  }]);
});

test('composer attachment tiles keep the filename and remove control on one compact line', () => {
  const attachments = [{
    id: 'pdf-1',
    name: '2607.28802v1.pdf',
    kind: 'file' as const,
    mimeType: 'application/pdf',
  }];
  const markup = renderToStaticMarkup(createElement(ComposerAttachmentList, {
    attachments,
    onRemove: () => undefined,
  }));

  assert.match(markup, /data-composer-attachment-list="true"/);
  assert.match(markup, /data-composer-attachment-tile="true"/);
  assert.match(markup, />2607\.28802v1\.pdf</);
  assert.doesNotMatch(markup, />PDF</);
  assert.match(markup, /inline-flex h-8/);
  assert.match(markup, /aria-label="Remove 2607\.28802v1\.pdf"/);
  assert.doesNotMatch(markup, /rounded-full border[^>]*2607\.28802v1\.pdf/);
});

test('composer add trigger opens one Files and folders action and dismisses accessibly', async () => {
  const installed = installDom();
  const host = installed.dom.window.document.createElement('div');
  installed.dom.window.document.body.append(host);
  let inputClicks = 0;
  let root: Root | null = createRoot(host);

  function Harness() {
    const inputRef = useRef<HTMLInputElement | null>(null);
    return createElement('div', { className: 'app-composer-shell' },
      createElement('input', {
        ref: inputRef,
        type: 'file',
        onClick: () => { inputClicks += 1; },
      }),
      createElement(ComposerAttachmentAddMenu, { inputRef }),
    );
  }

  try {
    await act(async () => root?.render(createElement(Harness)));
    const trigger = host.querySelector<HTMLButtonElement>('[data-composer-attachment-add-trigger="true"]');
    assert.ok(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    const composerShell = host.querySelector<HTMLElement>('.app-composer-shell');
    assert.ok(composerShell);
    composerShell.getBoundingClientRect = () => ({
      x: 40,
      y: 500,
      left: 40,
      top: 500,
      right: 760,
      bottom: 660,
      width: 720,
      height: 160,
      toJSON: () => ({}),
    });
    trigger.getBoundingClientRect = () => ({
      x: 64,
      y: 612,
      left: 64,
      top: 612,
      right: 100,
      bottom: 648,
      width: 36,
      height: 36,
      toJSON: () => ({}),
    });

    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const menu = installed.dom.window.document.querySelector<HTMLElement>('[data-composer-attachment-add-menu="true"]');
    assert.ok(menu);
    assert.match(menu.className, /app-compact-model-menu-layer/);
    assert.match(menu.className, /app-composer-attachment-add-menu/);
    assert.equal(menu.style.left, '40px');
    assert.equal(menu.style.top, '500px');
    assert.equal(menu.style.width, '720px');
    const menuItems = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    assert.equal(menuItems.length, 1);
    assert.equal(menuItems[0]?.textContent?.trim(), 'Files and folders');
    assert.match(menuItems[0]?.className ?? '', /app-composer-attachment-add-menu-action/);
    assert.equal(installed.dom.window.document.activeElement, menuItems[0]);

    await act(async () => menuItems[0]?.click());
    assert.equal(inputClicks, 1);
    assert.equal(installed.dom.window.document.querySelector('[data-composer-attachment-add-menu="true"]'), null);

    await act(async () => trigger.click());
    await act(async () => {
      installed.dom.window.document.body.dispatchEvent(new installed.dom.window.Event('pointerdown', {
        bubbles: true,
      }));
    });
    assert.equal(installed.dom.window.document.querySelector('[data-composer-attachment-add-menu="true"]'), null);

    await act(async () => trigger.click());
    await act(async () => {
      installed.dom.window.document.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Escape',
      }));
    });
    assert.equal(installed.dom.window.document.querySelector('[data-composer-attachment-add-menu="true"]'), null);
    assert.equal(installed.dom.window.document.activeElement, trigger);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('composer add menu stays compact and uses shadow instead of a hard divider', () => {
  const css = readFileSync(new URL('../src/styles/shell-popovers.css', import.meta.url), 'utf8');
  const surfaceRule = css.match(/\.app-transient-surface\.app-composer-attachment-add-menu\s*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(surfaceRule, /border:\s*0\s*!important;/);
  assert.match(surfaceRule, /box-shadow:\s*0\s+10px\s+30px/);
  assert.doesNotMatch(surfaceRule, /0\s+0\s+0\s+1px/);
  assert.match(css, /\.app-composer-attachment-add-menu-label\s*\{[^}]*font-size:\s*9px;/s);
  assert.match(css, /\.app-composer-attachment-add-menu-action\s*\{[^}]*font-size:\s*11px;/s);
});

test('Chats, Ask Agent, Projects, and Factory use the same attachment tile and add menu', () => {
  for (const sourcePath of [
    '../src/pages/chatsPage.mainComposer.tsx',
    '../src/pages/chatsPage.companionComposer.tsx',
    '../src/pages/ProjectsPage.tsx',
    '../src/kordi-app/agents/AgentStudioConversation.tsx',
  ]) {
    const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
    assert.match(source, /<ComposerAttachmentList/);
    assert.match(source, /<ComposerAttachmentAddMenu/);
    assert.doesNotMatch(source, /<Paperclip/);
  }
});
