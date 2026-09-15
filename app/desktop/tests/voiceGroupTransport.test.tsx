import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudGroupOutbox } from '../src/features/cloud/cloudGroupOutbox';
import { prepareCloudGroupOutboxEntryAttachments } from '../src/features/cloud/cloudGroupOutboxAttachments';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudGroupMessageRuntimeFields } from '../src/features/cloud/cloudGroupDecoding';
import { cloudVoiceAttachmentReference } from '../src/features/cloud/cloudVoiceMessage';
import { chatTextContent, cloudMessageFromChatSync } from '../src/features/cloud/chatSyncMapping';
import type { ChatSyncConversation, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';
import type { VoiceTranscription } from '../src/features/chat/voiceTranscription';
import { MemoryPersistence, entry } from './helpers/cloudGroupOutboxFixtures';

export const transcription = (status: VoiceTranscription['status']): VoiceTranscription => ({
  status, sourceVersion: 'draft-audio-version', engine: 'apple-speech-v1', language: 'en-US', attempts: 2,
});
const voiceDraft = (status: VoiceTranscription['status']) => ({
  mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.1, 0.5, 0.2],
  transcript: status === 'ready' ? 'Synthetic voice fixture.' : '', transcription: transcription(status),
});
const attachment = { attachmentId: 'att_voice_fixture', name: 'Voice message.m4a', kind: 'file' as const, mimeType: 'audio/mp4' };
function envelope(status: VoiceTranscription['status']) {
  return encodeCloudGroupControl({ kind: 'group-message', groupId: 'session:group:voice-fixture',
    groupTitle: 'Synthetic voice fixture', createdByAccountId: 'acct_voice_fixture_owner',
    actor: { accountId: 'acct_voice_fixture_owner', displayName: 'Synthetic owner', role: 'self' },
    participants: [{ accountId: 'acct_voice_fixture_owner', displayName: 'Synthetic owner', role: 'self' },
      { accountId: 'acct_voice_fixture_peer', displayName: 'Synthetic peer', role: 'person' }],
    message: { id: 'voice-fixture-message', senderAccountId: 'acct_voice_fixture_owner', text: voiceDraft(status).transcript,
      createdAtMs: 1, senderKind: 'human', messageKind: 'voice', voiceMessage: voiceDraft(status) },
  });
}

for (const status of ['ready', 'pending', 'failed', 'unavailable'] as const) {
  test(`group ${status} transcription survives outbox restore, upload, wire serialization, and incoming history`, async () => {
    const persistence = new MemoryPersistence();
    const outbox = new CloudGroupOutbox('acct_voice_fixture_owner', persistence);
    await outbox.restore();
    await outbox.enqueue({ ...entry(), sessionId: 'session:group:voice-fixture', envelope: envelope(status),
      pendingAttachments: [{ id: 'audio-draft', path: '/synthetic/voice.m4a', name: attachment.name, kind: 'file', mimeType: 'audio/mp4' }] });
    const restored = new CloudGroupOutbox('acct_voice_fixture_owner', persistence);
    await restored.restore();
    assert.deepEqual(parseCloudGroupControl(restored.entries()[0].envelope)?.message?.voiceMessage?.transcription, transcription(status));
    let uploads = 0;
    const prepared = await prepareCloudGroupOutboxEntryAttachments({ outbox: restored, entry: restored.entries()[0], upload: async () => { uploads++; return [attachment]; } });
    const expected = { ...transcription(status), sourceVersion: attachment.attachmentId };
    const voice = parseCloudGroupControl(prepared.envelope)?.message?.voiceMessage;
    assert.deepEqual(voice?.transcription, expected);
    assert.equal(voice?.transcript, voiceDraft(status).transcript);
    assert.equal(voice?.mediaId, attachment.attachmentId);
    const retry = await prepareCloudGroupOutboxEntryAttachments({ outbox: restored, entry: prepared, upload: async () => { throw new Error('already uploaded'); } });
    assert.equal(uploads, 1);
    assert.equal(retry.envelope, prepared.envelope);
    const content = chatTextContent(prepared.envelope, [attachment], null, { ...voice!, mediaId: attachment.attachmentId });
    const wireVoice = content.blocks.find(block => block.type === 'voice');
    assert.deepEqual((wireVoice as unknown as { transcription: VoiceTranscription }).transcription, expected);
    assert.ok(!JSON.stringify(content).includes('/synthetic/'));
    const now = '2026-01-01T00:00:00Z';
    const conversation: ChatSyncConversation = { id: 'conversation', kind: 'group', shared_title: 'Synthetic voice fixture', version: 1,
      created_by_account_id: 'acct_voice_fixture_owner', legacy_session_id: 'session:group:voice-fixture', latest_message_sequence: 1,
      created_at: now, updated_at: now, members: [], preferences: { conversation_id: 'conversation', account_id: 'acct_voice_fixture_peer', personal_title: null, version: 1 } };
    const message: ChatSyncMessage = { id: 'message', client_message_id: 'client-message', conversation_id: conversation.id,
      conversation_sequence: 1, sender_account_id: 'acct_voice_fixture_owner', kind: 'voice', content: JSON.parse(JSON.stringify(content)),
      reply_to_message_id: null, attachment_ids: [attachment.attachmentId], version: 1, generation_status: null,
      provider_response_id: null, created_at: now, edited_at: null, deleted_at: null };
    const incoming = cloudMessageFromChatSync(message, conversation);
    assert.deepEqual(incoming.voiceMessage?.transcription, expected);
    assert.deepEqual(parseCloudGroupControl(incoming.body)?.message?.voiceMessage?.transcription, expected);
  });
}

test('eager group uploads bind transcription to the same media ID as queued uploads', () => {
  const bound = cloudVoiceAttachmentReference(voiceDraft('ready'), attachment).voiceMessage!;
  const decoded = cloudGroupMessageRuntimeFields({ voiceMessage: bound }).voiceMessage;
  assert.deepEqual(decoded?.transcription, { ...transcription('ready'), sourceVersion: attachment.attachmentId });
  assert.equal(decoded?.transcript, voiceDraft('ready').transcript);
});

test('group decoding rejects stale or malformed transcription evidence and strips local paths', () => {
  for (const metadata of [{ ...transcription('ready'), sourceVersion: 'old-audio' }, { ...transcription('ready'), attempts: 99 }]) {
    const decoded = cloudGroupMessageRuntimeFields({ voiceMessage: { ...voiceDraft('ready'), mediaId: attachment.attachmentId,
      localPath: '/synthetic/voice.m4a', transcription: metadata } }).voiceMessage;
    assert.equal(decoded?.transcript, '');
    assert.equal(decoded?.localPath, undefined);
  }
  const legacy = cloudGroupMessageRuntimeFields({ voiceMessage: { mimeType: 'audio/mp4', durationMs: 1000,
    waveformSamples: [0.2], transcript: 'Legacy transcript.' } }).voiceMessage;
  assert.equal(legacy?.transcript, 'Legacy transcript.');
  assert.equal(legacy?.transcription, undefined);
});
