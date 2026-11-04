import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { VoiceMessageContent } from '../src/kordi-app/components/voiceMessage';
import { invokeDesktop } from '../src/lib/desktop';
import { waitForReactCondition } from './helpers/waitForReactCondition';
import type { MessageVoice } from '../src/kordi-app/types/message';

const voice: MessageVoice = {
  mediaId: 'synthetic-voice', localPath: '/synthetic/voice.m4a', mimeType: 'audio/mp4',
  durationMs: 9000, waveformSamples: [0.2, 0.6], transcript: '',
};

for (const delayed of ['read', 'play', 'none', 'commit-gap'] as const) {
  test(`removing a voice row stops playback when ${delayed} is pending`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
    const values = {
      window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent,
      IS_REACT_ACT_ENVIRONMENT: true, __TAURI_INTERNALS__: {},
    };
    const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const calls: string[] = [];
    let readCompleted = false;
    let playCompleted = false;
    let nativePlaying = false;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    mockIPC(async command => {
      calls.push(command);
      if (command === 'desktop_chat_read_attachment') {
        if (delayed === 'read') await pending;
        readCompleted = true;
        return new Array(2048).fill(0);
      }
      if (command === 'desktop_voice_play') {
        if (delayed === 'play') await pending;
        if (delayed === 'commit-gap') root.render(createElement('div'));
        nativePlaying = true;
        playCompleted = true;
        return { currentMs: 0, durationMs: 9000, playing: true };
      }
      if (command === 'desktop_voice_stop') nativePlaying = false;
      return undefined;
    });
    const root = createRoot(document.getElementById('root')!);
    try {
      await act(async () => root.render(createElement(VoiceMessageContent, { voice })));
      await act(async () => document.querySelector<HTMLButtonElement>('.app-voice-play-button')!.click());
      await waitForReactCondition(() => calls.includes('desktop_chat_read_attachment'), 'native attachment read started');
      if (delayed !== 'read') {
        await waitForReactCondition(() => calls.includes('desktop_voice_play'), 'native playback started before removal');
      }
      // A deletion event removes the transcript row while native work can still be pending.
      await act(async () => root.render(createElement('div')));
      await act(async () => { finish(); await pending; });
      await waitForReactCondition(() => readCompleted, 'native attachment read completed');
      if (delayed === 'read') {
        // Use the same dynamically imported IPC path as playback as a completion fence.
        await act(async () => { await invokeDesktop('test_voice_playback_barrier'); });
        assert.equal(calls.includes('desktop_voice_play'), false, 'removed row must never start playback');
      } else {
        await waitForReactCondition(
          () => playCompleted && !nativePlaying && calls.at(-1) === 'desktop_voice_stop',
          'removal and any late play acknowledgement stop native playback',
        );
        assert.ok(calls.includes('desktop_voice_play'));
        assert.equal(calls.at(-1), 'desktop_voice_stop', 'removed row leaves native playback stopped');
      }
    } finally {
      finish();
      await act(async () => root.unmount());
      clearMocks();
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

for (const removal of ['before', 'after', 'commit-gap']) {
  test(`browser audio releases its URL only after removal (removal=${removal})`, async t => {
    const { withJsdomRoot } = await import('./helpers/mountWithJsdom');
    const { __setSessionBackendForTests } = await import('../src/features/cloud/session');
    const revoked: string[] = [];
    let plays = 0;
    let pauses = 0;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let removeInBatch = () => {};
    t.mock.method(URL, 'createObjectURL', () => {
      if (removal === 'commit-gap') removeInBatch();
      return 'blob:synthetic-voice';
    });
    t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
    t.mock.method(globalThis, 'fetch', async () => {
      await pending;
      return new Response(new Uint8Array(2048), { headers: { 'content-type': 'audio/mp4' } });
    });
    __setSessionBackendForTests({
      load: async () => ({ token: 'synthetic-token', accountId: 'synthetic-account', expiresAt: '2999-01-01T00:00:00Z' }),
      save: async () => {}, clear: async () => {},
    });
    try {
      await withJsdomRoot(async (mount, root) => {
        removeInBatch = () => root.render(createElement('div'));
        t.mock.method(window.HTMLMediaElement.prototype, 'play', async () => { plays++; });
        t.mock.method(window.HTMLMediaElement.prototype, 'pause', () => { pauses++; });
        t.mock.method(window.HTMLMediaElement.prototype, 'load', () => {});
        await mount(createElement(VoiceMessageContent, { voice: { ...voice, localPath: null } }));
        await act(async () => document.querySelector<HTMLButtonElement>('.app-voice-play-button')!.click());
        if (removal === 'before') await mount(createElement('div'));
        await act(async () => { finish(); await pending; });
        if (removal === 'before') {
          assert.equal(plays, 0, 'a detached audio element must not start');
        } else if (removal === 'after') {
          assert.equal(plays, 1);
          assert.equal(document.querySelector('audio')?.getAttribute('src'), 'blob:synthetic-voice');
          assert.deepEqual(revoked, [], 'publishing the source must not revoke its new URL');
          await mount(createElement('div'));
        }
        assert.deepEqual(revoked, ['blob:synthetic-voice']);
        assert.equal(pauses, 1, 'removing the row pauses the detached audio element');
      });
    } finally {
      finish();
      __setSessionBackendForTests(null);
    }
  });
}
