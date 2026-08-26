import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildConversationPreview } from '../src/app/viewModels/helpers';
import { safePreviewText } from '../src/features/chat/participantConversationState';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { Conversation, Message } from '../src/kordi-app/types';

const imageMessage: Message = {
  id: 'message:image:1',
  role: 'user',
  sender: 'Shu Yang',
  text: '',
  time: '14:29',
  attachments: [{ kind: 'image', name: 'preview.png', mimeType: 'image/png' }],
};

test('buildConversationPreview labels an image-only message as Photo instead of using the fallback name', () => {
  assert.equal(buildConversationPreview([imageMessage], 'Shu Yang'), 'Photo');
});

test('sidebar previews replace Blob Emoji transport tokens with a readable label', () => {
  const message = { ...imageMessage, text: ':blob:ablobcaramelldansen:', attachments: [] };
  assert.equal(safePreviewText('hi :blob:blobwave:'), 'hi Emoji');
  assert.equal(buildConversationPreview([message]), 'Emoji');
});

test('buildParticipantSpaces presents an image-only self message as a photo', () => {
  const conversation: Conversation = {
    id: 'session:saved-photo',
    canonicalSessionId: 'session:saved-photo',
    name: 'Shu Yang',
    type: 'owned-agent',
    subtitle: 'Shu Yang',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Local',
    directness: 'Self chat',
    participants: ['Me', 'My Kordi'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Shu Yang', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'agent:my-kordi', name: 'My Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-kordi' },
    ],
    messages: [imageMessage],
    updatedAtLabel: '14:29',
  };
  const spaces = buildParticipantSpaces([conversation]);

  assert.equal(spaces[0]?.title, 'Saved Messages');
  assert.equal(spaces[0]?.preview, 'Photo');
  assert.equal(spaces[0]?.sessions[0]?.preview, 'Photo');
});
