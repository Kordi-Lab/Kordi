import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';

const multiImageMessage = {
  role: 'user' as const,
  text: '',
  time: '19:45',
  attachments: [
    {
      kind: 'image' as const,
      name: 'Screenshot 2026-05-20.png',
      sizeBytes: 138 * 1024,
      attachmentId: 'att_1',
      localPath: null,
      previewUrl: 'https://files.test/preview.png',
      mimeType: 'image/png',
    },
    {
      kind: 'image' as const,
      name: 'Screenshot 2026-05-20 20.54.15.png',
      sizeBytes: 61 * 1024,
      attachmentId: 'att_2',
      localPath: null,
      previewUrl: 'https://files.test/preview-2.png',
      mimeType: 'image/png',
    },
    {
      kind: 'image' as const,
      name: 'Screenshot 2026-05-20 20.54.16.png',
      sizeBytes: 168 * 1024,
      attachmentId: 'att_3',
      localPath: null,
      previewUrl: 'https://files.test/preview-3.png',
      mimeType: 'image/png',
    },
  ],
};

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:1420/',
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

test('multiple image attachments render as a folded stack with a stable disclosure', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: multiImageMessage }));
  const stylesheet = readFileSync(new URL('../src/styles/shell-image-groups.css', import.meta.url), 'utf8');

  assert.match(markup, /data-attachment-image-collage="true"/);
  assert.match(markup, /data-attachment-image-count="3"/);
  assert.match(markup, /data-attachment-image-group-expanded="false"/);
  assert.match(markup, /data-attachment-image-group-disclosure="true"/);
  assert.match(markup, /data-transcript-stable-disclosure="true"/);
  assert.match(markup, /data-transcript-stable-disclosure-root="true"/);
  assert.match(markup, /data-transcript-stable-disclosure-direction="down"/);
  assert.doesNotMatch(markup, /data-transcript-stable-disclosure-body="true"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />Expand 3</);
  assert.match(markup, /app-button-quiet app-attachment-image-group-disclosure/);
  assert.equal((markup.match(/data-attachment-image-card="true"/g) ?? []).length, 3);
  assert.equal((markup.match(/data-attachment-image-card="true"[^>]*aria-hidden="true"/g) ?? []).length, 2);
  assert.match(markup, /app-attachment-image-tile/);
  assert.match(markup, /app-attachment-image-group-collapsed/);
  assert.doesNotMatch(markup, /rounded-\[15px\]|rounded-\[20px\]/);
  assert.doesNotMatch(markup, /backdrop-blur-xl|ring-white|bg-white\//);
  assert.doesNotMatch(markup, /bg-current\/10|group-hover:scale/);
  assert.doesNotMatch(markup, /61 KB|168 KB/);
  assert.doesNotMatch(markup, />Screenshot 2026-05-20 20\.54\.15\.png<\/span>/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
  assert.match(stylesheet, /\.app-attachment-image-group-shell\s*{[^}]*width:\s*16\.25rem;[^}]*max-width:\s*100%;[^}]*gap:\s*0\.5rem;/s);
  assert.match(stylesheet, /\.app-attachment-image-group-disclosure\s*{[^}]*width:\s*auto;[^}]*min-width:\s*4\.5rem;[^}]*height:\s*2rem;[^}]*margin-top:\s*4\.625rem;/s);
  assert.match(stylesheet, /\.app-attachment-image-group-media\s*{[^}]*width:\s*11\.25rem;[^}]*min-width:\s*0;[^}]*max-width:\s*calc\(100% - 5rem\);/s);
  assert.match(stylesheet, /\.app-attachment-image-group-collapsed\s*{[^}]*aspect-ratio:\s*1;[^}]*overflow:\s*hidden;/s);
  assert.match(stylesheet, /@keyframes\s+app-attachment-image-group-reveal/);
  assert.match(stylesheet, /app-attachment-image-group-reveal 180ms cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
  assert.match(stylesheet, /prefers-reduced-motion:\s*reduce[\s\S]*app-attachment-image-group-media[\s\S]*animation:\s*none/);
});

test('a remotely loaded standalone image escapes the temporary loading row', () => {
  const stylesheet = readFileSync(new URL('../src/styles/shell-image-groups.css', import.meta.url), 'utf8');

  assert.match(
    stylesheet,
    /\[data-attachment-image-count="1"\]:has\([^)]*\[data-attachment-image-loaded="true"\][^)]*\)\s*{[^}]*width:\s*fit-content;[^}]*grid-auto-rows:\s*auto;/s,
  );
});

test('folded image groups keep their fixed stack geometry when metadata is available', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: {
      ...multiImageMessage,
      attachments: multiImageMessage.attachments.map((attachment) => ({
        ...attachment,
        widthPixels: 1_600,
        heightPixels: 900,
      })),
    },
  }));

  assert.doesNotMatch(markup, /data-attachment-image-dimensions="true"/);
  assert.doesNotMatch(markup, /width:464px/);
});

test('grouped image disclosure expands and collapses in place', async () => {
  const installedDom = installDom();
  let root: Root | null = null;
  let previewOpenCount = 0;
  const originalOpen = installedDom.dom.window.open;
  installedDom.dom.window.open = (() => {
    previewOpenCount += 1;
    return { focus: () => undefined };
  }) as typeof installedDom.dom.window.open;

  try {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: multiImageMessage })));

    const disclosure = host.querySelector<HTMLButtonElement>('[data-attachment-image-group-disclosure="true"]');
    assert.ok(disclosure);
    assert.equal(disclosure.textContent, 'Expand 3');
    assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(host.querySelectorAll('[data-attachment-image-card="true"]').length, 3);

    const foldedImage = host.querySelector<HTMLButtonElement>('[data-attachment-image-preview-trigger="true"]');
    assert.ok(foldedImage);
    await act(async () => {
      foldedImage.dispatchEvent(new installedDom.dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(disclosure.textContent, 'Collapse');
    assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(host.querySelectorAll('[data-attachment-image-card="true"]').length, 3);
    assert.equal(
      host.querySelector('[data-attachment-image-collage="true"]')?.getAttribute('data-attachment-image-group-expanded'),
      'true',
    );

    const expandedImage = host.querySelector<HTMLButtonElement>('[data-attachment-image-preview-trigger="true"]');
    const expandedImageElement = expandedImage?.querySelector('img');
    assert.ok(expandedImage);
    assert.ok(expandedImageElement);
    assert.equal(expandedImageElement.draggable, false);
    assert.equal(expandedImageElement.dispatchEvent(new installedDom.dom.window.MouseEvent('dragstart', {
      bubbles: true,
      cancelable: true,
    })), false);
    await act(async () => {
      expandedImage.dispatchEvent(new installedDom.dom.window.MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }));
      expandedImage.dispatchEvent(new installedDom.dom.window.MouseEvent('pointermove', {
        bubbles: true,
        button: 0,
        clientX: 80,
        clientY: 100,
      }));
      expandedImage.dispatchEvent(new installedDom.dom.window.MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 80,
        clientY: 100,
      }));
      expandedImage.dispatchEvent(new installedDom.dom.window.MouseEvent('click', {
        bubbles: true,
        button: 0,
        detail: 1,
      }));
    });
    assert.equal(previewOpenCount, 0);

    await act(async () => {
      disclosure.dispatchEvent(new installedDom.dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(disclosure.textContent, 'Expand 3');
    assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(host.querySelectorAll('[data-attachment-image-card="true"]').length, 3);
  } finally {
    installedDom.dom.window.open = originalOpen;
    if (root) await act(async () => root?.unmount());
    installedDom.restore();
  }
});
