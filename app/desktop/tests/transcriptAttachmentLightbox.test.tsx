import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import AttachmentMediaWindow from '../src/AttachmentMediaWindow';
import {
  attachmentMediaWindowOptions,
  currentAttachmentMediaTheme,
  type AttachmentMediaWindowPayload,
} from '../src/features/chat/attachmentMediaWindow';
import {
  attachmentMediaZoomActionForKey,
  nextAttachmentMediaZoom,
} from '../src/features/chat/attachmentMediaZoom';
import {
  attachmentMediaGalleryIndex,
  collectConversationImageAttachments,
} from '../src/features/chat/attachmentMediaGallery';
import { AttachmentImageLightbox } from '../src/kordi-app/components/transcriptAttachmentLightbox';
import { shouldDismissAttachmentImageLightboxForTarget } from '../src/kordi-app/components/transcriptAttachmentLightboxHitTest';
import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';
import type { Message } from '../src/kordi-app/types';

function installDom(url = 'http://127.0.0.1:1420/') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url });
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

async function flushReactUpdates() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

test('media lightbox protects its image, native title bar, and navigation controls', () => {
  const environment = installDom();
  try {
    const image = document.createElement('img');
    const child = document.createElement('span');
    const titlebar = document.createElement('div');
    titlebar.dataset.attachmentImageLightboxControl = 'true';
    image.append(child);
    document.body.append(image, titlebar);

    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, image), false);
    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, child), false);
    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, titlebar), false);
    assert.equal(shouldDismissAttachmentImageLightboxForTarget(image, document.body), true);
  } finally {
    environment.restore();
  }
});

test('media lightbox is native-window content without modal chrome or tooltip noise', () => {
  const attachment = galleryMessage.attachments?.[1];
  assert.ok(attachment);
  const markup = renderToStaticMarkup(createElement(AttachmentImageLightbox, {
    attachment,
    previewUrl: attachment.previewUrl,
    onClose: () => {},
    canGoPrevious: true,
    canGoNext: true,
    onPrevious: () => {},
    onNext: () => {},
    positionLabel: '2 of 3',
  }));

  assert.match(markup, /role="dialog"/);
  assert.doesNotMatch(markup, /aria-modal/);
  assert.match(markup, /data-tauri-drag-region/);
  assert.match(markup, /aria-label="Previous image"/);
  assert.match(markup, /aria-label="Next image"/);
  assert.match(markup, />2 of 3</);
  assert.doesNotMatch(markup, /Right-click for image actions|Close image preview|data-attachment-image-lightbox-panel/);
});

test('media window is resizable and keeps themed edge navigation around uncropped images', () => {
  const css = readFileSync(new URL('../src/styles/shell-media-lightbox.css', import.meta.url), 'utf8');

  assert.equal(attachmentMediaWindowOptions.resizable, true);
  assert.equal(attachmentMediaWindowOptions.maximizable, true);
  assert.equal(attachmentMediaWindowOptions.titleBarStyle, 'overlay');
  assert.ok(attachmentMediaWindowOptions.minWidth >= 480);
  assert.ok(attachmentMediaWindowOptions.minHeight >= 320);
  assert.equal(attachmentMediaWindowOptions.backgroundColor, 'transparent');
  assert.match(css, /--app-media-window-surface:\s*rgb\(10 12 16 \/ 0\.24\)/);
  assert.match(css, /data-attachment-media-theme="light"[\s\S]*--app-media-window-surface:\s*rgb\(255 255 255 \/ 0\.1\)/);
  assert.match(css, /backdrop-filter:\s*blur\(34px\) saturate\(1\.24\)/);
  assert.match(css, /\.app-attachment-image-lightbox-image[\s\S]*max-width:\s*100%[\s\S]*max-height:\s*100%[\s\S]*object-fit:\s*contain/);
  assert.match(css, /\.app-attachment-image-lightbox-nav[\s\S]*width:\s*48px[\s\S]*height:\s*82px[\s\S]*opacity:\s*0\.56/);
  assert.match(css, /\.app-attachment-image-lightbox-nav:hover,[\s\S]*:focus-visible[\s\S]*opacity:\s*1/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /linear-gradient/);
});

