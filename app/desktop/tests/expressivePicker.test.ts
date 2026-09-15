import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  blobEmojiAssetUrl,
  blobEmojiCatalog,
  blobEmojiPlainText,
  blobEmojiTextParts,
} from '../src/features/emoji/blobEmoji';
import {
  insertEmojiAtSelection,
  normalizeEmojiSelection,
} from '../src/features/emoji/emojiText';
import {
  EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY,
  EXPRESSIVE_MEDIA_MAX_BYTES,
  addMediaToExpressiveMediaLibrary,
  expressiveMediaFileError,
  expressiveMediaKindForFile,
  GIF_FILE_ACCEPT,
  readExpressiveMediaLibrary,
  STICKER_FILE_ACCEPT,
  writeExpressiveMediaLibrary,
  type ExpressiveMediaLibraryItem,
} from '../src/features/emoji/expressiveMediaLibrary';

test('emoji insertion preserves the requested caret position', () => {
  assert.deepEqual(
    insertEmojiAtSelection('Ship today', '🚀', { start: 5, end: 5 }),
    {
      value: 'Ship 🚀today',
      selection: { start: 7, end: 7 },
    },
  );
});

test('emoji insertion does not split an existing grapheme cluster', () => {
  const family = '👨‍👩‍👧‍👦';
  const value = `A${family}B`;
  const selection = normalizeEmojiSelection(value, { start: 2, end: 2 });
  assert.deepEqual(selection, { start: 1, end: 1 });
  assert.equal(
    insertEmojiAtSelection(value, '✨', { start: 2, end: 2 }).value,
    `A✨${family}B`,
  );
});

test('composer uses the shared Emoji picker and private sticker and GIF libraries', () => {
  const picker = readFileSync(
    new URL('../src/features/emoji/ComposerExpressivePicker.tsx', import.meta.url),
    'utf8',
  );
  const catalog = JSON.parse(readFileSync(
    new URL('../../../shared/blob-emoji/catalog.json', import.meta.url),
    'utf8',
  )) as { emoji: Array<{ animated: boolean }> };

  assert.equal(catalog.emoji.length, 547);
  assert.equal(catalog.emoji.filter((emoji) => emoji.animated).length, 173);
  assert.match(picker, /\['emoji', 'Emoji'\]/);
  assert.match(picker, /<EmojiPicker/);
  assert.match(picker, /\['stickers', 'Stickers'\]/);
  assert.match(picker, /\['gifs', 'GIFs'\]/);
  assert.match(picker, /My Stickers/);
  assert.match(picker, /My GIFs/);
  assert.match(picker, /STICKER_FILE_ACCEPT/);
  assert.match(picker, /GIF_FILE_ACCEPT/);
  assert.match(picker, /sendMedia\(expressiveMediaAttachment\(item\)\)/);
  assert.match(picker, /async function sendMedia[\s\S]*?if \(mediaSendPendingRef\.current\) return;[\s\S]*?setIsOpen\(false\);[\s\S]*?await onSendMedia\(attachment\)/);
  assert.doesNotMatch(picker, /emoji-picker-react|EmojiStyle/);
  assert.doesNotMatch(picker, /Public Stickers|Public GIFs/);
});

