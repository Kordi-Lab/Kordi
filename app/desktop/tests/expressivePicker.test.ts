import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  providerMediaAttachment,
  readExpressiveMediaLibrary,
  STICKER_FILE_ACCEPT,
  writeExpressiveMediaLibrary,
  type ExpressiveMediaLibraryItem,
} from '../src/features/emoji/expressiveMediaLibrary';
import {
  filterPublicMemeTemplates,
  normalizePublicStickerQuery,
  parsePublicMemeTemplates,
  publicStickerSearchUrl,
} from '../src/features/emoji/publicMemeTemplates';
import {
  normalizePublicGifQuery,
  parsePublicGifSearchResponse,
  publicGifSearchUrl,
} from '../src/features/emoji/publicGifSearch';

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

test('composer uses the complete Blob Emoji catalog and private sticker and GIF libraries', () => {
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
  assert.match(picker, /\['emoji', 'Blob Emoji'\]/);
  assert.match(picker, /<BlobEmojiPicker/);
  assert.match(picker, /\['stickers', 'Stickers'\]/);
  assert.match(picker, /\['gifs', 'GIFs'\]/);
  assert.match(picker, /My Stickers/);
  assert.match(picker, /My GIFs/);
  assert.match(picker, /STICKER_FILE_ACCEPT/);
  assert.match(picker, /GIF_FILE_ACCEPT/);
  assert.match(picker, /sendMedia\(expressiveMediaAttachment\(item\)\)/);
  assert.doesNotMatch(picker, /emoji-picker-react|EmojiStyle/);
  assert.doesNotMatch(picker, /PublicMemeGrid|PublicGifGrid|Public Stickers|Public GIFs/);
});

test('public GIF fallback searches Commons without a key and keeps reusable licenses only', () => {
  const searchUrl = new URL(publicGifSearchUrl('happy dance'));
  assert.equal(searchUrl.hostname, 'commons.wikimedia.org');
  assert.equal(searchUrl.searchParams.get('origin'), '*');
  assert.match(searchUrl.searchParams.get('gsrsearch') ?? '', /happy dance filemime:image\/gif/);
  assert.equal(normalizePublicGifQuery(''), 'funny');

  const results = parsePublicGifSearchResponse({
    query: {
      pages: [
        {
          pageid: 2,
          index: 2,
          title: 'File:Public dance.gif',
          imageinfo: [{
            mime: 'image/gif',
            size: 2048,
            url: 'https://upload.wikimedia.org/wikipedia/commons/public-dance.gif',
            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/public-dance.gif',
            extmetadata: { LicenseShortName: { value: 'Public domain' } },
          }],
        },
        {
          pageid: 1,
          index: 1,
          title: 'File:Zero dance.gif',
          imageinfo: [{
            mime: 'image/gif',
            size: 4096,
            url: 'https://upload.wikimedia.org/wikipedia/commons/zero-dance.gif',
            extmetadata: { LicenseShortName: { value: 'CC0' } },
          }],
        },
        {
          pageid: 3,
          index: 3,
          title: 'File:Needs attribution.gif',
          imageinfo: [{
            mime: 'image/gif',
            size: 1024,
            url: 'https://upload.wikimedia.org/wikipedia/commons/attribution.gif',
            extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
          }],
        },
        {
          pageid: 4,
          index: 4,
          title: 'File:Untrusted.gif',
          imageinfo: [{
            mime: 'image/gif',
            size: 1024,
            url: 'https://example.com/untrusted.gif',
            extmetadata: { LicenseShortName: { value: 'CC0' } },
          }],
        },
        {
          pageid: 5,
          index: 5,
          title: 'File:Too large.gif',
          imageinfo: [{
            mime: 'image/gif',
            size: 3 * 1024 * 1024,
            url: 'https://upload.wikimedia.org/wikipedia/commons/too-large.gif',
            extmetadata: { LicenseShortName: { value: 'CC0' } },
          }],
        },
      ],
    },
  });

  assert.deepEqual(results.map((result) => result.id), ['1', '2']);
  assert.equal(results[0]?.title, 'Zero dance');
  assert.equal(results[0]?.previewUrl, results[0]?.mediaUrl);
});

test('public sticker search uses keyless Commons results with reusable licenses', () => {
  const searchUrl = new URL(publicStickerSearchUrl('surprised cat'));
  assert.equal(searchUrl.hostname, 'commons.wikimedia.org');
  assert.equal(searchUrl.searchParams.get('origin'), '*');
  assert.match(searchUrl.searchParams.get('gsrsearch') ?? '', /surprised cat filetype:bitmap/);
  assert.equal(normalizePublicStickerQuery(''), 'reaction');

  const templates = parsePublicMemeTemplates({ query: { pages: [{
    pageid: 42,
    index: 1,
    title: 'File:Surprised cat.png',
    imageinfo: [{
      mime: 'image/png',
      size: 4096,
      url: 'https://upload.wikimedia.org/wikipedia/commons/surprised-cat.png',
      thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/surprised-cat.png',
      extmetadata: { LicenseShortName: { value: 'CC0' } },
    }],
  }, {
    pageid: 43,
    index: 2,
    title: 'File:Unlicensed cat.jpg',
    imageinfo: [{
      mime: 'image/jpeg',
      size: 4096,
      url: 'https://upload.wikimedia.org/wikipedia/commons/unlicensed-cat.jpg',
      extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
    }],
  }] } });

  assert.equal(templates.length, 1);
  assert.equal(templates[0]?.imageUrl, 'https://upload.wikimedia.org/wikipedia/commons/surprised-cat.png');
  assert.equal(filterPublicMemeTemplates(templates, 'surprised')[0]?.id, '42');
  assert.deepEqual(filterPublicMemeTemplates(templates, 'doge'), []);
});