test('native media window owns a transparent resizable macOS material without forcing app theme', () => {
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const capabilities = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  ) as { permissions?: string[] };
  const start = source.indexOf('async fn desktop_open_media_preview_window');
  const end = source.indexOf('\npub fn run()', start);
  const command = source.slice(start, end);

  assert.match(command, /WebviewWindowBuilder::new/);
  assert.match(command, /WebviewUrl::App\(media_path\.into\(\)\)/);
  assert.match(command, /min_inner_size\(520\.0, 360\.0\)/);
  assert.match(command, /resizable\(true\)/);
  assert.match(command, /visible\(false\)/);
  assert.match(command, /transparent\(true\)/);
  assert.match(command, /background_color\(tauri::utils::config::Color\(0, 0, 0, 0\)\)/);
  assert.match(command, /Effect::UnderWindowBackground/);
  assert.doesNotMatch(command, /theme\(Some\(tauri::Theme::Dark\)\)/);
  assert.match(command, /title_bar_style\(tauri::TitleBarStyle::Overlay\)/);
  assert.match(source, /fn desktop_reveal_media_preview_window[\s\S]*media_preview_url_matches_request\(&window_url, &request_id\)[\s\S]*window\.show\(\)[\s\S]*window\.set_focus\(\)/);
  assert.equal(capabilities.permissions?.includes('core:window:allow-close'), true);
});

test('native media payload is injected before first render and the image reveals its hidden window', () => {
  const windowSource = readFileSync(new URL('../src/features/chat/attachmentMediaWindow.ts', import.meta.url), 'utf8');
  const viewerSource = readFileSync(new URL('../src/AttachmentMediaWindow.tsx', import.meta.url), 'utf8');
  const lightboxSource = readFileSync(new URL('../src/kordi-app/components/transcriptAttachmentLightbox.tsx', import.meta.url), 'utf8');
  const nativeSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  assert.match(windowSource, /invoke\('desktop_open_media_preview_window',[\s\S]*payload,/);
  assert.match(nativeSource, /payload:\s*serde_json::Value/);
  assert.match(nativeSource, /initialization_script\(&initialization_script\)/);
  assert.match(nativeSource, /window\.__KORDI_ATTACHMENT_MEDIA_PAYLOAD__/);
  assert.match(viewerSource, /useState<AttachmentMediaWindowPayload \| null>\(\(\) => \([\s\S]*readAttachmentMediaPayload\(requestId\)/);
  assert.match(viewerSource, /onImageLoad=\{revealWindow\}/);
  assert.match(lightboxSource, /onLoad=\{onImageLoad\}/);
  assert.doesNotMatch(readFileSync(new URL('../src/styles/shell-media-lightbox.css', import.meta.url), 'utf8'), /app-attachment-image-lightbox-enter/);
});

test('media window theme follows the active Kordi shell without mutating it', () => {
  const environment = installDom();
  try {
    const shell = document.createElement('main');
    shell.className = 'kordi-app theme-light';
    document.body.append(shell);
    assert.equal(currentAttachmentMediaTheme(), 'light');
    assert.equal(shell.className, 'kordi-app theme-light');

    shell.className = 'kordi-app theme-dark';
    assert.equal(currentAttachmentMediaTheme(), 'dark');
    assert.equal(shell.className, 'kordi-app theme-dark');
  } finally {
    environment.restore();
  }
});

test('media zoom shortcuts support command plus, minus, and reset within safe bounds', () => {
  assert.equal(attachmentMediaZoomActionForKey({ key: '=', metaKey: true }), 'in');
  assert.equal(attachmentMediaZoomActionForKey({ key: '-', metaKey: true }), 'out');
  assert.equal(attachmentMediaZoomActionForKey({ key: '0', metaKey: true }), 'reset');
  assert.equal(attachmentMediaZoomActionForKey({ key: '+', metaKey: false }), null);
  assert.equal(nextAttachmentMediaZoom(1, 'in'), 1.25);
  assert.equal(nextAttachmentMediaZoom(1, 'out'), 0.75);
  assert.equal(nextAttachmentMediaZoom(4, 'in'), 4);
  assert.equal(nextAttachmentMediaZoom(0.25, 'out'), 0.25);
  assert.equal(nextAttachmentMediaZoom(2.5, 'reset'), 1);
});

test('conversation gallery preserves transcript image order across separate messages', () => {
  const firstMessage: Message = {
    ...galleryMessage,
    attachments: [galleryMessage.attachments![0]!, { kind: 'file', name: 'Notes.txt' }],
  };
  const secondMessage: Message = {
    ...galleryMessage,
    time: '12:31',
    attachments: [galleryMessage.attachments![1]!, galleryMessage.attachments![2]!],
  };
  const gallery = collectConversationImageAttachments([firstMessage, secondMessage]);

  assert.deepEqual(gallery.map((attachment) => attachment.name), ['First.png', 'Second.png', 'Third.png']);
  assert.equal(attachmentMediaGalleryIndex(gallery, secondMessage.attachments![0]!), 1);
});

test('thumbnail click launches a separate resizable browser window with the full conversation gallery', async () => {
  const environment = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let openedUrl = '';
  let openedFeatures = '';
  let focusCount = 0;
  const originalOpen = window.open;
  window.open = ((url?: string | URL, _target?: string, features?: string) => {
    openedUrl = String(url ?? '');
    openedFeatures = features ?? '';
    return { focus: () => { focusCount += 1; } } as Window;
  }) as typeof window.open;

  try {
    const firstOnly: Message = { ...galleryMessage, attachments: [galleryMessage.attachments![0]!] };
    const gallery = galleryMessage.attachments!;
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: firstOnly, imageGallery: gallery })));
    const trigger = host.querySelector<HTMLButtonElement>('[data-attachment-image-preview-trigger="true"]');
    assert.ok(trigger);
    await act(async () => trigger.dispatchEvent(new environment.dom.window.MouseEvent('click', { bubbles: true })));
    await flushReactUpdates();

    assert.match(openedUrl, /mediaPreview=1/);
    assert.match(openedFeatures, /resizable=yes/);
    assert.equal(focusCount, 1);
    const requestId = new URL(openedUrl).searchParams.get('mediaPreviewRequest');
    assert.ok(requestId);
    const payload = JSON.parse(window.localStorage.getItem(`kordi:attachment-media:${requestId}`) ?? '') as AttachmentMediaWindowPayload;
    assert.deepEqual(payload.attachments.map((attachment) => attachment.name), ['First.png', 'Second.png', 'Third.png']);
    assert.equal(payload.selectedIndex, 0);
  } finally {
    window.open = originalOpen;
    if (root) await act(async () => root?.unmount());
    root = null;
    environment.restore();
  }
});

