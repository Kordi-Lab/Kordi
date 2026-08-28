import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import * as transcriptAttachmentsModule from '../src/kordi-app/components/transcriptAttachments';
import { attachmentPreviewIdentity } from '../src/features/chat/attachmentMediaGallery';
import {
  resetCloudAttachmentPreviewLoader,
} from '../src/features/cloud/cloudAttachments';
import { __setSessionBackendForTests, type SessionStorageBackend } from '../src/features/cloud/session';
import {
  AttachmentPreview,
  attachmentImageForegroundToneFromRgba,
  attachmentImageDeliveryVisual,
  shouldCloseAttachmentContextMenuForTarget,
} from '../src/kordi-app/components/transcriptAttachments';
import type { Message, MessageAttachment } from '../src/kordi-app/types';

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

test('attachment preview recovery retries after authentication becomes available', async () => {
  const module = transcriptAttachmentsModule as Record<string, unknown>;
  const clearRecoveryState = module.clearAttachmentPreviewRecoveryStateForTests;
  const recoverOnce = module.recoverAttachmentPreviewOnce;
  assert.equal(typeof clearRecoveryState, 'function');
  assert.equal(typeof recoverOnce, 'function');
  (clearRecoveryState as () => void)();

  const attachment: MessageAttachment = {
    kind: 'image',
    name: 'old.png',
    mimeType: 'image/png',
    sizeBytes: 24 * 1024 * 1024,
    attachmentId: 'att_retry_after_auth',
    previewUrl: null,
    localPath: null,
  };
  let authenticated = false;
  let recoveryCalls = 0;
  const dependencies = {
    loadCloudSession: async () => authenticated ? { token: 'kordi_cs_ready' } : null,
    recoverPreview: async () => {
      recoveryCalls += 1;
      return 'data:image/webp;base64,recovered-after-auth';
    },
  };

  assert.equal(await (recoverOnce as (
    attachment: MessageAttachment,
    dependencies: typeof dependencies,
  ) => Promise<string | null>)(attachment, dependencies), null);
  authenticated = true;
  assert.equal(await (recoverOnce as (
    attachment: MessageAttachment,
    dependencies: typeof dependencies,
  ) => Promise<string | null>)(attachment, dependencies), 'data:image/webp;base64,recovered-after-auth');
  assert.equal(recoveryCalls, 1);
});

test('attachment preview recovery retries transient failures after a bounded cooldown', async () => {
  const module = transcriptAttachmentsModule as Record<string, unknown>;
  const clearRecoveryState = module.clearAttachmentPreviewRecoveryStateForTests as (() => void) | undefined;
  const recoverOnce = module.recoverAttachmentPreviewOnce;
  assert.equal(typeof clearRecoveryState, 'function');
  assert.equal(typeof recoverOnce, 'function');
  clearRecoveryState?.();

  const attachment: MessageAttachment = {
    kind: 'image',
    name: 'old-transient.png',
    mimeType: 'image/png',
    sizeBytes: 24 * 1024 * 1024,
    attachmentId: 'att_retry_after_transient_failure',
    previewUrl: null,
    localPath: null,
  };
  let now = 1_000;
  let recoveryCalls = 0;
  const dependencies = {
    loadCloudSession: async () => ({ token: 'kordi_cs_ready' }),
    now: () => now,
    retryDelayMs: 30_000,
    recoverPreview: async () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) throw new Error('temporary network failure');
      return 'data:image/webp;base64,recovered-after-retry';
    },
  };
  const invoke = recoverOnce as (
    attachment: MessageAttachment,
    dependencies: typeof dependencies,
  ) => Promise<string | null>;

  assert.equal(await invoke(attachment, dependencies), null);
  assert.equal(await invoke(attachment, dependencies), null);
  assert.equal(recoveryCalls, 1, 'cooldown should suppress immediate retry storms');
  now += 30_000;
  assert.equal(await invoke(attachment, dependencies), 'data:image/webp;base64,recovered-after-retry');
  assert.equal(recoveryCalls, 2);
});

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
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: { ...imageMessage, attachments: [{ ...imageMessage.attachments[0], previewUrl: 'data:image/png;base64,loaded-preview' }] } }));
  const stylesheet = readFileSync(new URL('../src/styles/shell-bubbles.css', import.meta.url), 'utf8');

  assert.match(markup, /data-attachment-image-card="true"/);
  assert.match(markup, /data-attachment-image-preview-trigger="true"/);
  assert.match(markup, /data-attachment-image-count="1"/);
  assert.doesNotMatch(markup, /rounded-\[15px\]|rounded-\[20px\]/);
  assert.ok((markup.match(/rounded-\[16px\]/g) ?? []).length >= 4);
  assert.match(markup, /w-fit auto-rows-auto/);
  assert.match(markup, /inline-flex h-auto w-auto max-w-full rounded-\[16px\]/);
  assert.match(markup, /max-h-\[320px\] max-w-full rounded-\[16px\] object-contain/);
  assert.doesNotMatch(markup, /max-h-\[320px\] object-contain/);
  assert.match(stylesheet, /\.app-attachment-image-collage\s*{[^}]*border-radius:\s*1rem;/s);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
  assert.doesNotMatch(markup, /bg-black\/10/);
  assert.match(markup, /Screenshot 2026-05-20\.png/);
});

