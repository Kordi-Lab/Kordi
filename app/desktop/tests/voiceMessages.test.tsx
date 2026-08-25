import assert from 'node:assert/strict';
import test from 'node:test';

import {
  downsampleVoiceWaveform,
  displayVoiceWaveform,
  trimVoiceWaveform,
  voiceGestureIntent,
} from '../src/features/chat/useVoiceMessageRecorder';
import { voiceMessageDraftFromAttachments } from '../src/features/chat/messageActions/optimistic';
import { chatTextContent } from '../src/features/cloud/chatSyncMapping';
import { desktopVoiceTranscriptionLocales } from '../src/lib/desktopVoice';
import {
  cloudGroupControlWithAttachmentReferences,
  encodeCloudGroupControl,
  parseCloudGroupControl,
} from '../src/features/cloud/cloudGroupMessages';

const voiceDraft = {
  mimeType: 'audio/mp4',
  durationMs: 12_000,
  waveformSamples: [0.1, 0.5, 1],
  transcript: 'Meet me after lunch.',
};

test('voice chat content stores media as a typed block without legacy attachment metadata', () => {
  const content = chatTextContent(
    'Meet me after lunch.',
    [{ attachmentId: 'att_voice', name: 'Voice message.m4a', kind: 'file', mimeType: 'audio/mp4' }],
    null,
    { ...voiceDraft, mediaId: 'att_voice' },
  );

  assert.deepEqual(content.legacy_attachments, []);
  assert.deepEqual(content.blocks, [
    { type: 'text', text: 'Meet me after lunch.' },
    { type: 'voice', ...voiceDraft, mediaId: 'att_voice' },
  ]);
});

test('group voice upload binds the private media id without exposing a file attachment', () => {
  const envelope = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:voice-test',
    groupSpaceId: 'session:group:voice-test',
    groupTitle: 'Voice test',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'self' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'self' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_voice',
      senderAccountId: 'acct_me',
      text: voiceDraft.transcript,
      createdAtMs: 1,
      senderKind: 'human',
      messageKind: 'voice',
      voiceMessage: voiceDraft,
    },
  });
  const prepared = cloudGroupControlWithAttachmentReferences(envelope, [{
    attachmentId: 'att_voice',
    name: 'Voice message.m4a',
    kind: 'file',
    mimeType: 'audio/mp4',
  }]);
  const message = parseCloudGroupControl(prepared)?.message;

  assert.equal(message?.voiceMessage?.mediaId, 'att_voice');
  assert.equal(message?.messageKind, 'voice');
  assert.deepEqual(message?.attachments, []);
});

test('voice waveform and portable draft stay bounded and omit local paths', () => {
  assert.deepEqual(downsampleVoiceWaveform([0.1, 0.2, 0.8, 1], 2), [0.2, 1]);
  assert.deepEqual(displayVoiceWaveform([0.2, 0.8], 5), [0.2, 0.35, 0.5, 0.65, 0.8]);
  assert.deepEqual(voiceMessageDraftFromAttachments([{
    id: 'voice',
    path: '/private/voice.m4a',
    localPath: '/private/voice.m4a',
    name: 'Voice message.m4a',
    kind: 'file',
    voiceMessage: { ...voiceDraft, localPath: '/private/voice.m4a' },
  }]), voiceDraft);
});

test('macOS voice gestures release to send and swipe up to cancel', () => {
  assert.equal(voiceGestureIntent(-20), 'hold');
  assert.equal(voiceGestureIntent(-64), 'cancel');
  assert.equal(voiceGestureIntent(-100), 'cancel');
  assert.deepEqual(trimVoiceWaveform([0.1, 0.2, 0.8, 1], 4_000, 1_000, 3_000), [0.2, 0.8]);
});

test('native transcription falls back from the app language to Chinese locales', () => {
  assert.deepEqual(
    desktopVoiceTranscriptionLocales(['en-US', 'zh-CN']),
    ['en-US', 'zh-CN', 'zh-TW', 'zh-HK'],
  );
});
