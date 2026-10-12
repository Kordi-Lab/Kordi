import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { resolveForwardAttachmentItems } from '../src/features/cloud/cloudAttachments';
import { uploadComposerAttachments } from '../src/features/cloud/cloudComposerAttachments';
import { normalizedCloudGroupOutboxPendingAttachments } from '../src/features/cloud/cloudGroupOutboxAttachmentCodec';
import { cloudGroupOutboxAttachmentSources } from '../src/features/cloud/cloudGroupOutboxAttachments';
import type { AttachmentItem } from '../src/features/chat/composerController.types';
import { DocumentReader } from '../src/features/documents/DocumentReader';
import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const forwardedDocument: AttachmentItem = {
  id: 'att_original',
  path: '/Users/example/Library/Kordi/attachments/related-work.md',
  localPath: '/Users/example/Library/Kordi/attachments/related-work.md',
  name: 'related-work.md',
  kind: 'file',
  mimeType: 'text/markdown',
  sizeBytes: 120,
  attachmentId: 'att_original',
  sourceAttachmentId: 'att_original',
};

function uploadOptions(overrides: Partial<Parameters<typeof uploadComposerAttachments>[0]> = {}) {
  const order: string[] = [];
  return {
    order,
    options: {
      token: 'token_example',
      client: { uploadAttachment: async () => { order.push('upload'); return { attachmentId: 'att_copy', sizeBytes: 120 } as never; } },
      attachments: [forwardedDocument],
      readAttachment: async () => [35, 32, 72, 105],
      useNativeUpload: false,
      persistAttachmentPath: async () => undefined,
      ...overrides,
    } satisfies Parameters<typeof uploadComposerAttachments>[0],
  };
}

test('forwarding marks Markdown and HTML attachments with their original id', async () => {
  const items = await resolveForwardAttachmentItems({
    token: 'token_example',
    client: { downloadAttachmentContent: async () => { throw new Error('not downloaded'); } },
    attachments: [
      { kind: 'file', name: 'related-work.md', attachmentId: 'att_md', localPath: '/Users/example/a.md' },
      { kind: 'file', name: 'page.htm', attachmentId: 'att_htm', localPath: '/Users/example/b.htm' },
      { kind: 'image', name: 'photo.png', attachmentId: 'att_png', localPath: '/Users/example/c.png' },
    ],
  });
  assert.deepEqual(items.map((item) => item.sourceAttachmentId ?? null), ['att_md', 'att_htm', null]);
  const restored = normalizedCloudGroupOutboxPendingAttachments(JSON.parse(JSON.stringify(cloudGroupOutboxAttachmentSources(items))));
  assert.deepEqual(restored?.map((item) => item.sourceAttachmentId ?? null), ['att_md', 'att_htm', null], 'the group outbox keeps the source id');
});

test('the upload links the copy to its original before the message is sent', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const { order, options } = uploadOptions();
  const uploaded = await uploadComposerAttachments({
    ...options,
    client: {
      ...options.client,
      request: async (path: string, init: RequestInit) => {
        order.push('link');
        calls.push({ path, body: JSON.parse(String(init.body)) });
        return undefined as never;
      },
    },
  });
  assert.deepEqual(order, ['upload', 'link']);
  assert.deepEqual(calls, [{ path: '/v1/cloud/documents/att_copy/source', body: { sourceAttachmentId: 'att_original' } }]);
  assert.equal(uploaded[0].attachmentId, 'att_copy', 'the message still carries the copy');
});

test('a failed link call is logged and the send goes on', async () => {
  const failures: unknown[] = [];
  const { options } = uploadOptions({
    linkDocumentSource: async () => { throw new Error('offline'); },
    reportLinkFailure: (error) => { failures.push(error); },
  });
  const uploaded = await uploadComposerAttachments(options);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].attachmentId, 'att_copy');
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /offline/);
});

test('the reader keys reactions and live updates by the canonical attachment, not the copy it was opened with', async () => {
  await withJsdomRoot(async (mount) => {
    const canonical = { ...sampleDocument('member'), requestedAttachmentId: 'att_copy' };
    const { api, calls } = createMemoryDocumentApi(canonical);
    const root = await mount(createElement(DocumentReader, { attachmentId: 'att_copy', api }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.deepEqual(calls.find((call) => call.method === 'getDocument')?.args, ['att_copy']);

    const thumbs = Array.from(root.querySelectorAll('button')).find((entry) => entry.getAttribute('aria-label')?.startsWith('👍'));
    await act(async () => { thumbs!.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    const toggle = calls.find((call) => call.method === 'toggleReaction');
    assert.deepEqual(toggle?.args[0], { kind: 'attachment', attachmentId: 'att_example_doc' });

    const fetches = () => calls.filter((call) => call.method === 'getDocument').length;
    const before = fetches();
    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_copy', revision: 3, change: 'annotations' } }]);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    assert.equal(fetches(), before, 'events for the copy id are not the document');
    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_example_doc', revision: 3, change: 'annotations' } }]);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    assert.equal(fetches(), before + 1, 'events for the canonical id refresh it');
    assert.deepEqual(calls.filter((call) => call.method === 'getDocument').at(-1)?.args, ['att_example_doc']);
  });
});
