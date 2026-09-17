import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { VoiceMessageContent } from '../src/kordi-app/components/voiceMessage';
import { resetVoiceTranscriptionJobsForTests, startVoiceTranscription, voiceTranscriptionKeys } from '../src/features/chat/voiceTranscriptionJobs';
import { cacheCloudAttachmentLocalPath } from '../src/features/cloud/cloudAttachmentLocalPathCache';
import { setCloudVoiceTranscriptClientForTests, type VoiceTranscriptClient } from '../src/features/cloud/cloudVoiceTranscriptPersistence';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import type { VoiceTranscription } from '../src/features/chat/voiceTranscription';
import type { MessageVoice } from '../src/kordi-app/types/message';

type Put = { version: number; mediaId: string; transcript: string; transcription: VoiceTranscription };

function voice(mediaId: string, localPath: string | null, transcription?: Partial<VoiceTranscription>): MessageVoice {
  return {
    mediaId, localPath, mimeType: 'audio/mp4', durationMs: 2000, waveformSamples: [0.2, 0.6], transcript: '',
    transcription: { status: 'pending', sourceVersion: mediaId, engine: 'apple-speech-v1', attempts: 0, ...transcription },
  };
}

async function withBubbleHarness(run: (harness: {
  root: Root;
  transcribeCalls: string[];
  finishSpeech: (path: string, result: string | Error) => Promise<void>;
  puts: Put[];
  trigger: () => HTMLButtonElement;
  panelText: () => string;
  settle: () => Promise<void>;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const values = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const transcribeCalls: string[] = [];
  const pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  mockIPC((command, payload) => {
    if (command === 'desktop_voice_transcribe') {
      const path = String((payload as { path?: string }).path);
      transcribeCalls.push(path);
      return new Promise<string>((resolve, reject) => pending.set(path, { resolve, reject }));
    }
    if (command === 'desktop_chat_read_attachment') throw new Error('Synthetic audio is not playable.');
    return undefined;
  });
  const puts: Put[] = [];
  const client: VoiceTranscriptClient = { chat: {
    updateVoiceTranscript: async (_token, conversationId, messageId, version, mediaId, transcript, transcription) => {
      puts.push({ version, mediaId, transcript, transcription });
      return { messageId, conversationId, fromAccountId: 'sender', toAccountId: 'peer', body: transcript,
        createdAt: new Date().toISOString(), deliveredAt: null, readAt: null, direction: 'outgoing' };
    },
    threadPage: async () => { throw new Error('No refresh expected.'); },
    listHistoryPage: async () => { throw new Error('No refresh expected.'); },
  } };
  setCloudVoiceTranscriptClientForTests(client);
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic-token', accountId: 'sender', expiresAt: '2999-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  resetVoiceTranscriptionJobsForTests();
  const root = createRoot(document.getElementById('root')!);
  const settle = () => act(async () => {
    // Speech recognition starts after a few asynchronous hops; wait until it has been requested.
    for (let attempt = 0; attempt < 20 && pending.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  try {
    await run({
      root,
      transcribeCalls,
      puts,
      settle,
      finishSpeech: async (path, result) => {
        for (let attempt = 0; attempt < 200 && !pending.has(path); attempt += 1) {
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        }
        const job = pending.get(path);
        assert.ok(job, `speech recognition is running for ${path}`);
        pending.delete(path);
        await act(async () => {
          if (result instanceof Error) job.reject(result);
          else job.resolve(result);
          await new Promise(resolve => setTimeout(resolve, 10));
        });
      },
      trigger: () => {
        const button = document.querySelector<HTMLButtonElement>('.app-voice-transcript-trigger');
        assert.ok(button, 'transcript icon');
        return button;
      },
      panelText: () => document.querySelector('.app-voice-transcript')?.textContent ?? '',
    });
  } finally {
    await act(async () => root.unmount());
    setCloudVoiceTranscriptClientForTests(null);
    __setSessionBackendForTests(null);
    resetVoiceTranscriptionJobsForTests();
    clearMocks();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('the transcript icon transcribes in the background, survives re-mounting, and the sender stores the result', async () => {
  await withBubbleHarness(async ({ root, transcribeCalls, finishSpeech, puts, trigger, panelText, settle }) => {
    const target = { reactionConversationId: 'conversation-sender', reactionTargetMessageId: 'message-sender', cloudMessageVersion: 1 };
    const sent = voice('media-sender', '/synthetic/sender.m4a');
    await act(async () => root.render(createElement(VoiceMessageContent, { key: 'first', voice: sent, ownMessage: target })));
    assert.equal(trigger().getAttribute('aria-label'), 'Transcribe');
    assert.equal(trigger().title, 'Transcribe');
    assert.equal(document.querySelector('.app-voice-transcript'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /Transcript unavailable|Not transcribed yet/);

    await act(async () => { trigger().click(); });
    assert.equal(trigger().getAttribute('aria-label'), 'Transcribing…');
    assert.equal(trigger().getAttribute('aria-expanded'), 'true');
    assert.match(panelText(), /Transcribing…/, 'one click shows the running state at once');
    await settle();
    assert.deepEqual(transcribeCalls, ['/synthetic/sender.m4a']);

    // Virtualization unmounts the row; the job keeps running and the new row re-opens its state.
    await act(async () => root.render(createElement('div')));
    await act(async () => root.render(createElement(VoiceMessageContent, { key: 'second', voice: sent, ownMessage: target })));
    assert.match(panelText(), /Transcribing…/);
    assert.equal(transcribeCalls.length, 1, 're-mounting never starts a second job');
    assert.equal(puts.length, 0);

    await finishSpeech('/synthetic/sender.m4a', 'Meet at noon.');
    assert.match(panelText(), /Meet at noon\./);
    assert.equal(trigger().getAttribute('aria-label'), 'Hide transcript');
    assert.equal(puts.length, 1, 'the sender persists the transcript for everyone');
    assert.equal(puts[0].version, 1);
    assert.equal(puts[0].mediaId, 'media-sender');
    assert.equal(puts[0].transcript, 'Meet at noon.');
    assert.equal(puts[0].transcription.status, 'ready');
    assert.equal(puts[0].transcription.attempts, 1);
    assert.equal(puts[0].transcription.sourceVersion, 'media-sender');

    await act(async () => { trigger().click(); });
    assert.equal(document.querySelector('.app-voice-transcript'), null);
    assert.equal(trigger().getAttribute('aria-label'), 'Show transcript');
    await act(async () => { trigger().click(); });
    assert.match(panelText(), /Meet at noon\./);
    assert.equal(transcribeCalls.length, 1);
  });
});

test('clicking while a background job runs only reveals it, and recipients keep a device-local transcript', async () => {
  await withBubbleHarness(async ({ root, transcribeCalls, finishSpeech, puts, trigger, panelText }) => {
    const agentPath = '/synthetic/agent.m4a';
    const agentVoice = voice('pending:voice-agent', agentPath);
    // For example, a voice message addressed to an agent is already transcribing in the background.
    void startVoiceTranscription({ keys: voiceTranscriptionKeys(agentVoice), source: async () => agentPath });
    await act(async () => root.render(createElement(VoiceMessageContent, { key: 'agent', voice: agentVoice })));
    assert.equal(trigger().getAttribute('aria-label'), 'Transcribing…');
    assert.equal(document.querySelector('.app-voice-transcript'), null);
    await act(async () => { trigger().click(); });
    assert.match(panelText(), /Transcribing…/);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(transcribeCalls, [agentPath], 'no duplicate job for the same recording');
    await finishSpeech(agentPath, 'Agent words.');
    assert.match(panelText(), /Agent words\./);

    cacheCloudAttachmentLocalPath('media-recipient', '/synthetic/recipient.m4a');
    const received = voice('media-recipient', null);
    await act(async () => root.render(createElement(VoiceMessageContent, { key: 'recipient', voice: received })));
    assert.equal(trigger().getAttribute('aria-label'), 'Transcribe');
    await act(async () => { trigger().click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.match(panelText(), /Transcribing…/);
    await finishSpeech('/synthetic/recipient.m4a', 'Recipient words.');
    assert.match(panelText(), /Recipient words\./);
    assert.equal(puts.length, 0, 'a recipient never stores a transcript on the server');

    await act(async () => root.render(createElement(VoiceMessageContent, { key: 'recipient-again', voice: received })));
    assert.equal(trigger().getAttribute('aria-label'), 'Hide transcript', 'a requested transcript stays open after re-mounting');
    assert.match(panelText(), /Recipient words\./, 'the device cache serves the transcript again');
    await act(async () => { trigger().click(); });
    assert.equal(document.querySelector('.app-voice-transcript'), null);
    await act(async () => root.render(createElement(VoiceMessageContent, { key: 'recipient-closed', voice: received })));
    assert.equal(trigger().getAttribute('aria-label'), 'Show transcript', 'closing it is remembered too');
    await act(async () => { trigger().click(); });
    assert.match(panelText(), /Recipient words\./);
    assert.equal(transcribeCalls.length, 2);
  });
});

test('a failed attempt shows a short note with Try again within the limit; impossible transcription explains why', async () => {
  await withBubbleHarness(async ({ root, transcribeCalls, finishSpeech, puts, trigger, panelText, settle }) => {
    const target = { reactionConversationId: 'conversation-failure', reactionTargetMessageId: 'message-failure', cloudMessageVersion: 1 };
    const path = '/synthetic/failure.m4a';
    await act(async () => root.render(createElement(VoiceMessageContent, { voice: voice('media-failure', path), ownMessage: target })));
    await act(async () => { trigger().click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    await finishSpeech(path, new Error('No recognizable speech was found.'));
    // The native helper tries each fallback locale before it gives up.
    while (transcribeCalls.length < 8 && document.querySelector('.app-voice-transcript-status')) {
      await finishSpeech(path, new Error('No recognizable speech was found.'));
    }
    await settle();
    assert.match(panelText(), /No speech detected\./);
    assert.ok(document.querySelector('.app-voice-transcript button'), 'Try again');
    assert.equal(document.querySelector('.app-voice-transcript button')?.textContent, 'Try again');
    assert.equal(puts.at(-1)?.transcription.status, 'failed');
    assert.equal(puts.at(-1)?.transcription.attempts, 1);

    // message.updated delivers the stored failure before the retry.
    await act(async () => root.render(createElement(VoiceMessageContent, {
      voice: voice('media-failure', path, { status: 'failed', attempts: 1 }), ownMessage: { ...target, cloudMessageVersion: 2 },
    })));
    const callsBeforeRetry = transcribeCalls.length;
    await act(async () => { document.querySelector<HTMLButtonElement>('.app-voice-transcript button')!.click(); });
    assert.match(panelText(), /Transcribing…/);
    await settle();
    assert.equal(transcribeCalls.length, callsBeforeRetry + 1);
    await finishSpeech(path, 'Second try.');
    assert.match(panelText(), /Second try\./);
    assert.equal(puts.at(-1)?.transcription.attempts, 2);
    assert.equal(puts.at(-1)?.version, 2);

    await act(async () => root.render(createElement(VoiceMessageContent, {
      key: 'exhausted', voice: voice('media-exhausted', '/synthetic/exhausted.m4a', { status: 'failed', attempts: 3 }),
      ownMessage: { ...target, reactionTargetMessageId: 'message-exhausted' },
    })));
    assert.equal(trigger().getAttribute('aria-label'), 'Transcript unavailable');
    await act(async () => { trigger().click(); });
    assert.match(panelText(), /retry limit was reached/);
  });
});
