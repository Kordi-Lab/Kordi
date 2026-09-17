import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useVoiceComposer } from '../src/pages/chatsPage.voiceComposer';
import { VoiceComposerControls } from '../src/pages/chatsPage.voiceControls';
import type { Conversation } from '../src/kordi-app/types';

test('mouse click records, pending transcription is visible, and cancel or failed send cannot lock the microphone', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const values = { window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {} };
  const previous = new Map(Object.keys(values).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  dom.window.requestAnimationFrame = callback => dom.window.setTimeout(() => callback(0), 0);
  let starts = 0;
  let transcripts = 0;
  let deferred = false;
  let failStart = false;
  let failSend = false;
  let releaseTranscript: ((value: string) => void) | undefined;
  let sends = 0;
  let deferDelivery = false;
  let finishDelivery: ((failed: boolean) => void) | undefined;
  mockIPC(command => {
    if (command === 'desktop_voice_record_start') {
      starts += 1;
      if (failStart) throw new Error('Microphone could not start.');
      return 'recording';
    }
    if (command === 'desktop_voice_record_stop') return { path: `/synthetic/voice-${starts}.m4a`, durationMs: 2000, sizeBytes: 2048 };
    if (command === 'desktop_voice_record_sample') return { durationMs: 2000, level: 0.2 };
    if (command === 'desktop_voice_transcribe') {
      transcripts += 1;
      if (deferred) return new Promise<string>(resolve => { releaseTranscript = resolve; });
      return 'Meet at noon.';
    }
    return undefined;
  });
  const root = createRoot(document.getElementById('root')!);
  let voice!: ReturnType<typeof useVoiceComposer>;
  function Probe() {
    const [deliveryStatus, setDeliveryStatus] = useState('');
    voice = useVoiceComposer({ conversation: { id: 'synthetic-conversation' } as Conversation,
      cloudAccountId: null, focusComposer: () => {}, onSend: () => {
        if (failSend) throw new Error('Synthetic network failure');
        sends += 1;
        if (deferDelivery) {
          setDeliveryStatus('Sending message');
          return new Promise<void>((resolve, reject) => {
            finishDelivery = failed => {
              setDeliveryStatus(failed ? 'Message failed' : 'Message sent');
              if (failed) reject(new Error('Synthetic transport failure'));
              else resolve();
            };
          });
        }
        setDeliveryStatus('Message sent');
        return Promise.resolve();
      } });
    return createElement('div', null,
      createElement('div', { 'data-message-bubble': true }, deliveryStatus),
      createElement(VoiceComposerControls, { voice, hasSendableDraft: false, validationError: null,
        activeLiveTurnIsRunning: false, onSend: () => {} }));
  }
  const button = (label: string) => {
    const value = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(value, label);
    return value;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  async function clickToRecord() {
    await act(async () => { button('Record voice message').click(); await settle(); });
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await clickToRecord();
    assert.equal(voice.recorder.state.phase, 'recording');
    assert.equal(starts, 1);
    assert.equal(button('Cancel voice recording').disabled, false);
    deferred = true;
    await act(async () => { button('Stop and send voice message').click(); await settle(); });
    assert.equal(voice.surfaceActive, true);
    assert.match(document.body.textContent ?? '', /Transcribing/);
    assert.ok(button('Send voice message').disabled);
    const oldTranscript = releaseTranscript;
    await act(async () => { button('Delete voice recording').click(); await settle(); });
    assert.equal(voice.recorder.state.phase, 'idle');
    assert.equal(button('Record voice message').disabled, false);
    // A cancelled recognizer may still be completing. It must not own the next send.
    deferred = false;
    await clickToRecord();
    failSend = true;
    await act(async () => { button('Stop and send voice message').click(); await settle(); });
    assert.equal(voice.recorder.state.phase, 'review');
    assert.match(document.body.textContent ?? '', /Send failed/);
    assert.equal(button('Send voice message').disabled, false);
    const transcriptionCount = transcripts;
    failSend = false;
    await act(async () => { button('Send voice message').click(); await settle(); });
    assert.equal(sends, 1);
    assert.equal(transcripts, transcriptionCount, 'a failed send must reuse the successful transcript');
    await act(async () => { oldTranscript?.('Late cancelled speech'); await settle(); });
    assert.equal(sends, 1);
    assert.equal(voice.recorder.state.phase, 'idle');
    deferDelivery = true;
    await clickToRecord();
    await act(async () => { button('Stop and send voice message').click(); await settle(); });
    assert.equal(voice.surfaceActive, false, 'upload progress belongs to the outgoing bubble');
    assert.equal(document.querySelector('.app-voice-recording-rail'), null);
    assert.equal(button('Record voice message').disabled, false);
    assert.equal(document.querySelector('[data-message-bubble]')?.textContent, 'Sending message');
    await clickToRecord();
    await act(async () => { finishDelivery?.(true); await settle(); });
    assert.equal(document.querySelector('[data-message-bubble]')?.textContent, 'Message failed');
    assert.equal(voice.recorder.state.phase, 'recording', 'late delivery failure must not replace the next draft');
    await act(async () => { button('Cancel voice recording').click(); });
    deferDelivery = false;
    const heldMic = button('Record voice message');
    await act(async () => {
      heldMic.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0, clientY: 100 }));
      await new Promise(resolve => setTimeout(resolve, 320));
      dom.window.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, pointerId: 2, button: 0, clientY: 100 }));
      await settle();
    });
    assert.equal(starts, 4, 'pressing and holding without a click must not start a recording');
    assert.equal(sends, 2, 'holding and releasing no longer sends');
    assert.equal(voice.recorder.state.phase, 'idle');
    failStart = true;
    await act(async () => { button('Record voice message').click(); await settle(); });
    assert.equal(voice.recorder.state.phase, 'error');
    await act(async () => { button('Dismiss voice recording').click(); });
    assert.equal(button('Record voice message').disabled, false);
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