test('image attachment actions are not rendered as sticky under-image buttons', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: imageMessage }));

  assert.doesNotMatch(markup, /data-attachment-image-context-target="true"/);
  assert.doesNotMatch(markup, /Right-click for image actions/);
  assert.doesNotMatch(markup, /aria-label="Download Screenshot 2026-05-20\.png"/);
});

test('sending image attachments show a centered adaptive media ring without chrome', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, statusChips: ['sending'] },
  }));

  assert.match(markup, /data-attachment-image-delivery-status="uploading"/);
  assert.match(markup, /aria-label="Sending image"/);
  assert.match(markup, /app-attachment-image-media-ring/);
  assert.match(markup, /app-attachment-image-delivery-adaptive/);
  assert.doesNotMatch(markup, /data-attachment-sending-indicator="true"/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
});

test('image delivery states keep status inside the image', () => {
  const delivering = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, statusChips: ['processing'] },
  }));
  const delivered = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, statusChips: ['delivered'] },
  }));
  const read = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, statusChips: ['read'] },
  }));
  const failed = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, statusChips: ['failed'] },
  }));

  assert.match(delivering, /data-attachment-image-delivery-status="delivering"/);
  assert.match(delivering, /Delivering…/);
  assert.match(delivered, /data-attachment-image-delivery-status="delivered"/);
  assert.match(
    delivered,
    /data-attachment-image-delivery-status="delivered" class="app-attachment-image-delivery-overlay app-attachment-image-delivery-adaptive"/,
  );
  assert.match(delivered, />19:45</);
  assert.match(delivered, /lucide-check h-3\.5/);
  assert.doesNotMatch(delivered, /lucide-check-check/);
  assert.match(read, /data-attachment-image-delivery-status="read"/);
  assert.match(read, /lucide-check-check/);
  assert.match(failed, /data-attachment-image-delivery-status="failed"/);
  assert.match(failed, /app-attachment-image-delivery-error/);
  assert.match(failed, />Failed</);
  assert.doesNotMatch(failed, />!</);
});

test('failed image attachments expose a real inline retry action', async () => {
  const environment = installDom();
  const host = environment.dom.window.document.createElement('div');
  environment.dom.window.document.body.appendChild(host);
  let retryCount = 0;
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(createElement(AttachmentPreview, {
        msg: { ...imageMessage, statusChips: ['failed'] },
        onRetryImage: () => { retryCount += 1; },
      }));
    });

    const retry = host.querySelector<HTMLButtonElement>('[aria-label="Retry sending image"]');
    assert.ok(retry);
    assert.equal(retry.textContent?.replace(/\s+/g, ' ').trim(), 'Failed·Retry');
    await act(async () => retry.click());
    assert.equal(retryCount, 1);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    environment.restore();
  }
});

