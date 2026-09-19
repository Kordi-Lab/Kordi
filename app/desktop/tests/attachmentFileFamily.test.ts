import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachmentFileFamily,
  attachmentFileTileLabel,
  splitAttachmentName,
} from '../src/features/chat/attachmentFileFamily';

test('maps common extensions to a file family', () => {
  const cases: Array<[string, string]> = [
    ['paper.pdf', 'pdf'],
    ['notes.docx', 'doc'],
    ['readme.md', 'doc'],
    ['data.csv', 'sheet'],
    ['book.xlsx', 'sheet'],
    ['deck.pptx', 'slides'],
    ['train.py', 'code'],
    ['config.json', 'code'],
    ['bundle.zip', 'archive'],
    ['photo.HEIC', 'image'],
    ['clip.mp4', 'video'],
    ['voice.m4a', 'audio'],
    ['mockup.fig', 'design'],
    ['unknown.bin', 'generic'],
  ];

  for (const [name, family] of cases) {
    assert.equal(
      attachmentFileFamily({ name, mimeType: null, kind: 'file' }),
      family,
      name,
    );
  }
});

test('falls back to the mime type when the name has no extension', () => {
  assert.equal(attachmentFileFamily({ name: 'Untitled', mimeType: 'application/pdf', kind: 'file' }), 'pdf');
  assert.equal(attachmentFileFamily({ name: 'Untitled', mimeType: 'image/png', kind: 'file' }), 'image');
  assert.equal(attachmentFileFamily({ name: 'Untitled', mimeType: 'video/mp4', kind: 'file' }), 'video');
  assert.equal(attachmentFileFamily({ name: 'Untitled', mimeType: 'audio/mpeg', kind: 'file' }), 'audio');
  assert.equal(attachmentFileFamily({ name: 'Untitled', mimeType: null, kind: 'image' }), 'image');
  assert.equal(attachmentFileFamily({ name: 'Untitled', mimeType: null, kind: 'file' }), 'generic');
});

test('tile labels are capped at four characters', () => {
  assert.equal(attachmentFileTileLabel('PDF'), 'PDF');
  assert.equal(attachmentFileTileLabel('markdown'), 'MARK');
  assert.equal(attachmentFileTileLabel(''), 'FILE');
});

test('splits the name so the extension survives truncation', () => {
  assert.deepEqual(splitAttachmentName('2027ICLR_v6 copy.pdf'), { base: '2027ICLR_v6 copy', extension: '.pdf' });
  assert.deepEqual(splitAttachmentName('report.PDF'), { base: 'report', extension: '.PDF' });
  assert.deepEqual(splitAttachmentName('no-extension'), { base: 'no-extension', extension: '' });
  assert.deepEqual(splitAttachmentName(''), { base: '', extension: '' });
});
