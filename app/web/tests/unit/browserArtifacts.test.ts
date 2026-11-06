import assert from 'node:assert/strict';
import test from 'node:test';
import { browserArtifactBlobPreview, fetchBrowserArtifactPreview } from '@web/runtime/browserArtifactPreview';
import { runBrowserAttachmentCommand, storeBrowserAttachment, clearBrowserAttachments } from '@web/runtime/browserAttachments';

test('browser artifact text previews preserve native line normalization and byte/line limits', async () => {
  const preview = await browserArtifactBlobPreview('result.ts', new Blob(['first\r\nsecond\n']));
  assert.deepEqual(preview, { path: 'result.ts', lines: [
    { number: 1, text: 'first' }, { number: 2, text: 'second' }, { number: 3, text: '' },
  ], truncated: false });
  const many = await browserArtifactBlobPreview('large.txt', new Blob([Array.from({ length: 405 }, () => 'line').join('\n')]));
  assert.equal(many.lines.length, 400); assert.equal(many.truncated, true);
  const bytes = await browserArtifactBlobPreview('large.txt', new Blob(['x'.repeat(70_000)]));
  assert.equal(bytes.lines[0].text.length, 65_536); assert.equal(bytes.truncated, true);
});

test('browser artifacts never fetch arbitrary agent filesystem paths and reject binary text', async () => {
  await assert.rejects(fetchBrowserArtifactPreview('/agent/project/file.txt', null), /stored on the agent/);
  await assert.rejects(browserArtifactBlobPreview('binary.dat', new Blob(['a\0b'])), /binary file/);
});

test('cloud artifact images use bounded authorized bytes rather than agent filesystem URLs', async () => {
  const preview = await browserArtifactBlobPreview('/agent/image.png', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
  assert.equal(preview.lines[0].text, 'data:image/png;base64,iVBORw==');
  assert.equal(preview.truncated, false);
  await assert.rejects(browserArtifactBlobPreview('huge.png', new Blob([new Uint8Array(8 * 1024 * 1024 + 1)])), /too large/);
});

test('Save As downloads the owned browser blob and refuses arbitrary paths', async () => {
  const previous = (globalThis as { document?: unknown }).document;
  const downloads: string[] = [];
  const anchor = { href: '', download: '', click() { downloads.push(`${this.href}:${this.download}`); }, remove() {} };
  (globalThis as { document?: unknown }).document = { createElement: () => anchor, body: { appendChild() {} } };
  try {
    const attachment = storeBrowserAttachment(new Blob(['notes']), 'notes.txt');
    assert.equal(await runBrowserAttachmentCommand('desktop_save_attachment_as', { path: attachment.path, name: 'saved.txt' }), attachment.path);
    assert.deepEqual(downloads, [`${attachment.path}:saved.txt`]);
    await assert.rejects(runBrowserAttachmentCommand('desktop_save_attachment_as', { path: '/arbitrary/path' }), /no longer available/);
  } finally {
    clearBrowserAttachments();
    if (previous === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = previous;
  }
});
