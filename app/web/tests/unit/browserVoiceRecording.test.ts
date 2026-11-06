import assert from 'node:assert/strict';
import test from 'node:test';
import { browserVoiceWav, clearBrowserVoiceRecording, microphoneErrorMessage, runBrowserVoiceCommand } from '@web/runtime/browserVoiceRecording';
import { browserAttachmentBlob, clearBrowserAttachments } from '@web/runtime/browserAttachments';

test('browser voice WAV preserves real PCM samples and requested trim bounds', async () => {
  const wav = browserVoiceWav([new Float32Array([-1, 0, 1, 0.5])], 16_000, 1, 4);
  const bytes = new DataView(await wav.arrayBuffer());
  assert.equal(wav.type, 'audio/wav');
  assert.equal(wav.size, 50);
  assert.equal(bytes.getUint32(24, true), 16_000);
  assert.equal(bytes.getInt16(44, true), 0);
  assert.equal(bytes.getInt16(46, true), 32767);
  assert.equal(bytes.getInt16(48, true), 16384);
});

function recordingFixture() {
  const descriptors = new Map(['navigator', 'MediaRecorder', 'AudioContext', 'performance'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let now = 0;
  let stopped = 0;
  let allowMicrophone: (() => void) | null = null;
  let waitForPermission = false;
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }] };
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['encoded audio']) }); this.onstop?.(); }
  }
  class Context {
    async resume() {} async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 256, getFloatTimeDomainData(samples: Float32Array) { samples.fill(0.1); } }; }
    async decodeAudioData() { return { sampleRate: 16_000, length: 32_000, numberOfChannels: 1, getChannelData: () => new Float32Array(32_000).fill(0.25) }; }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
    if (waitForPermission) await new Promise<void>(resolve => { allowMicrophone = resolve; });
    return stream;
  } } } });
  for (const [name, value] of [['MediaRecorder', Recorder], ['AudioContext', Context], ['performance', { now: () => now }]] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  return { advance: (value: number) => { now = value; }, stopped: () => stopped,
    deferPermission: () => { waitForPermission = true; }, allow: () => allowMicrophone?.(), restore: () => {
      clearBrowserVoiceRecording(); clearBrowserAttachments();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    } };
}

test('browser recording stops microphone tracks, retains audio and trims through the same attachment store', async () => {
  const fixture = recordingFixture();
  try {
    await runBrowserVoiceCommand('desktop_voice_record_start', {}, async () => {});
    fixture.advance(2000);
    const sample = await runBrowserVoiceCommand('desktop_voice_record_sample', {}, async () => {}) as { durationMs: number; level: number };
    assert.equal(sample.durationMs, 2000); assert.ok(sample.level > 0);
    const saved = await runBrowserVoiceCommand('desktop_voice_record_stop', {}, async () => {}) as { path: string; sizeBytes: number };
    assert.equal(fixture.stopped(), 1); assert.equal(saved.sizeBytes, 64_044);
    assert.equal(browserAttachmentBlob(saved.path).type, 'audio/wav');
    const trimmed = await runBrowserVoiceCommand('desktop_voice_trim', { path: saved.path, startMs: 500, endMs: 1500 }, async () => {}) as string;
    assert.equal(browserAttachmentBlob(trimmed).size, 32_044);
  } finally { fixture.restore(); }
});

test('canceling pending microphone permission closes the late stream without starting recording', async () => {
  const fixture = recordingFixture(); fixture.deferPermission();
  try {
    const pending = runBrowserVoiceCommand('desktop_voice_record_start', {}, async () => {});
    clearBrowserVoiceRecording(); fixture.allow();
    await assert.rejects(pending, /canceled/);
    assert.equal(fixture.stopped(), 1);
  } finally { fixture.restore(); }
});

test('an account switch rejects the saved recording before publishing its attachment', async () => {
  const fixture = recordingFixture();
  try {
    await runBrowserVoiceCommand('desktop_voice_record_start', {}, async () => {}); fixture.advance(2000);
    await assert.rejects(runBrowserVoiceCommand('desktop_voice_record_stop', {}, async () => { throw new Error('account changed'); }), /account changed/);
    assert.equal(fixture.stopped(), 1);
  } finally { fixture.restore(); }
});

test('a denied or missing microphone shows one short browser-neutral message', () => {
  const named = (name: string) => Object.assign(new Error('engine-specific text'), { name });
  assert.equal(microphoneErrorMessage(named('NotAllowedError')), 'Allow microphone access in your browser');
  assert.equal(microphoneErrorMessage(named('SecurityError')), 'Allow microphone access in your browser');
  assert.equal(microphoneErrorMessage(named('NotFoundError')), 'No microphone found');
  assert.equal(microphoneErrorMessage(named('NotReadableError')), 'The microphone is in use');
  assert.equal(microphoneErrorMessage('unknown'), 'Could not start recording');
});
