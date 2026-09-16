import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { attachmentImageDisplaySize } from '../src/features/chat/attachmentMediaGallery';
import { cloudMessageMetadataOnly } from '../src/features/cloud/cloudMessageCache';

const conversation: ChatSyncConversation = {
  id: '019cb111-8ecc-7181-8266-8986d950169b',
  kind: 'direct',
  shared_title: null,
  version: 1,
  created_by_account_id: 'acct_a',
  legacy_session_id: 'session:direct:acct_a:acct_b',
  latest_message_sequence: 1,
  created_at: '2026-09-15T18:00:00Z',
  updated_at: '2026-09-15T18:20:00Z',
  members: [
    { account_id: 'acct_a', display_name: 'Alex', avatar_url: null, role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 1, last_read_sequence: 1, joined_at: '2026-09-15T18:00:00Z', left_at: null },
    { account_id: 'acct_b', display_name: 'Taylor', avatar_url: null, role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 1, last_read_sequence: 1, joined_at: '2026-09-15T18:00:00Z', left_at: null },
  ],
  preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169b', account_id: 'acct_b', personal_title: null, version: 1 },
};

// Exactly what the server returns for a sticker: kind "sticker", and attachment
// metadata with no subtype, because neither client puts one on the wire.
const stickerMessage: ChatSyncMessage = {
  id: '019cb2c9-0a77-7d84-b81b-97042279ad41',
  client_message_id: '019cb2c9-0a77-7d84-b81b-97042279ad40',
  conversation_id: conversation.id,
  conversation_sequence: 1,
  sender_account_id: 'acct_a',
  kind: 'sticker',
  content: {
    schema: 1,
    blocks: [{ type: 'text', text: '' }],
    legacy_attachments: [{
      attachmentId: 'att_sticker',
      name: 'wave.webp',
      kind: 'image',
      mimeType: 'image/webp',
      sizeBytes: 30 * 1024,
      widthPixels: 512,
      heightPixels: 512,
    }],
  },
  reply_to_message_id: null,
  attachment_ids: ['att_sticker'],
  version: 1,
  generation_status: null,
  provider_response_id: null,
  created_at: '2026-09-15T18:20:08Z',
  edited_at: null,
  deleted_at: null,
};

test('a synced sticker recovers its subtype from the message kind', () => {
  const mapped = cloudMessageFromChatSync(stickerMessage, conversation, 'acct_b');

  assert.equal(mapped.messageKind, 'sticker');
  assert.equal(mapped.attachments?.[0]?.subtype, 'sticker');
});

test('a synced sticker keeps expressive sizing instead of growing into an image card', () => {
  const mapped = cloudMessageFromChatSync(stickerMessage, conversation, 'acct_b');
  const attachment = mapped.attachments![0]!;

  // Stickers cap at 180px. Losing the subtype would size this at 464px and make
  // the optimistic bubble visibly re-render after the send lands.
  assert.deepEqual(attachmentImageDisplaySize(attachment), { width: 180, height: 180 });
});

test('cached sticker rows without a subtype still resolve as stickers', () => {
  const mapped = cloudMessageFromChatSync(stickerMessage, conversation, 'acct_b');
  const cached = cloudMessageMetadataOnly({
    ...mapped,
    attachments: mapped.attachments?.map(({ subtype: _dropped, ...rest }) => rest),
  });

  assert.equal(cached.attachments?.[0]?.subtype, 'sticker');
});