test('public sticker results download as immediate image attachments', async () => {
  let storedName = '';
  let requestedRedirect: RequestRedirect | undefined;
  const originalWindow = Reflect.get(globalThis, 'window');
  Reflect.set(globalThis, 'window', {
    __TAURI_INTERNALS__: {
      convertFileSrc: (path: string) => `asset://${path}`,
    },
  });
  try {
    const attachment = await providerMediaAttachment({
      providerMediaId: 'wikimedia-sticker:42',
      mediaKind: 'sticker',
      title: 'Surprised Cat',
      mediaUrl: 'https://upload.wikimedia.org/wikipedia/commons/surprised-cat.jpg',
    }, {
      fetchFile: async (_input, init) => {
        requestedRedirect = init?.redirect;
        return {
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
        };
      },
      storeFile: async (name) => {
        storedName = name;
        return '/stored/ancient-aliens-guy.jpg';
      },
    });

    assert.equal(storedName, 'Surprised Cat.jpg');
    assert.equal(requestedRedirect, 'error');
    assert.equal(attachment.mimeType, 'image/jpeg');
    assert.match(attachment.id, /^provider:wikimedia-sticker:42:/);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Reflect.set(globalThis, 'window', originalWindow);
  }
});

test('public media rejects untrusted hosts and unsupported MIME types', async () => {
  let requested = false;
  await assert.rejects(
    providerMediaAttachment({
      providerMediaId: 'untrusted:1',
      mediaKind: 'sticker',
      title: 'Untrusted sticker',
      mediaUrl: 'https://example.com/sticker.png',
    }, {
      fetchFile: async () => {
        requested = true;
        return {
          ok: true,
          blob: async () => new Blob([], { type: 'image/png' }),
        };
      },
    }),
    /trusted media URL/,
  );
  assert.equal(requested, false);

  await assert.rejects(
    providerMediaAttachment({
      providerMediaId: 'wikimedia:svg',
      mediaKind: 'sticker',
      title: 'Vector sticker',
      mediaUrl: 'https://upload.wikimedia.org/wikipedia/commons/vector.svg',
    }, {
      fetchFile: async () => ({
        ok: true,
        blob: async () => new Blob([], { type: 'image/svg+xml' }),
      }),
    }),
    /not a supported image/,
  );

  await assert.rejects(
    providerMediaAttachment({
      providerMediaId: 'wikimedia:not-gif',
      mediaKind: 'gif',
      title: 'Static image',
      mediaUrl: 'https://upload.wikimedia.org/wikipedia/commons/static.png',
    }, {
      fetchFile: async () => ({
        ok: true,
        blob: async () => new Blob([], { type: 'image/png' }),
      }),
    }),
    /not a supported image/,
  );
});

test('expressive picker uses a compact narrow popover', () => {
  const styles = readFileSync(
    new URL('../src/styles/shell-expressive-picker.css', import.meta.url),
    'utf8',
  );

  assert.match(styles, /width: min\(20rem, calc\(100vw - 1\.5rem\)\)/);
  assert.match(styles, /height: min\(25rem, calc\(100vh - 7rem\)\)/);
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

test('sticker and GIF library pickers accept only their matching file types', () => {
  assert.equal(STICKER_FILE_ACCEPT, 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp');
  assert.equal(GIF_FILE_ACCEPT, 'image/gif,.gif');
  assert.equal(expressiveMediaFileError({ name: 'wave.webp', type: 'image/webp' }, 'sticker'), null);
  assert.match(
    expressiveMediaFileError({ name: 'wave.gif', type: 'image/gif' }, 'sticker') ?? '',
    /PNG, JPEG, or WebP/,
  );
  assert.equal(expressiveMediaFileError({ name: 'party.gif', type: 'image/gif' }, 'gif'), null);
  assert.match(
    expressiveMediaFileError({ name: 'party.png', type: 'image/png' }, 'gif') ?? '',
    /GIF file/,
  );
  assert.match(
    expressiveMediaFileError({ name: 'renamed.png', type: 'application/pdf' }, 'sticker') ?? '',
    /PNG, JPEG, or WebP/,
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

test('saved and public expressive media honor the attachment size limit', async () => {
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

  await assert.rejects(
    providerMediaAttachment({
      providerMediaId: 'wikimedia:large',
      mediaKind: 'gif',
      title: 'Large GIF',
      mediaUrl: 'https://upload.wikimedia.org/large.gif',
    }, {
      fetchFile: async () => ({
        ok: true,
        blob: async () => new Blob(
          [new Uint8Array(EXPRESSIVE_MEDIA_MAX_BYTES + 1)],
          { type: 'image/gif' },
        ),
      }),
    }),
    /2 MB attachment limit/,
  );
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
    new URL('../src/kordi-app/components/transcriptAttachments.tsx', import.meta.url),
    'utf8',
  );
  const action = readFileSync(
    new URL('../src/kordi-app/components/addAttachmentToMediaLibraryAction.tsx', import.meta.url),
    'utf8',
  );

  assert.match(attachments, /AddAttachmentToMediaLibraryAction/);
  assert.match(action, /Add to \{libraryName\}/);
  assert.match(action, /addMediaToExpressiveMediaLibrary/);
});
