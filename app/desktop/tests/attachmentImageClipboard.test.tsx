import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { installDom, flushReactUpdates } from './helpers/transcriptAttachmentDom';
import { copyAttachmentImage, imageBlobToClipboardPng } from '../src/features/chat/attachmentImageClipboard';
import { AttachmentActions } from '../src/kordi-app/components/transcriptAttachmentActions';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

test('local image copy reads the original native attachment bytes', async () => {
  const environment = installDom();
  const originalItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  let copied: Blob | undefined;
  class TestClipboardItem { constructor(readonly data: Record<string, Promise<Blob>>) {} }
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    write: (items: TestClipboardItem[]) => items[0]!.data['image/png']!.then((blob) => { copied = blob; }),
  } });
  mockIPC((command, payload) => {
    assert.equal(command, 'desktop_chat_read_attachment');
    assert.equal(payload?.path, '/tmp/synthetic-original.png');
    return [1, 2, 3, 4];
  });
  try {
    await copyAttachmentImage({ kind: 'image', name: 'Synthetic.png', mimeType: 'image/png', localPath: '/tmp/synthetic-original.png' });
    assert.deepEqual(Array.from(new Uint8Array(await copied!.arrayBuffer())), [1, 2, 3, 4]);
  } finally {
    clearMocks();
    if (originalItem) Object.defineProperty(globalThis, 'ClipboardItem', originalItem);
    else Reflect.deleteProperty(globalThis, 'ClipboardItem');
    environment.restore();
  }
});

test('remote image copy requests the original attachment using the current session', async () => {
  const environment = installDom();
  const originalItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  const download = CloudAuthClient.prototype.downloadAttachmentContent;
  const original = new Blob(['synthetic cloud original'], { type: 'image/png' });
  let copied: Blob | undefined;
  class TestClipboardItem { constructor(readonly data: Record<string, Promise<Blob>>) {} }
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    write: (items: TestClipboardItem[]) => items[0]!.data['image/png']!.then((blob) => { copied = blob; }),
  } });
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic-test-token', accountId: 'synthetic-account', expiresAt: '2099-01-01' }),
    save: async () => {}, clear: async () => {},
  });
  CloudAuthClient.prototype.downloadAttachmentContent = async (token, id) => {
    assert.equal(token, 'synthetic-test-token');
    assert.equal(id, 'synthetic-original-id');
    return original;
  };
  try {
    await copyAttachmentImage({ kind: 'image', name: 'Synthetic.png', attachmentId: 'synthetic-original-id', previewAttachmentId: 'synthetic-thumbnail-id' });
    assert.equal(copied, original);
    __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
    await assert.rejects(copyAttachmentImage({ kind: 'image', name: 'Synthetic.png', attachmentId: 'synthetic-original-id' }), /Sign in to copy/);
  } finally {
    CloudAuthClient.prototype.downloadAttachmentContent = download;
    __setSessionBackendForTests(null);
    if (originalItem) Object.defineProperty(globalThis, 'ClipboardItem', originalItem);
    else Reflect.deleteProperty(globalThis, 'ClipboardItem');
    environment.restore();
  }
});

