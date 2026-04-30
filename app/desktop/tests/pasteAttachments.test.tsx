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

test('extractPastedLocalFilePaths accepts a pasted absolute temp image path', () => {
  assert.deepEqual(
    extractPastedLocalFilePaths('/var/folders/sj/clipboard/pi-clipboard.png'),
    ['/var/folders/sj/clipboard/pi-clipboard.png'],
  );
});

test('extractPastedLocalFilePaths accepts file uri lists and decodes spaces', () => {
  assert.deepEqual(
    extractPastedLocalFilePaths('ignored display text', '# copied file\nfile:///Users/shuyang/Desktop/My%20Image.png'),
    ['/Users/shuyang/Desktop/My Image.png'],
  );
});

test('extractPastedLocalFilePaths ignores ordinary prose containing slashes', () => {
  assert.deepEqual(
    extractPastedLocalFilePaths('please inspect /var/folders/sj/clipboard/pi-clipboard.png'),
    [],
  );
});
