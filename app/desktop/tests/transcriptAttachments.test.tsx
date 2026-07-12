import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY,
  loadVisibleCloudAttachmentPreview,
  resetCloudAttachmentPreviewLoader,
} from '../src/features/cloud/cloudAttachments';
import { __setSessionBackendForTests, type SessionStorageBackend } from '../src/features/cloud/session';
import {
  AttachmentImageLightbox,
  AttachmentPreview,
  attachmentPreviewIdentity,
  shouldCloseAttachmentContextMenuForTarget,
} from '../src/kordi-app/components/transcriptAttachments';
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

async function flushReactUpdates() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

const imageMessage = {
  role: 'user' as const,
  text: '',
  time: '19:45',
  attachments: [{
    kind: 'image' as const,
    name: 'Screenshot 2026-05-20.png',
    sizeBytes: 138 * 1024,
    attachmentId: 'att_1',
    localPath: null,
    previewUrl: 'https://files.test/preview.png',
    mimeType: 'image/png',
  }],
};

const multiImageMessage = {
  ...imageMessage,
  attachments: [
    imageMessage.attachments[0],
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

const fileMessage: Message = {
  role: 'user',
  sender: 'Me',
  senderType: 'human',
  isOwnMessage: true,
  text: '',
  time: '19:45',
  statusChips: ['sending'],
  attachments: [{
    kind: 'file',
    name: 'notes.pdf',
    sizeBytes: 420 * 1024,
    attachmentId: 'att_file_1',
    localPath: '/tmp/notes.pdf',
    previewUrl: null,
    mimeType: 'application/pdf',
  }],
};

test('attachment image preview identity changes when local cache path becomes available', () => {
  const pending = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    localPath: null,
    previewUrl: null,
  });
  const cached = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    localPath: '/tmp/kordi/Screenshot.png',
    previewUrl: null,
  });

  assert.notEqual(cached, pending);
  assert.match(cached, /\/tmp\/kordi\/Screenshot\.png/);
});

test('attachment image preview identity changes when its remote preview is replaced', () => {
  const original = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    previewAttachmentId: 'preview_1',
    localPath: null,
    previewUrl: null,
  });
  const replacement = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    previewAttachmentId: 'preview_2',
    localPath: null,
    previewUrl: null,
  });

  assert.notEqual(replacement, original);
});

test('image attachments render as clickable lightweight previews without heavy footer banner', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: imageMessage }));

  assert.match(markup, /data-attachment-image-card="true"/);
  assert.match(markup, /data-attachment-image-preview-trigger="true"/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
  assert.doesNotMatch(markup, /bg-black\/10/);
  assert.match(markup, /Screenshot 2026-05-20\.png/);
});

test('multiple image attachments render as a banner-free collage', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: multiImageMessage }));

  assert.match(markup, /data-attachment-image-collage="true"/);
  assert.match(markup, /data-attachment-image-count="3"/);
  assert.match(markup, /app-attachment-image-tile/);
  assert.match(markup, /max-w-\[min\(100%,29rem\)\]/);
  assert.doesNotMatch(markup, /backdrop-blur-xl/);
  assert.doesNotMatch(markup, /ring-white/);
  assert.doesNotMatch(markup, /bg-white\//);
  assert.doesNotMatch(markup, /bg-current\/10/);
  assert.doesNotMatch(markup, /shadow-\[/);
  assert.doesNotMatch(markup, /shadow-black/);
  assert.doesNotMatch(markup, /group-hover:scale/);
  assert.doesNotMatch(markup, /61 KB/);
  assert.doesNotMatch(markup, /168 KB/);
  assert.doesNotMatch(markup, />Screenshot 2026-05-20 20\.54\.15\.png<\/span>/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
});

test('image attachment actions are available from context menu instead of sticky under-image buttons', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: imageMessage }));

  assert.match(markup, /data-attachment-image-context-target="true"/);
  assert.match(markup, /Right-click for image actions/);
  assert.doesNotMatch(markup, /aria-label="Download Screenshot 2026-05-20\.png"/);
});

test('sending image attachments show an overlay progress indicator without restoring chrome', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, statusChips: ['sending'] },
  }));

  assert.match(markup, /data-attachment-sending-indicator="true"/);
  assert.match(markup, /Sending…/);
  assert.match(markup, /animate-spin/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
});

test('sending file attachments show the same progress indicator', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: fileMessage }));

  assert.match(markup, /data-attachment-sending-indicator="true"/);
  assert.match(markup, /Sending…/);
  assert.match(markup, /animate-spin/);
});

test('remote images without a completed local preview render a quiet loading tile instead of unavailable chrome', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: {
      ...imageMessage,
      statusChips: [],
      attachments: [{
        ...imageMessage.attachments[0],
        localPath: null,
        previewUrl: null,
      }],
    },
  }));

  assert.match(markup, /data-attachment-image-loading="true"/);
  assert.match(markup, /aria-label="Loading attached image"/);
  assert.doesNotMatch(markup, /Preview unavailable/);
  assert.doesNotMatch(markup, /app-attachment-image-fallback/);
  assert.doesNotMatch(markup, />Screenshot 2026-05-20\.png</);
});

