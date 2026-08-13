import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractClipboardFiles,
  extractPastedLocalFilePaths,
} from '../src/features/chat/pasteAttachments';

test('extractClipboardFiles falls back to clipboard item files when clipboard files is empty', () => {
  const pastedImage = {
    name: 'screenshot.png',
    size: 1234,
    type: 'image/png',
    lastModified: 42,
  } as File;

  const files = extractClipboardFiles({
    files: [] as unknown as FileList,
    items: [{ kind: 'file', getAsFile: () => pastedImage }] as unknown as DataTransferItemList,
  });

  assert.deepEqual(files, [pastedImage]);
});

test('extractClipboardFiles dedupes one pasted image exposed through files and items with different modification times', () => {
  const pastedImageFromFiles = {
    name: 'image.png',
    size: 246000,
    type: 'image/png',
    lastModified: 100,
  } as File;
  const pastedImageFromItems = {
    name: 'image.png',
    size: 246000,
    type: 'image/png',
    lastModified: 200,
  } as File;

  const files = extractClipboardFiles({
    files: [pastedImageFromFiles] as unknown as FileList,
    items: [{ kind: 'file', getAsFile: () => pastedImageFromItems }] as unknown as DataTransferItemList,
  });

  assert.deepEqual(files, [pastedImageFromFiles]);
});

test('extractPastedLocalFilePaths ignores plain text paths so they stay composer text', () => {
  assert.deepEqual(extractPastedLocalFilePaths('/var/folders/sj/clipboard/pi-clipboard.png'), []);
  assert.deepEqual(extractPastedLocalFilePaths('~/Desktop/report.pdf'), []);
  assert.deepEqual(extractPastedLocalFilePaths('C:\\Users\\me\\report.pdf'), []);
  assert.deepEqual(extractPastedLocalFilePaths('/Users/example/kordi-worktrees/issue-202-provider-stream-retry/app/desktop/src-tauri'), []);
});

test('extractPastedLocalFilePaths accepts file uri lists and decodes spaces', () => {
  assert.deepEqual(
    extractPastedLocalFilePaths('ignored display text', '# copied file\nfile:///Users/example/Desktop/My%20Image.png'),
    ['/Users/example/Desktop/My Image.png'],
  );
});

test('extractPastedLocalFilePaths ignores ordinary prose containing slashes', () => {
  assert.deepEqual(
    extractPastedLocalFilePaths('please inspect /var/folders/sj/clipboard/pi-clipboard.png'),
    [],
  );
});

test('extractPastedLocalFilePaths ignores non-file uri-list entries', () => {
  assert.deepEqual(
    extractPastedLocalFilePaths('', '/var/folders/sj/clipboard/pi-clipboard.png\nhttps://example.test/file.txt'),
    [],
  );
});