test('Blob Emoji assets are content addressed and excluded from the desktop bundle', () => {
  assert.equal(existsSync(new URL('../public/blob-emoji', import.meta.url)), false);
  assert.equal(blobEmojiCatalog.length, 547);
  for (const emoji of blobEmojiCatalog) {
    const bytes = readFileSync(new URL(`../../../shared/blob-emoji/assets/${emoji.file}`, import.meta.url));
    assert.match(emoji.sha256, /^[a-f0-9]{64}$/);
    assert.equal(emoji.sizeBytes, bytes.length);
    assert.equal(emoji.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  const emoji = blobEmojiCatalog[0];
  assert.equal(
    blobEmojiAssetUrl(emoji, 'https://assets.example'),
    `https://assets.example/assets/blob-emoji/${emoji.sha256}/${emoji.file}`,
  );
});

test('Blob Emoji tokens keep images for rich surfaces and readable notification text', () => {
  const parts = blobEmojiTextParts('Hi :blob:blobwave: :blob:not-real:');

  assert.equal(parts.filter((part) => part.type === 'emoji').length, 1);
  assert.equal(blobEmojiPlainText('Hi :blob:blobwave:'), 'Hi Emoji');
  assert.equal(blobEmojiPlainText(':blob:not-real:'), ':blob:not-real:');
});

test('expressive picker uses a dense five-column scrollable popover', () => {
  const styles = readFileSync(
    new URL('../src/styles/shell-expressive-picker.css', import.meta.url),
    'utf8',
  );

  assert.match(styles, /width: min\(25rem, calc\(100vw - 1\.5rem\)\)/);
  assert.match(styles, /height: min\(25rem, calc\(100vh - 7rem\)\)/);
  assert.match(styles, /app-expressive-picker-media-panel[\s\S]*?overflow-y: auto/);
  assert.match(styles, /app-expressive-picker-media-grid[\s\S]*?repeat\(5, minmax\(0, 1fr\)\)/);
});

test('expressive picker trigger sits in the left action row beside the attachment control', () => {
  const composer = readFileSync(
    new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url),
    'utf8',
  );
  const leftActions = composer.match(
    /data-composer-left-actions="true"[\s\S]*?<ComposerAttachmentAddMenu[\s\S]*?<ComposerExpressivePicker[\s\S]*?<\/div>/,
  )?.[0] ?? '';

  assert.match(leftActions, /<ComposerAttachmentAddMenu/);
  assert.match(leftActions, /<ComposerExpressivePicker/);
  assert.match(leftActions, /key=\{cloudAccountId\?\.trim\(\) \|\| 'local'\}/);
  assert.match(leftActions, /onSendMedia=\{\(attachment\) => onSend\('', \[attachment\]\)\}/);
  assert.doesNotMatch(composer, /data-composer-input-adjacent-actions/);
});

test('sticker and GIF library pickers accept their supported file types', () => {
  assert.equal(STICKER_FILE_ACCEPT, 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif');
  assert.equal(GIF_FILE_ACCEPT, 'image/gif,.gif');
  assert.equal(expressiveMediaFileError({ name: 'wave.webp', type: 'image/webp' }, 'sticker'), null);
  assert.equal(expressiveMediaFileError({ name: 'wave.gif', type: 'image/gif' }, 'sticker'), null);
  assert.equal(expressiveMediaFileError({ name: 'party.gif', type: 'image/gif' }, 'gif'), null);
  assert.match(
    expressiveMediaFileError({ name: 'party.png', type: 'image/png' }, 'gif') ?? '',
    /GIF file/,
  );
  assert.match(
    expressiveMediaFileError({ name: 'renamed.png', type: 'application/pdf' }, 'sticker') ?? '',
    /PNG, JPEG, WebP, or GIF/,
  );
  assert.match(
    expressiveMediaFileError({ name: 'renamed.gif', type: 'image/png' }, 'gif') ?? '',
    /GIF file/,
  );
  assert.equal(expressiveMediaKindForFile({ name: 'party.gif', type: 'image/gif' }), 'gif');
  assert.equal(expressiveMediaKindForFile({ name: 'wave.webp', type: 'image/webp' }), 'sticker');
  assert.equal(expressiveMediaKindForFile({ name: 'notes.pdf', type: 'application/pdf' }), null);
});

test('existing message media can be copied directly into My Stickers', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  const item = await addMediaToExpressiveMediaLibrary({
    name: 'wave.webp',
    mimeType: 'image/webp',
    sizeBytes: 3,
    data: [1, 2, 3],
  }, 'sticker', {
    storage,
    storeFile: async () => '/stored/wave.webp',
    now: () => 456,
  });

  assert.equal(item.kind, 'sticker');
  assert.deepEqual(readExpressiveMediaLibrary(storage), [item]);
});

test('saved expressive media honors the attachment size limit', async () => {
  let stored = false;
  await assert.rejects(
    addMediaToExpressiveMediaLibrary({
      name: 'large.png',
      mimeType: 'image/png',
      sizeBytes: EXPRESSIVE_MEDIA_MAX_BYTES + 1,
      data: [],
    }, 'sticker', {
      storage: null,
      storeFile: async () => {
        stored = true;
        return '/stored/large.png';
      },
    }),
    /smaller than 2 MB/,
  );
  assert.equal(stored, false);
});

test('My Stickers and My GIFs persist as a media library instead of composer drafts', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const item: ExpressiveMediaLibraryItem = {
    id: 'sticker:/stored/wave.webp',
    kind: 'sticker',
    name: 'wave.webp',
    path: '/stored/wave.webp',
    mimeType: 'image/webp',
    sizeBytes: 42,
    createdAtMs: 123,
  };

  writeExpressiveMediaLibrary([item], storage);

  assert.equal(values.has(EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY), true);
  assert.deepEqual(readExpressiveMediaLibrary(storage), [item]);
});

test('saved media exposes the management menu without redundant guidance', () => {
  const picker = readFileSync(
    new URL('../src/features/emoji/ComposerExpressivePicker.tsx', import.meta.url),
    'utf8',
  );

  assert.match(picker, /onClick=\{\(\) => void sendMedia/);
  assert.match(picker, /onContextMenu=/);
  assert.match(picker, /event\.shiftKey && event\.key === 'F10'/);
  assert.match(picker, /data-expressive-media-menu="true"/);
  assert.match(picker, /deleteExpressiveMediaLibraryItem/);
  assert.doesNotMatch(picker, /Added media stays in your library/);
});

test('media selection uses an explicit attachment override for immediate send', () => {
  const workspace = readFileSync(
    new URL('../src/pages/chatsPage.mainWorkspace.tsx', import.meta.url),
    'utf8',
  );
  const messageActions = readFileSync(
    new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    workspace,
    /runtime\.onSendChatMessage\([\s\S]*?draftOverride,[\s\S]*?attachmentOverride,[\s\S]*?\)/,
  );
  assert.match(
    messageActions,
    /retryAttachments \?\? attachmentOverride \?\? chatComposerAttachments/,
  );
  assert.match(messageActions, /preserveComposer = attachmentOverride !== undefined/);
});

test('image context menu can save received media into the matching expressive library', () => {
  const attachments = readFileSync(
    new URL('../src/kordi-app/components/transcriptAttachmentContextMenu.tsx', import.meta.url),
    'utf8',
  );
  const action = readFileSync(
    new URL('../src/kordi-app/components/addAttachmentToMediaLibraryAction.tsx', import.meta.url),
    'utf8',
  );

  assert.match(attachments, /AddAttachmentToMediaLibraryAction/);
  assert.match(action, /attachment\.subtype === 'sticker'[\s\S]*Save to \$\{libraryName\}/);
  assert.match(action, /addMediaToExpressiveMediaLibrary/);
});