test('attachment image cards release remote preview leases on cleanup and image failure', () => {
  const source = readFileSync(
    new URL('../src/kordi-app/components/transcriptAttachments.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function AttachmentImageCard');
  const end = source.indexOf('export function AttachmentPreview', start);
  const imageCard = source.slice(start, end);

  assert.match(imageCard, /previewLeaseRef/);
  assert.match(imageCard, /return \(\) => \{[\s\S]*?previewLeaseRef\.current\?\.release\(\)/);
  assert.match(imageCard, /onError=\{\(\) => \{[\s\S]*?previewLeaseRef\.current\?\.release\(\)/);
});

test('an evicted remote preview stays alive for its open lightbox until the lightbox closes', async () => {
  const installedDom = installDom();
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const created: string[] = [];
  const revoked: string[] = [];
  let root: Root | null = null;
  const sessionBackend: SessionStorageBackend = {
    async load() {
      return { token: 'token', accountId: 'account', expiresAt: '2099-01-01T00:00:00.000Z' };
    },
    async save() {},
    async clear() {},
  };

  try {
    resetCloudAttachmentPreviewLoader();
    __setSessionBackendForTests(sessionBackend);
    globalThis.fetch = async () => new Response(new Blob(['preview']), { status: 200 });
    URL.createObjectURL = () => {
      const previewUrl = `blob:lightbox-preview-${created.length + 1}`;
      created.push(previewUrl);
      return previewUrl;
    };
    URL.revokeObjectURL = (previewUrl) => revoked.push(previewUrl);

    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const remoteMessage: Message = {
      role: 'person',
      text: '',
      time: '19:45',
      attachments: [{
        kind: 'image',
        name: 'Remote.png',
        sizeBytes: 1024,
        attachmentId: 'remote-preview',
        localPath: null,
        previewUrl: null,
      }],
    };
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: remoteMessage })));
    await flushReactUpdates();

    const trigger = host.querySelector<HTMLButtonElement>('[data-attachment-image-preview-trigger="true"]');
    assert.ok(trigger);
    await act(async () => {
      trigger.dispatchEvent(new installedDom.dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(document.querySelector('[data-attachment-image-lightbox="true"] img')?.getAttribute('src'), created[0]);

    const fillerClient = { async downloadAttachmentContent() { return new Blob(['filler']); } };
    for (let index = 0; index < CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY; index += 1) {
      const lease = await loadVisibleCloudAttachmentPreview({
        token: 'token',
        client: fillerClient,
        attachment: { attachmentId: `filler-${index}`, kind: 'image' },
      });
      lease?.release();
    }
    assert.equal(revoked.includes(created[0] ?? ''), false, 'mounted card must keep its evicted URL alive');

    const replacementMessage: Message = {
      ...remoteMessage,
      attachments: [{
        ...remoteMessage.attachments?.[0],
        attachmentId: 'replacement-preview',
        name: 'Replacement.png',
        previewUrl: 'https://files.test/replacement.png',
      }],
    };
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: replacementMessage })));
    await flushReactUpdates();

    assert.equal(document.querySelector('[data-attachment-image-lightbox="true"] img')?.getAttribute('src'), created[0]);
    assert.equal(revoked.includes(created[0] ?? ''), false, 'open lightbox must outlive the replaced card');

    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]');
    assert.ok(close);
    await act(async () => {
      close.dispatchEvent(new installedDom.dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(revoked.filter((previewUrl) => previewUrl === created[0]).length, 1);
  } finally {
    if (root) await act(async () => root?.unmount());
    resetCloudAttachmentPreviewLoader();
    __setSessionBackendForTests(null);
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    installedDom.restore();
  }
});

test('loaded image previews use a simple fade without zoom or shadow effects', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: imageMessage }));

  assert.match(markup, /transition-opacity/);
  assert.match(markup, /duration-200/);
  assert.match(markup, /ease-out/);
  assert.doesNotMatch(markup, /scale-\[/);
  assert.doesNotMatch(markup, /group-hover:scale/);
  assert.doesNotMatch(markup, /shadow-\[/);
});

test('right-click menu dismisses for outside clicks without requiring a blocking backdrop', () => {
  const insideTarget = { kind: 'inside-menu' } as unknown as EventTarget;
  const outsideTarget = { kind: 'outside-menu' } as unknown as EventTarget;
  const menuElement = {
    contains: (target: EventTarget | null) => target === insideTarget,
  };

  assert.equal(shouldCloseAttachmentContextMenuForTarget(menuElement, insideTarget), false);
  assert.equal(shouldCloseAttachmentContextMenuForTarget(menuElement, outsideTarget), true);
  assert.equal(shouldCloseAttachmentContextMenuForTarget(menuElement, null), true);
});

test('attachment image lightbox renders as a centered modal with close affordance', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentImageLightbox, {
    attachment: imageMessage.attachments[0],
    previewUrl: 'https://files.test/preview.png',
    onClose: () => {},
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /data-attachment-image-lightbox="true"/);
  assert.match(markup, /data-attachment-image-lightbox-panel="true"/);
  assert.match(markup, /items-center justify-center/);
  assert.match(markup, /Preview image/);
  assert.doesNotMatch(markup, />Image preview</);
  assert.doesNotMatch(markup, />Screenshot 2026-05-20\.png</);
  assert.doesNotMatch(markup, /border-b border-white\/10/);
  assert.match(markup, /Close image preview/);
});