test('Copy image writes during the click, waits for original bytes, and reports success or rejection', async () => {
  const environment = installDom();
  const originalFetch = globalThis.fetch;
  const originalItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  const original = new Blob(['synthetic original PNG'], { type: 'image/png' });
  let finishDownload!: (response: Response) => void;
  let requestedUrl = '';
  let writtenBlob: Blob | undefined;
  let writeCalls = 0;
  let rejectWrite = false;
  class TestClipboardItem {
    constructor(readonly data: Record<string, Promise<Blob>>) {}
  }
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    write(items: TestClipboardItem[]) {
      writeCalls += 1;
      if (rejectWrite) return Promise.reject(new Error('Clipboard access denied.'));
      return items[0]!.data['image/png']!.then((blob) => { writtenBlob = blob; });
    },
  } });
  globalThis.fetch = ((url: string) => {
    requestedUrl = url;
    return new Promise<Response>((resolve) => { finishDownload = resolve; });
  }) as typeof fetch;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AttachmentActions, {
      variant: 'menu', attachment: {
        kind: 'image', name: 'Synthetic.png', downloadUrl: 'https://files.test/original.png', previewUrl: 'https://files.test/thumbnail.png',
      },
    })));
    const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy image Synthetic.png"]')!;
    assert.ok(copy);
    await act(async () => {
      copy.click();
      assert.equal(writeCalls, 1, 'clipboard write starts synchronously before the image fetch resolves');
    });
    assert.equal(requestedUrl, 'https://files.test/original.png');
    assert.equal(copy.disabled, true);
    assert.match(host.textContent ?? '', /Copying image/);
    await act(async () => finishDownload(new Response(original, { headers: { 'content-type': 'image/png' } })));
    await flushReactUpdates();
    assert.equal(await writtenBlob?.text(), await original.text());
    assert.equal(copy.disabled, false);
    assert.match(host.textContent ?? '', /Image copied/);

    rejectWrite = true;
    await act(async () => copy.click());
    assert.match(host.textContent ?? '', /Clipboard access denied/);
    assert.doesNotMatch(host.textContent ?? '', /Image copied/);
    assert.equal(copy.disabled, false);
    await act(async () => finishDownload(new Response('', { status: 500 })));
    await flushReactUpdates();
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (originalItem) Object.defineProperty(globalThis, 'ClipboardItem', originalItem);
    else Reflect.deleteProperty(globalThis, 'ClipboardItem');
    environment.restore();
  }
});

test('image copying fails explicitly without clipboard support and never substitutes a thumbnail', async () => {
  const environment = installDom();
  const originalItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  try {
    Reflect.deleteProperty(globalThis, 'ClipboardItem');
    await assert.rejects(copyAttachmentImage({ kind: 'image', name: 'Synthetic.png' }), /Download the image instead/);
    class TestClipboardItem { constructor(readonly data: Record<string, Promise<Blob>>) {} }
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: (items: TestClipboardItem[]) => items[0]!.data['image/png'],
    } });
    await assert.rejects(copyAttachmentImage({ kind: 'image', name: 'Synthetic.png', previewUrl: 'https://files.test/thumbnail.png' }), /original image is not available/);
  } finally {
    if (originalItem) Object.defineProperty(globalThis, 'ClipboardItem', originalItem);
    else Reflect.deleteProperty(globalThis, 'ClipboardItem');
    environment.restore();
  }
});

test('non-PNG images are converted at natural resolution and release their temporary URL', async () => {
  const environment = installDom();
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const png = new Blob(['synthetic PNG pixels'], { type: 'image/png' });
  let revoked = '';
  let drawn = false;
  let failDecode = false;
  class TestImage {
    src = '';
    naturalWidth = 2400;
    naturalHeight = 1600;
    async decode() { if (failDecode) throw new Error('Invalid image'); }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: TestImage });
  URL.createObjectURL = () => 'blob:synthetic-image';
  URL.revokeObjectURL = (url) => { revoked = url; };
  const canvasPrototype = environment.dom.window.HTMLCanvasElement.prototype;
  Object.defineProperty(canvasPrototype, 'getContext', { value: () => ({ drawImage: () => { drawn = true; } }) });
  canvasPrototype.toBlob = function(callback, type) {
    assert.equal(this.width, 2400);
    assert.equal(this.height, 1600);
    assert.equal(type, 'image/png');
    callback(png);
  };
  try {
    assert.equal(await imageBlobToClipboardPng(new Blob(['synthetic JPEG'], { type: 'image/jpeg' })), png);
    assert.equal(drawn, true);
    assert.equal(revoked, 'blob:synthetic-image');
    revoked = '';
    failDecode = true;
    await assert.rejects(imageBlobToClipboardPng(new Blob(['invalid'])), /Invalid image/);
    assert.equal(revoked, 'blob:synthetic-image');
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage);
    else Reflect.deleteProperty(globalThis, 'Image');
    environment.restore();
  }
});
