import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AttachmentImageLightbox,
} from '../src/kordi-app/components/transcriptAttachmentLightbox';
import { shouldDismissAttachmentImageLightboxForTarget } from '../src/kordi-app/components/transcriptAttachmentLightboxHitTest';
import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';
import type { Message } from '../src/kordi-app/types';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
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

const galleryMessage: Message = {
  role: 'person',
  text: '',
  time: '12:30',
  attachments: [
    { kind: 'image', name: 'First.png', attachmentId: 'first', previewUrl: 'https://files.test/first.png' },
    { kind: 'image', name: 'Second.png', attachmentId: 'second', previewUrl: 'https://files.test/second.png' },
    { kind: 'image', name: 'Third.png', attachmentId: 'third', previewUrl: 'https://files.test/third.png' },
  ],
};

test('media lightbox keeps only the image and navigation controls as protected pointer targets', () => {
  const environment = installDom();
  try {
    const image = document.createElement('img');
    const child = document.createElement('span');
    const next = document.createElement('button');
    next.dataset.attachmentImageLightboxControl = 'true';
    image.append(child);
    document.body.append(image, next);

    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, image), false);
    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, child), false);
    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, next), false);
    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, document.body), true);
  } finally {
    environment.restore();
  }
});

test('media lightbox is a media-first dialog without card chrome or a close button', () => {
  const firstAttachment = galleryMessage.attachments?.[0];
  assert.ok(firstAttachment);
  const markup = renderToStaticMarkup(createElement(AttachmentImageLightbox, {
    attachment: firstAttachment,
    previewUrl: 'https://files.test/first.png',
    onClose: () => {},
    canGoNext: true,
    onNext: () => {},
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /Image preview: First\.png/);
  assert.match(markup, /Press Escape to close/);
  assert.match(markup, /aria-label="Next image"/);
  assert.doesNotMatch(markup, /data-attachment-image-lightbox-panel/);
  assert.doesNotMatch(markup, /Close image preview/);
  assert.doesNotMatch(markup, /app-transient-surface|backdrop-blur|shadow-2xl/);
});

test('media lightbox CSS maximizes uncropped images and hides edge navigation until interaction', () => {
  const css = readFileSync(new URL('../src/styles/shell-media-lightbox.css', import.meta.url), 'utf8');

  assert.match(css, /background:\s*rgb\(2 5 9 \/ 0\.84\)/);
  assert.match(css, /\.app-attachment-image-lightbox-image[\s\S]*max-width:\s*100%[\s\S]*max-height:\s*100%[\s\S]*object-fit:\s*contain/);
  assert.match(css, /\.app-attachment-image-lightbox-nav[\s\S]*width:\s*44px[\s\S]*height:\s*72px[\s\S]*opacity:\s*0/);
  assert.match(css, /\.app-attachment-image-lightbox-nav:hover,[\s\S]*:focus-visible[\s\S]*opacity:\s*1/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /backdrop-filter|linear-gradient|box-shadow:[^;]*rgb\([^)]*\/ 0\.[0-7]\)/);
});

test('gallery lightbox supports pointer dismissal, bounded navigation, Escape, and focus restoration', async () => {
  const environment = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);

  try {
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: galleryMessage })));
    const triggers = host.querySelectorAll<HTMLButtonElement>('[data-attachment-image-preview-trigger="true"]');
    assert.equal(triggers.length, 3);
    triggers[0]?.focus();

    await act(async () => {
      triggers[0]?.dispatchEvent(new environment.dom.window.MouseEvent('click', { bubbles: true }));
    });
    let lightbox = document.querySelector<HTMLDivElement>('[data-attachment-image-lightbox="true"]');
    const image = lightbox?.querySelector<HTMLImageElement>('img');
    assert.equal(image?.getAttribute('src'), 'https://files.test/first.png');
    assert.equal(document.activeElement, lightbox);
    assert.equal(lightbox?.querySelector('[aria-label="Previous image"]'), null);

    await act(async () => {
      image?.dispatchEvent(new environment.dom.window.MouseEvent('pointerdown', { bubbles: true }));
    });
    assert.ok(document.querySelector('[data-attachment-image-lightbox="true"]'));

    const next = document.querySelector<HTMLButtonElement>('[aria-label="Next image"]');
    assert.ok(next);
    await act(async () => next.dispatchEvent(new environment.dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(document.querySelector('[data-attachment-image-lightbox="true"] img')?.getAttribute('src'), 'https://files.test/second.png');

    await act(async () => {
      window.dispatchEvent(new environment.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    lightbox = document.querySelector<HTMLDivElement>('[data-attachment-image-lightbox="true"]');
    assert.equal(lightbox?.querySelector('img')?.getAttribute('src'), 'https://files.test/third.png');
    assert.equal(lightbox?.querySelector('[aria-label="Next image"]'), null);

    await act(async () => {
      window.dispatchEvent(new environment.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(document.querySelector('[data-attachment-image-lightbox="true"]'), null);
    assert.equal(document.activeElement, triggers[2]);

    triggers[1]?.focus();
    await act(async () => triggers[1]?.dispatchEvent(new environment.dom.window.MouseEvent('click', { bubbles: true })));
    lightbox = document.querySelector<HTMLDivElement>('[data-attachment-image-lightbox="true"]');
    await act(async () => lightbox?.dispatchEvent(new environment.dom.window.MouseEvent('pointerdown', { bubbles: true })));
    assert.equal(document.querySelector('[data-attachment-image-lightbox="true"]'), null);
    assert.equal(document.activeElement, triggers[1]);
  } finally {
    if (root) await act(async () => root?.unmount());
    root = null;
    environment.restore();
  }
});

test('right-clicking lightbox media opens actions without dismissing the preview', async () => {
  const environment = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);

  try {
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: galleryMessage })));
    const trigger = host.querySelector<HTMLButtonElement>('[data-attachment-image-index="0"]');
    await act(async () => trigger?.dispatchEvent(new environment.dom.window.MouseEvent('click', { bubbles: true })));
    const image = document.querySelector<HTMLImageElement>('[data-attachment-image-lightbox="true"] img');
    assert.ok(image);

    await act(async () => {
      image.dispatchEvent(new environment.dom.window.MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        clientX: 120,
        clientY: 90,
      }));
    });
    assert.ok(document.querySelector('[data-attachment-image-lightbox="true"]'));
    assert.ok(document.querySelector('[data-attachment-image-context-menu="true"]'));

    await act(async () => {
      window.dispatchEvent(new environment.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(document.querySelector('[data-attachment-image-lightbox="true"]'), null);
    assert.equal(document.querySelector('[data-attachment-image-context-menu="true"]'), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    if (root) await act(async () => root?.unmount());
    root = null;
    environment.restore();
  }
});
