import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';
import { resetCloudAttachmentPreviewLoader } from '../src/features/cloud/cloudAttachments';
import { __setSessionBackendForTests, type SessionStorageBackend } from '../src/features/cloud/session';
import type { Message } from '../src/kordi-app/types';
import { installDom, flushReactUpdates } from './helpers/transcriptAttachmentDom';

test('detached media preview keeps its image lease after card unmount until the window closes', async () => {
  const installedDom = installDom();
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const originalOpen = window.open;
  const created: string[] = [];
  const revoked: string[] = [];
  let openedUrl = '';
  const popup = { closed: false, focus() {} };
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
      return popup as unknown as Window;
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
    await act(async () => root?.unmount()); root = null;
    resetCloudAttachmentPreviewLoader();
    assert.equal(revoked.includes(created[0] ?? ''), false, 'the media window owns the URL after the card leaves');
    popup.closed = true;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    assert.equal(revoked.includes(created[0] ?? ''), true, 'closing the media window releases its last lease');
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

test('a previously loaded image remounts directly from cache without a loading tile or another download', async () => {
  const installed = installDom();
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  let root: Root | null = null;
  let downloads = 0, inspectingRemount = false, loadingCommits = 0;
  try {
    resetCloudAttachmentPreviewLoader();
    __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'synthetic', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
    globalThis.fetch = async () => { downloads += 1; return new Response(new Blob(['synthetic'])); };
    URL.createObjectURL = () => 'blob:warm-image';
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const msg: Message = { role: 'person', text: '', time: '12:00', attachments: [{ kind: 'image', name: 'Warm.png', attachmentId: 'warm-image', previewAttachmentId: 'warm-preview' }] };
    const view = () => createElement(Profiler, { id: 'warm', onRender: () => {
      if (inspectingRemount && host.querySelector('[data-attachment-image-loading="true"]')) loadingCommits += 1;
    } }, createElement(AttachmentPreview, { msg }));
    await act(async () => root?.render(view())); await flushReactUpdates();
    const img = host.querySelector('img')!;
    Object.defineProperties(img, { naturalWidth: { value: 640 }, naturalHeight: { value: 320 } });
    await act(async () => img.dispatchEvent(new installed.dom.window.Event('load')));
    const firstDownloads = downloads;
    await act(async () => root?.render(null));
    inspectingRemount = true;
    await act(async () => root?.render(view())); await flushReactUpdates();
    assert.equal(downloads, firstDownloads);
    assert.equal(loadingCommits, 0);
    assert.equal(host.querySelector('img')?.getAttribute('src'), 'blob:warm-image');
    assert.equal(host.querySelector('[data-attachment-image-preview-trigger]')?.getAttribute('style')?.includes('aspect-ratio: 464 / 232'), true);
  } finally {
    if (root) await act(async () => root?.unmount());
    resetCloudAttachmentPreviewLoader(); __setSessionBackendForTests(null);
    globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; installed.restore();
  }
});