test('partially delivered images can retry only the remaining recipients', async () => {
  const environment = installDom();
  const host = environment.dom.window.document.createElement('div');
  environment.dom.window.document.body.appendChild(host);
  let retryCount = 0;
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(createElement(AttachmentPreview, {
        msg: { ...imageMessage, statusChips: ['partial'] },
        onRetryImage: () => { retryCount += 1; },
      }));
    });

    const retry = host.querySelector<HTMLButtonElement>('[aria-label="Retry sending image"]');
    assert.ok(retry);
    assert.equal(retry.textContent?.replace(/\s+/g, ' ').trim(), 'Partial·Retry');
    await act(async () => retry.click());
    assert.equal(retryCount, 1);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    environment.restore();
  }
});

test('image delivery status mapping preserves upload, partial, and terminal semantics', () => {
  assert.deepEqual(attachmentImageDeliveryVisual('pending_send'), {
    kind: 'uploading',
    label: 'Sending image',
  });
  assert.deepEqual(attachmentImageDeliveryVisual('partial'), {
    kind: 'partial',
    label: 'Partially delivered',
  });
  assert.deepEqual(attachmentImageDeliveryVisual('read'), {
    kind: 'read',
    label: 'Read',
  });
  assert.deepEqual(attachmentImageDeliveryVisual('delivered'), {
    kind: 'delivered',
    label: 'Delivered',
  });
  assert.deepEqual(attachmentImageDeliveryVisual('processing_failed'), {
    kind: 'failed',
    label: 'Sending failed',
  });
  assert.equal(attachmentImageDeliveryVisual('unknown'), null);
});

test('image delivery foreground chooses the higher-contrast tone from image pixels', () => {
  assert.equal(
    attachmentImageForegroundToneFromRgba(new Uint8ClampedArray([248, 249, 251, 255])),
    'dark',
  );
  assert.equal(
    attachmentImageForegroundToneFromRgba(new Uint8ClampedArray([12, 18, 28, 255])),
    'light',
  );
  assert.equal(
    attachmentImageForegroundToneFromRgba(new Uint8ClampedArray([255, 255, 255, 0])),
    null,
  );
});

test('callers can suppress image delivery UI when the message already has a footer', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, statusChips: ['sending'] },
    imageDeliveryStatus: null,
  }));

  assert.doesNotMatch(markup, /data-attachment-image-delivery-status=/);
});

test('image delivery styling adapts to image pixels without adding status chrome', () => {
  const stylesheet = readFileSync(new URL('../src/styles/shell-bubbles.css', import.meta.url), 'utf8');

  assert.match(stylesheet, /\.app-attachment-image-delivery-adaptive\s*{[^}]*mix-blend-mode:\s*difference;/s);
  assert.match(stylesheet, /\.app-attachment-image-delivery-overlay\s*{[^}]*pointer-events:\s*none;/s);
  assert.match(stylesheet, /\.app-attachment-image-delivery-retry\s*{[^}]*pointer-events:\s*auto;/s);
  assert.doesNotMatch(
    stylesheet.match(/\.app-attachment-image-delivery-meta\s*{[^}]*}/s)?.[0] ?? '',
    /background|border|box-shadow|backdrop-filter/,
  );
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

test('a stale persisted preview path falls back to the Cloud attachment bytes', async () => {
  const installedDom = installDom();
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
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
    globalThis.fetch = async () => new Response(new Blob(['recovered-image']), { status: 200 });
    URL.createObjectURL = () => 'blob:recovered-cloud-preview';
    URL.revokeObjectURL = () => {};

    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const staleMessage: Message = {
      role: 'user',
      text: '',
      time: '08:58',
      attachments: [{
        kind: 'image',
        name: 'Screenshot 2026-07-07.png',
        sizeBytes: 429_724,
        attachmentId: 'att_stale_local_path',
        localPath: '/old-instance/tmp/attachments/screenshot.png',
        previewUrl: 'https://asset.localhost/old-instance/screenshot.png',
        mimeType: 'image/png',
      }],
    };
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: staleMessage })));
    await flushReactUpdates();

    const staleImage = host.querySelector<HTMLImageElement>('[data-attachment-image-card="true"] img');
    assert.equal(staleImage?.getAttribute('src'), 'https://asset.localhost/old-instance/screenshot.png');
    await act(async () => staleImage?.dispatchEvent(new installedDom.dom.window.Event('error')));
    await flushReactUpdates();

    const recoveredImage = host.querySelector<HTMLImageElement>('[data-attachment-image-card="true"] img');
    assert.equal(recoveredImage?.getAttribute('src'), 'blob:recovered-cloud-preview');
    await act(async () => recoveredImage?.dispatchEvent(new installedDom.dom.window.Event('load')));
    assert.equal(host.querySelector('[data-attachment-image-loading="true"]'), null);
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

