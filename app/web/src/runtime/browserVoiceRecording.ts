import { browserAttachmentBlob, storeBrowserAttachment } from '@web/runtime/browserAttachments';

type Recording = {
  recorder: MediaRecorder; stream: MediaStream; context: AudioContext; analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode; chunks: Blob[]; startedAt: number; bytes: number;
  failure: Error | null; completion: Promise<void>; released: boolean;
};
let active: Recording | null = null;
let generation = 0;
const TOO_SHORT = 'Voice recording must be at least one second.';

/** A portable mono PCM recording, playable without the recorder's container codec. */
export function browserVoiceWav(channels: readonly Float32Array[], sampleRate: number, start = 0, end = channels[0]?.length ?? 0): Blob {
  const frames = Math.max(0, end - start);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const word = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + (channel[start + frame] ?? 0), 0) / Math.max(1, channels.length)));
    view.setInt16(44 + frame * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function release(recording: Recording) {
  if (recording.released) return;
  recording.released = true;
  recording.stream.getTracks().forEach(track => track.stop());
  recording.source.disconnect();
  void recording.context.close().catch(() => undefined);
}

export function clearBrowserVoiceRecording() {
  generation += 1;
  const recording = active;
  active = null;
  if (!recording) return;
  if (recording.recorder.state !== 'inactive') recording.recorder.stop();
  release(recording);
}

/** Browser permission errors carry engine-specific text; show one short, actionable line. */
export function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow microphone access in your browser';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is in use';
  return 'Could not start recording';
}

async function startRecording() {
  clearBrowserVoiceRecording();
  const started = generation;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
    throw new Error('Voice recording is unavailable in this browser. Use a supported browser with microphone access.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((error: unknown) => {
    throw new Error(microphoneErrorMessage(error));
  });
  if (started !== generation) { stream.getTracks().forEach(track => track.stop()); throw new Error('Recording was canceled.'); }
  const context = new AudioContext();
  try {
    await context.resume();
    if (started !== generation) throw new Error('Recording was canceled.');
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : undefined);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const recording: Recording = { recorder, stream, context, analyser, source, chunks: [], startedAt: performance.now(), bytes: 0, failure: null, completion, released: false };
    recorder.ondataavailable = event => {
      recording.bytes += event.data.size;
      if (recording.bytes > 16 * 1024 * 1024) {
        recording.failure = new Error('The recording is too large. Record a shorter voice message.');
        if (recorder.state !== 'inactive') recorder.stop();
      } else if (event.data.size) recording.chunks.push(event.data);
    };
    recorder.onerror = () => { recording.failure = new Error('The microphone stopped. Try recording again.'); release(recording); finish(); };
    recorder.onstop = () => { release(recording); finish(); };
    recorder.start(250); active = recording;
    return 'browser-microphone';
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    void context.close().catch(() => undefined);
    throw error;
  }
}

async function wavFromBlob(blob: Blob, startMs = 0, endMs?: number) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const start = Math.max(0, Math.min(decoded.length, Math.floor(startMs * decoded.sampleRate / 1000)));
    const end = Math.max(start, Math.min(decoded.length, Math.floor((endMs ?? 60_000) * decoded.sampleRate / 1000)));
    if (end <= start) throw new Error('The recording contains no playable audio.');
    return browserVoiceWav(Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel)), decoded.sampleRate, start, end);
  } finally { await context.close(); }
}

export async function runBrowserVoiceCommand(command: string, args: Record<string, unknown>, assertCurrent: () => Promise<void>) {
  if (command === 'desktop_voice_record_start') {
    const result = await startRecording();
    try { await assertCurrent(); return result; }
    catch (error) { clearBrowserVoiceRecording(); throw error; }
  }
  if (command === 'desktop_voice_record_cancel') { clearBrowserVoiceRecording(); return; }
  if (command === 'desktop_voice_trim') {
    const start = Number(args.startMs); const end = Number(args.endMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 60_000) throw new Error('Choose a valid voice message range.');
    const wav = await wavFromBlob(browserAttachmentBlob(String(args.path)), start, end);
    await assertCurrent();
    return storeBrowserAttachment(wav, 'Voice message.wav').path;
  }
  const recording = active;
  if (!recording) throw new Error('No voice recording is active.');
  if (command === 'desktop_voice_record_sample') {
    const samples = new Float32Array(recording.analyser.fftSize);
    recording.analyser.getFloatTimeDomainData(samples);
    return { durationMs: performance.now() - recording.startedAt,
      level: Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 3) };
  }
  if (command !== 'desktop_voice_record_stop') throw new Error('Unsupported browser voice operation.');
  active = null;
  const started = generation;
  const durationMs = Math.min(60_000, performance.now() - recording.startedAt);
  try {
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    await recording.completion;
    release(recording);
    if (recording.failure) throw recording.failure;
    if (durationMs < 1000) throw new Error(TOO_SHORT);
    const wav = await wavFromBlob(new Blob(recording.chunks, { type: recording.recorder.mimeType }));
    await assertCurrent();
    if (started !== generation) throw new Error('Recording was canceled.');
    const stored = storeBrowserAttachment(wav, 'Voice message.wav');
    return { path: stored.path, durationMs, sizeBytes: wav.size };
  } finally { release(recording); }
}
