import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { withoutVoiceAttachment } from '../src/features/cloud/cloudVoiceMessage';
import { buildConversationPreview } from '../src/app/viewModels/helpers';
import { attachmentOnlyMessagePreview, latestParticipantSpacePreviewMessage } from '../src/features/chat/participantConversationState';
import type { CanonicalSessionMessage, Conversation, Message } from '../src/kordi-app/types';

const audio = { attachmentId: 'audio-v1', kind: 'file' as const, name: 'Voice message.m4a', mimeType: 'audio/mp4' };
const document = { attachmentId: 'notes-v1', kind: 'file' as const, name: 'Notes.pdf', mimeType: 'application/pdf' };
const row: CanonicalSessionMessage = {
  id: 'voice-fixture', sessionId: 'group:voice-fixture', senderIdentityId: 'human:fixture', senderRole: 'person',
  messageKind: 'voice', contentText: '', content: {}, status: 'received', sequenceNum: 1,
  createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group',
};

for (const status of ['pending', 'ready', 'failed', 'unavailable'] as const) {
  test(`persisted ${status} voice recordings render without a duplicate file or attachment preview`, () => {
    const voice = { mediaId: audio.attachmentId, mimeType: audio.mimeType, durationMs: 2000,
      waveformSamples: [0.2], transcript: status === 'ready' ? 'Meet at noon.' : '',
      transcription: { status, sourceVersion: audio.attachmentId, engine: 'apple-speech-v1' as const, attempts: 1 } };
    const mapped = mapCanonicalMessage({ ...row, content: { voiceMessage: voice, attachments: [audio] } }, new Map());
    assert.ok(mapped?.voiceMessage);
    assert.deepEqual(mapped.attachments, []);
    assert.equal(mapped.voiceMessage.mediaId, audio.attachmentId);
    const expectedPreview = voice.transcript || 'Voice message';
    assert.equal(buildConversationPreview([mapped]), expectedPreview);
    const conversation = { messages: [mapped] } as Conversation;
    assert.equal(latestParticipantSpacePreviewMessage(conversation)?.preview, expectedPreview);
    // Old hydrated state must not select a file thumbnail before the projection refreshes.
    assert.equal(attachmentOnlyMessagePreview({ ...mapped, attachments: [audio] }), null);
  });
}

test('voice normalization preserves unrelated attachments and ordinary imported audio', () => {
  const voice = { mediaId: audio.attachmentId, mimeType: audio.mimeType, durationMs: 2000,
    waveformSamples: [0.2], transcript: '' };
  const mapped = mapCanonicalMessage({ ...row, content: { voiceMessage: voice, attachments: [audio, document] } }, new Map());
  assert.deepEqual(mapped?.attachments?.map(attachment => attachment.attachmentId), [document.attachmentId]);
  const attachments = [audio, document];
  assert.deepEqual(withoutVoiceAttachment(attachments, voice), [document]);
  assert.equal(withoutVoiceAttachment(attachments, null), attachments);
  const imported: Message = { role: 'person', text: '', time: '12:00', attachments: [audio] };
  assert.equal(attachmentOnlyMessagePreview(imported)?.label, audio.name);
});