test('a failed stale-path recovery stops loading and exposes attachment actions', async () => {
  const installedDom = installDom();
  const originalFetch = globalThis.fetch;
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
    globalThis.fetch = async () => { throw new Error('attachment no longer exists'); };

    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const missingMessage: Message = {
      role: 'user',
      text: '',
      time: '08:58',
      attachments: [{
        kind: 'image',
        name: 'Missing screenshot.png',
        sizeBytes: 429_724,
        attachmentId: 'att_missing_preview',
        previewAttachmentId: 'att_missing_preview',
        localPath: '/old-instance/tmp/attachments/missing.png',
        previewUrl: 'https://asset.localhost/old-instance/missing.png',
        mimeType: 'image/png',
      }],
    };
    await act(async () => root?.render(createElement(AttachmentPreview, { msg: missingMessage })));
    await flushReactUpdates();

    const staleImage = host.querySelector<HTMLImageElement>('[data-attachment-image-card="true"] img');
    assert.ok(staleImage);
    await act(async () => staleImage.dispatchEvent(new installedDom.dom.window.Event('error')));
    await flushReactUpdates();

    assert.ok(host.querySelector('[data-attachment-image-unavailable="true"]'));
    assert.equal(host.querySelector('[data-attachment-image-loading="true"]'), null);
    assert.match(host.textContent ?? '', /Preview unavailable/);
  } finally {
    if (root) await act(async () => root?.unmount());
    resetCloudAttachmentPreviewLoader();
    __setSessionBackendForTests(null);
    globalThis.fetch = originalFetch;
    installedDom.restore();
  }
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

test('detached media preview receives the active remote image URL before releasing its temporary lease', async () => {
  const installedDom = installDom();
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const originalOpen = window.open;
  const created: string[] = [];
  const revoked: string[] = [];
  let openedUrl = '';
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
    window.open = ((url?: string | URL) => {
      openedUrl = String(url ?? '');
      return { focus() {} } as Window;
    }) as typeof window.open;

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
    await flushReactUpdates();
    const requestId = new URL(openedUrl).searchParams.get('mediaPreviewRequest');
    assert.ok(requestId);
    const payload = JSON.parse(window.localStorage.getItem(`kordi:attachment-media:${requestId}`) ?? '');
    assert.equal(payload.initialPreviewUrl, created[0]);
    assert.equal(payload.attachments[0]?.attachmentId, 'remote-preview');
    assert.equal(revoked.includes(created[0] ?? ''), false, 'the mounted image card still owns the active URL');
  } finally {
    if (root) await act(async () => root?.unmount());
    resetCloudAttachmentPreviewLoader();
    __setSessionBackendForTests(null);
    globalThis.fetch = originalFetch;
    window.open = originalOpen;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    installedDom.restore();
  }
});

test('large image attachments render compressed preview with an original-file action', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: {
      ...imageMessage,
      attachments: [{
        ...imageMessage.attachments[0],
        name: 'Huge screenshot.png',
        sizeBytes: 24 * 1024 * 1024,
        previewUrl: 'data:image/webp;base64,compressed-preview',
        localPath: null,
      }],
    },
  }));

  assert.match(markup, /data-attachment-image-preview-trigger="true"/);
  assert.match(markup, /src="data:image\/webp;base64,compressed-preview"/);
  assert.match(markup, /data-attachment-original-action="true"/);
  assert.match(markup, /Open original/);
  assert.match(markup, /24 MB/);
  assert.doesNotMatch(markup, /data-attachment-image-loading="true"/);
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
