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

test('recorder retains failure for bounded retry, deduplicates success, and ignores cancelled results', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const values = { window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(values).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  let outcome: 'permission' | 'ready' | 'deferred' = 'permission';
  let calls = 0;
  let resolveSpeech: ((value: string) => void) | undefined;
  mockIPC(command => {
    if (command === 'desktop_voice_record_start') return 'recording';
    if (command === 'desktop_voice_record_stop') return { path: '/synthetic/audio.m4a', durationMs: 2_000, sizeBytes: 2048 };
    if (command === 'desktop_voice_trim') return '/synthetic/trim.m4a';
    if (command === 'desktop_voice_transcribe') {
      calls += 1;
      if (outcome === 'permission') throw new Error('Allow Kordi to use Speech Recognition.');
      if (outcome === 'deferred') return new Promise<string>(resolve => { resolveSpeech = resolve; });
      return 'Meet at noon.';
    }
    return undefined;
  });
  const root = createRoot(document.getElementById('root')!);
  let recorder!: ReturnType<typeof useVoiceMessageRecorder>;
  function Probe() { recorder = useVoiceMessageRecorder(); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await recorder.start(); await recorder.stop({ directSend: true }); });
    assert.equal(recorder.state.phase, 'review');
    assert.equal(recorder.state.transcript, '');
    assert.equal(recorder.state.attachment?.voiceMessage?.transcription?.status, 'unavailable');
    const original = recorder.state.attachment;
    outcome = 'ready';
    await act(async () => { await Promise.all([recorder.prepareForSend(), recorder.prepareForSend()]); });
    assert.equal(calls, 2);
    assert.equal(recorder.state.attachment?.id, original?.id);
    assert.equal(recorder.state.attachment?.voiceMessage?.transcription?.sourceVersion, original?.voiceMessage?.transcription?.sourceVersion);
    await act(async () => { await recorder.prepareForSend(); });
    assert.equal(calls, 2, 'send retries reuse successful transcription');
    await act(async () => recorder.setTrimRange(500, 1500));
    await act(async () => { await recorder.prepareForSend(); });
    assert.equal(calls, 3);
    assert.equal(recorder.state.durationMs, 1000);
    assert.notEqual(recorder.state.attachment?.voiceMessage?.transcription?.sourceVersion, original?.voiceMessage?.transcription?.sourceVersion);
    await act(async () => { await recorder.prepareForSend(); });
    assert.equal(calls, 3, 'the prepared trim is cached across send retries');
    await act(async () => recorder.reset());
    outcome = 'deferred';
    await act(async () => { await recorder.start(); });
    let pending!: ReturnType<typeof recorder.stop>;
    await act(async () => { pending = recorder.stop(); await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(resolveSpeech);
    await act(async () => { recorder.reset(); resolveSpeech!('Late speech'); await pending; });
    assert.equal(recorder.state.phase, 'idle');
    assert.equal(recorder.state.attachment, null);
    outcome = 'permission';
    await act(async () => { await recorder.start(); await recorder.stop({ directSend: true }); });
    await act(async () => { await recorder.prepareForSend(); await recorder.prepareForSend(); });
    const boundedCalls = calls;
    await act(async () => { await recorder.prepareForSend(); });
    assert.equal(calls, boundedCalls);
    assert.equal(recorder.state.attachment?.voiceMessage?.transcription?.attempts, 3);
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
