import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageContextMenuContent } from '../src/kordi-app/components/transcript';
import { messageContextMenuMediaAttachment } from '../src/kordi-app/components/messageContextMenuTarget';
import { messageSnapshotKey } from '../src/kordi-app/components/transcriptMessageSnapshot';
import type { Message } from '../src/kordi-app/types';

test('image messages use the iOS-aligned unified action menu', () => {
  const attachment = {
    kind: 'image' as const,
    name: 'reaction-reference.png',
    sizeBytes: 128_000,
    attachmentId: 'attachment-id',
    localPath: null,
    previewUrl: 'https://files.test/reaction-reference.png',
    mimeType: 'image/png',
  };
  const message: Message = {
    id: 'msg:image-actions',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: '',
    time: '10:42',
    attachments: [attachment],
    reactionConversationId: 'conversation-id',
    reactionTargetMessageId: 'message-id',
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    mediaAttachment: attachment,
    mediaGallery: [attachment],
    onReactMessage: () => undefined,
    onReplyMessage: () => undefined,
    onForwardMessage: () => undefined,
    onSelectMessage: () => undefined,
    onRequestPinMessage: () => undefined,
  }));

  assert.match(markup, /data-message-context-menu-reactions="true"/);
  assert.match(markup, /data-message-context-menu-action="review-attachment"/);
  assert.match(markup, />Review</);
  assert.match(markup, />Download</);
  assert.match(markup, />Add to My Stickers</);
  assert.ok(markup.indexOf('>Reply<') < markup.indexOf('>Forward<'));
  assert.ok(markup.indexOf('>Forward<') < markup.indexOf('>Pin<'));
  assert.ok(markup.indexOf('>Pin<') < markup.indexOf('>Select<'));
});

test('image right-click resolves the selected attachment from the shared message host', () => {
  const first = { kind: 'image' as const, name: 'first.png', previewUrl: 'data:image/png;base64,first' };
  const second = { kind: 'image' as const, name: 'second.png', previewUrl: 'data:image/png;base64,second' };
  const card = { getAttribute: () => '1' };
  const target = { closest: () => card } as unknown as Element;

  assert.equal(messageContextMenuMediaAttachment({
    id: 'msg:images',
    role: 'person',
    text: '',
    time: '10:42',
    attachments: [first, second],
  }, target), second);
});

test('sticker right-click defers media actions to the standard message menu', () => {
  const sticker = {
    kind: 'image' as const,
    subtype: 'sticker' as const,
    name: 'wave.png',
    previewUrl: 'data:image/png;base64,sticker',
  };
  const card = { getAttribute: () => '0' };
  const target = { closest: () => card } as unknown as Element;

  assert.equal(messageContextMenuMediaAttachment({
    id: 'msg:sticker',
    role: 'person',
    text: '',
    time: '10:42',
    messageKind: 'sticker',
    attachments: [sticker],
  }, target), null);
});

test('message snapshot invalidates when reaction capability or reaction state changes', () => {
  const message: Message = {
    id: 'msg:reaction-snapshot',
    role: 'person',
    text: 'React here',
    time: '10:42',
  };
  const synced = {
    ...message,
    reactionConversationId: 'conversation-id',
    reactionTargetMessageId: 'message-id',
  };
  const reacted = {
    ...synced,
    reactions: [{ value: 'blob:blobwave', accountIds: ['account-id'] }],
  };

  assert.notEqual(messageSnapshotKey(message), messageSnapshotKey(synced));
  assert.notEqual(messageSnapshotKey(synced), messageSnapshotKey(reacted));
});
