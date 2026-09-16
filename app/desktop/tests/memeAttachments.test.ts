import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSupportedMemeImage,
  memeAttachmentDraftError,
} from '../src/features/chat/memeAttachments';
import type { AttachmentItem } from '../src/features/chat/composerController.types';
import {
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';

function meme(overrides: Partial<AttachmentItem> = {}): AttachmentItem {
  return {
    id: 'meme-1',
    name: 'reaction.png',
    path: '/tmp/reaction.png',
    kind: 'image',
    mimeType: 'image/png',
    subtype: 'meme',
    altText: 'A surprised cat reacts to a passing test suite.',
    memeRightsConfirmed: true,
    ...overrides,
  };
}

test('meme policy accepts only PNG, JPEG, GIF, and WebP images', () => {
  assert.equal(isSupportedMemeImage(meme()), true);
  assert.equal(isSupportedMemeImage(meme({ mimeType: 'image/webp' })), true);
  assert.equal(isSupportedMemeImage(meme({ mimeType: undefined, name: 'reaction.gif' })), true);
  assert.equal(isSupportedMemeImage(meme({ mimeType: 'image/svg+xml' })), false);
  assert.equal(isSupportedMemeImage(meme({ kind: 'file' })), false);
});

test('meme policy requires alt text and an explicit rights confirmation', () => {
  assert.equal(memeAttachmentDraftError([meme()]), null);
  assert.match(memeAttachmentDraftError([meme({ altText: '  ' })]) ?? '', /Add alt text/);
  assert.match(
    memeAttachmentDraftError([meme({ memeRightsConfirmed: false })]) ?? '',
    /permission or another legal right/,
  );
  assert.match(
    memeAttachmentDraftError([meme({ altText: 'a'.repeat(501) })]) ?? '',
    /500 characters or fewer/,
  );
});

test('retry validation preserves accessibility metadata without asking for rights twice', () => {
  assert.equal(
    memeAttachmentDraftError(
      [meme({ memeRightsConfirmed: undefined })],
      { requireRightsConfirmation: false },
    ),
    null,
  );
});

test('canonical sync preserves meme metadata for older-client image fallback', () => {
  const conversation = {
    id: 'conversation-1',
    kind: 'direct',
    members: [],
    latest_message_sequence: 1,
  } as unknown as ChatSyncConversation;
  const message = {
    id: 'message-1',
    sender_account_id: 'acct-a',
    attachment_ids: ['att-meme'],
    content: {
      schema: 1,
      blocks: [{ type: 'text', text: '' }],
      legacy_attachments: [{
        attachmentId: 'att-meme',
        name: 'reaction.gif',
        kind: 'image',
        subtype: 'meme',
        altText: 'A developer celebrates after the final test turns green.',
        mimeType: 'image/gif',
      }],
    },
  } as unknown as ChatSyncMessage;

  const mapped = cloudMessageFromChatSync(message, conversation, 'acct-b');

  assert.equal(mapped.attachments?.[0]?.kind, 'image');
  assert.equal(mapped.attachments?.[0]?.subtype, 'meme');
  assert.equal(mapped.attachments?.[0]?.altText, 'A developer celebrates after the final test turns green.');
});
