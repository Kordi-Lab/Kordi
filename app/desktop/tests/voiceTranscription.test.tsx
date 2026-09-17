import { promptTextForCloudAgentMention } from '../src/features/cloud/cloudAgentMessages';
import { voiceMessageAgentText } from '../src/features/chat/messageActions/optimisticAttachments';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useVoiceMessageRecorder } from '../src/features/chat/useVoiceMessageRecorder';
import { voiceAgentText, voiceTranscript, parseVoiceTranscription } from '../src/features/chat/voiceTranscription';
import { cloudVoiceMessageMetadataOnly } from '../src/features/cloud/cloudVoiceMessage';
import { chatTextContent } from '../src/features/cloud/chatSyncMapping';

const metadata = { status: 'ready' as const, sourceVersion: 'audio-v1', engine: 'apple-speech-v1' as const, language: 'en-US', attempts: 1 };

test('voice status and source binding exclude failed, silent, legacy-placeholder and stale speech', () => {
  for (const status of ['pending', 'failed', 'unavailable'] as const) {
    assert.equal(voiceTranscript({ transcript: 'must not be spoken', transcription: { ...metadata, status } }), '');
    assert.ok(!voiceAgentText({ transcript: 'must not be spoken', transcription: { ...metadata, status } }).includes('must not be spoken'));
  }
  assert.equal(voiceTranscript({ transcript: 'Transcription unavailable.' }), '');
  assert.equal(voiceTranscript({ transcript: 'old speech', mediaId: 'audio-v2', transcription: metadata }), '');
  assert.match(voiceAgentText({ transcript: 'Meet at noon.', transcription: metadata }), /audio was not provided/);
  assert.equal(parseVoiceTranscription({ ...metadata, sourceVersion: '/invalid/path' }), undefined);
  assert.equal(parseVoiceTranscription({ ...metadata, attempts: 4 }), undefined);
});

test('transcription metadata survives upload binding and round trip without local paths', () => {
  const voice = { mediaId: 'audio-v2', mimeType: 'audio/mp4', durationMs: 2_000, waveformSamples: [0.2],
    transcript: 'Meet at noon.', transcription: metadata, localPath: '/synthetic/audio.m4a' };
  const content = chatTextContent(voice.transcript, [], null, voice);
  const restored = cloudVoiceMessageMetadataOnly(content.blocks[1]);
  assert.equal(restored?.transcription?.sourceVersion, 'audio-v2');
  assert.equal(restored?.transcript, voice.transcript);
  assert.ok(!JSON.stringify(content).includes('localPath'));
});

test('recorder finalizes a pending recording without transcription, caches a trimmed export, and ignores cancelled stops', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const values = { window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(values).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  let speechCalls = 0;
  let trims = 0;
  let resolveStop: ((value: unknown) => void) | undefined;
  let deferStop = false;
  mockIPC(command => {
    if (command === 'desktop_voice_record_start') return 'recording';
    if (command === 'desktop_voice_record_stop') {
      const stopped = { path: '/synthetic/audio.m4a', durationMs: 2_000, sizeBytes: 2048 };
      return deferStop ? new Promise(resolve => { resolveStop = () => resolve(stopped); }) : stopped;
    }
    if (command === 'desktop_voice_trim') { trims += 1; return '/synthetic/trim.m4a'; }
    if (command === 'desktop_voice_transcribe') { speechCalls += 1; return 'Must not run.'; }
    return undefined;
  });
  const root = createRoot(document.getElementById('root')!);
  let recorder!: ReturnType<typeof useVoiceMessageRecorder>;
  function Probe() { recorder = useVoiceMessageRecorder(); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    let stopped!: Awaited<ReturnType<typeof recorder.stop>>;
    await act(async () => { await recorder.start(); stopped = await recorder.stop(); });
    assert.equal(recorder.state.phase, 'review');
    assert.equal(stopped?.id, recorder.state.attachment?.id);
    assert.equal(stopped?.voiceMessage?.transcript, '');
    assert.equal(stopped?.voiceMessage?.transcription?.status, 'pending');
    assert.equal(stopped?.voiceMessage?.transcription?.attempts, 0);
    const original = recorder.state.attachment;
    await act(async () => { await Promise.all([recorder.prepareForSend(), recorder.prepareForSend()]); });
    assert.equal(recorder.state.attachment, original, 'an untrimmed recording is sent as recorded');
    await act(async () => recorder.setTrimRange(500, 1500));
    let trimmed!: Awaited<ReturnType<typeof recorder.prepareForSend>>;
    await act(async () => { trimmed = await recorder.prepareForSend(); });
    assert.equal(trims, 1);
    assert.equal(recorder.state.durationMs, 1000);
    assert.equal(trimmed?.path, '/synthetic/trim.m4a');
    assert.equal(trimmed?.voiceMessage?.transcription?.status, 'pending');
    assert.notEqual(trimmed?.voiceMessage?.transcription?.sourceVersion, original?.voiceMessage?.transcription?.sourceVersion);
    await act(async () => { await recorder.prepareForSend(); });
    assert.equal(trims, 1, 'the trimmed export is reused across send retries');
    await act(async () => recorder.reset());

    deferStop = true;
    await act(async () => { await recorder.start(); });
    let pending!: ReturnType<typeof recorder.stop>;
    await act(async () => { pending = recorder.stop(); await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(resolveStop);
    let late: Awaited<typeof pending> | undefined;
    await act(async () => { recorder.reset(); resolveStop!(undefined); late = await pending; });
    assert.equal(late, null, 'a cancelled recording is never handed off');
    assert.equal(recorder.state.phase, 'idle');
    assert.equal(recorder.state.attachment, null);
    assert.equal(speechCalls, 0, 'recording never runs speech recognition');
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('voice guidance is added at the model boundary while ordinary drafts remain unchanged', () => {
  const attachment = { id: 'audio-v1', name: 'Voice message.m4a', kind: 'file' as const,
    path: '/synthetic/audio.m4a', voiceMessage: { mimeType: 'audio/mp4', durationMs: 2000,
      waveformSamples: [0.2], transcript: 'Meet at noon.', transcription: metadata } };
  assert.match(voiceMessageAgentText('Meet at noon.', [attachment]), /audio was not provided/);
  assert.equal(attachment.voiceMessage.transcript, 'Meet at noon.');
  assert.equal(voiceMessageAgentText('Ordinary text', []), 'Ordinary text');
});

test('shared agent prompts distinguish recognized speech from failed voice metadata', () => {
  const voice = { mediaId: 'audio-v1', mimeType: 'audio/mp4', durationMs: 2000,
    waveformSamples: [0.2], transcript: '@Kordi Meet at noon.', transcription: metadata };
  const prompt = promptTextForCloudAgentMention(voice.transcript, voice);
  assert.match(prompt, /audio was not provided/);
  assert.ok(prompt.endsWith('Meet at noon.'));
  assert.ok(!prompt.includes('@Kordi'));
  const failed = promptTextForCloudAgentMention('Transcription unavailable.', {
    ...voice, transcription: { ...metadata, status: 'failed' },
  });
  assert.ok(!failed.includes('Meet at noon.'));
  assert.match(failed, /No spoken content/);
});

test('mixed-language transcript text is retained without claiming recognition accuracy', () => {
  const text = 'Meet at noon. \u4F60\u597D';
  assert.ok(voiceAgentText({ transcript: text, transcription: metadata }).endsWith(text));
});
