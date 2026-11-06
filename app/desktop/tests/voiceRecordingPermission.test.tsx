import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import {
  useVoiceMessageRecorder,
  voiceMicrophonePermissionIssue,
  type VoiceMessageRecorderState,
} from '../src/features/chat/useVoiceMessageRecorder';
import { VoiceRecordingRail } from '../src/kordi-app/components/voiceRecordingRail';

const NATIVE_DENIED = 'Allow Kordi to use the microphone in System Settings and try again.';

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    __TAURI_INTERNALS__: {},
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return {
    dom,
    restore() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const failedState = (permissionIssue: VoiceMessageRecorderState['permissionIssue']): VoiceMessageRecorderState => ({
  phase: 'error',
  durationMs: 0,
  waveformSamples: [],
  attachment: null,
  trimStartMs: 0,
  trimEndMs: 0,
  error: NATIVE_DENIED,
  permissionIssue,
});

test('only a refused microphone becomes a permission issue', () => {
  assert.equal(voiceMicrophonePermissionIssue('Microphone permission request timed out.'), null);
  assert.equal(voiceMicrophonePermissionIssue(null), null);
  assert.deepEqual(voiceMicrophonePermissionIssue(NATIVE_DENIED)?.sources, ['microphone']);
  assert.deepEqual(voiceMicrophonePermissionIssue('Allow microphone access in your browser')?.sources, ['microphone']);
});

test('a refused microphone sets the permission issue on the recorder', async () => {
  const environment = installDom();
  let failWith = NATIVE_DENIED;
  mockIPC(command => {
    if (command === 'desktop_voice_record_start') throw failWith;
    return undefined;
  });
  const root = createRoot(document.getElementById('root')!);
  let recorder!: ReturnType<typeof useVoiceMessageRecorder>;
  function Probe() { recorder = useVoiceMessageRecorder(); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await recorder.start(); });
    assert.equal(recorder.state.phase, 'error');
    assert.deepEqual(recorder.state.permissionIssue, { sources: ['microphone'], canOpenSettings: true });

    failWith = 'The microphone is in use by another app.';
    await act(async () => { await recorder.start(); });
    assert.equal(recorder.state.phase, 'error');
    assert.equal(recorder.state.permissionIssue, null);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    environment.restore();
  }
});

test('the voice rail asks for microphone access in the shared dialog', async () => {
  const markup = renderToStaticMarkup(createElement(VoiceRecordingRail, {
    state: failedState({ sources: ['microphone'], canOpenSettings: true }),
    onCancel: () => undefined,
    onSend: () => undefined,
    onRetry: () => undefined,
    onTrimRange: () => undefined,
  }));
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /Allow microphone access/);
  assert.match(markup, /Privacy &amp; Security › Microphone, then record again\./);
  assert.match(markup, /Open System Settings/);

  const browserMarkup = renderToStaticMarkup(createElement(VoiceRecordingRail, {
    state: failedState({ sources: ['microphone'], canOpenSettings: false }),
    onCancel: () => undefined,
    onSend: () => undefined,
    onRetry: () => undefined,
    onTrimRange: () => undefined,
  }));
  assert.match(browserMarkup, /browser&#x27;s site settings, then record again\./);
  assert.doesNotMatch(browserMarkup, /Open System Settings/);

  const plainMarkup = renderToStaticMarkup(createElement(VoiceRecordingRail, {
    state: { ...failedState(null), error: 'The microphone is in use by another app.' },
    onCancel: () => undefined,
    onSend: () => undefined,
    onRetry: () => undefined,
    onTrimRange: () => undefined,
  }));
  assert.doesNotMatch(plainMarkup, /role="dialog"/);

  const environment = installDom();
  const root = createRoot(document.getElementById('root')!);
  let cancels = 0;
  try {
    await act(async () => root.render(createElement(VoiceRecordingRail, {
      state: failedState({ sources: ['microphone'], canOpenSettings: true }),
      onCancel: () => { cancels += 1; },
      onSend: () => undefined,
      onRetry: () => undefined,
      onTrimRange: () => undefined,
    })));
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find(button => button.textContent === 'Cancel');
    assert.ok(cancel);
    await act(async () => cancel.click());
    assert.equal(cancels, 1);
  } finally {
    await act(async () => root.unmount());
    environment.restore();
  }
});