test('detached media window supports visible arrows, keyboard navigation, and right-click actions', async () => {
  const requestId = 'media-window-test';
  const environment = installDom(`http://127.0.0.1:1420/?mediaPreview=1&mediaPreviewRequest=${requestId}`);
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  const payload: AttachmentMediaWindowPayload = {
    requestId,
    attachments: galleryMessage.attachments!,
    selectedIndex: 1,
    initialPreviewUrl: galleryMessage.attachments![1]!.previewUrl,
  };
  window.localStorage.setItem(`kordi:attachment-media:${requestId}`, JSON.stringify(payload));
  const originalClose = window.close;
  let closeCount = 0;
  window.close = () => { closeCount += 1; };

  try {
    await act(async () => root?.render(createElement(AttachmentMediaWindow)));
    await flushReactUpdates();
    let lightbox = document.querySelector<HTMLDivElement>('[data-attachment-image-lightbox="true"]');
    assert.ok(lightbox);
    assert.equal(lightbox.querySelector('img')?.getAttribute('src'), 'https://files.test/second.png');
    assert.ok(lightbox.querySelector('[aria-label="Previous image"]'));
    assert.ok(lightbox.querySelector('[aria-label="Next image"]'));
    assert.equal(lightbox.querySelector<HTMLImageElement>('img')?.style.transform, 'scale(1)');

    await act(async () => {
      window.dispatchEvent(new environment.dom.window.KeyboardEvent('keydown', {
        key: '=',
        code: 'Equal',
        metaKey: true,
        bubbles: true,
      }));
    });
    assert.equal(lightbox.querySelector<HTMLImageElement>('img')?.style.transform, 'scale(1.25)');
    assert.match(lightbox.textContent ?? '', /125%/);

    await act(async () => {
      window.dispatchEvent(new environment.dom.window.KeyboardEvent('keydown', {
        key: '0',
        code: 'Digit0',
        metaKey: true,
        bubbles: true,
      }));
    });
    assert.equal(lightbox.querySelector<HTMLImageElement>('img')?.style.transform, 'scale(1)');

    await act(async () => {
      window.dispatchEvent(new environment.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    lightbox = document.querySelector<HTMLDivElement>('[data-attachment-image-lightbox="true"]');
    assert.equal(lightbox?.querySelector('img')?.getAttribute('src'), 'https://files.test/third.png');
    assert.equal(lightbox?.querySelector<HTMLImageElement>('img')?.style.transform, 'scale(1)');
    assert.equal(lightbox?.querySelector('[aria-label="Next image"]'), null);

    const image = lightbox?.querySelector<HTMLImageElement>('img');
    assert.ok(image);
    await act(async () => image.dispatchEvent(new environment.dom.window.MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      clientX: 120,
      clientY: 90,
    })));
    assert.ok(document.querySelector('[data-attachment-image-context-menu="true"]'));

    await act(async () => {
      window.dispatchEvent(new environment.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(document.querySelector('[data-attachment-image-context-menu="true"]'), null);
    assert.equal(closeCount, 1);
  } finally {
    window.close = originalClose;
    if (root) await act(async () => root?.unmount());
    root = null;
    environment.restore();
  }
});
