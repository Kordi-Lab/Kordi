import { createRoot } from 'react-dom/client';
import { VoiceRecordingRail } from '../../src/kordi-app/components/voiceMessage';
import type { VoiceMessageRecorderState } from '../../src/features/chat/useVoiceMessageRecorder';
import '../../src/index.css';

const state: VoiceMessageRecorderState = {
  phase: 'review', transcriptionPhase: 'error', locked: true, durationMs: 8000,
  waveformSamples: [0.2, 0.5, 0.8, 0.4, 0.7, 0.3, 0.5, 0.8], transcript: '',
  trimStartMs: 0, trimEndMs: 8000,
  error: 'Allow Kordi to use Speech Recognition in System Settings and try again.',
  attachment: { id: 'synthetic-audio', name: 'Voice message.m4a', path: '', kind: 'file',
    voiceMessage: { mimeType: 'audio/mp4', durationMs: 8000, waveformSamples: [0.2, 0.5], transcript: '',
      transcription: { status: 'unavailable', sourceVersion: 'synthetic-audio', engine: 'apple-speech-v1', attempts: 1 } } },
};
const noop = () => {};
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 40, maxWidth: 800, margin: '0 auto' }}>
    <h1 style={{ fontSize: 20, marginBottom: 24 }}>Voice transcription · synthetic fixture</h1>
    <h2 style={{ fontSize: 14, marginBottom: 12 }}>Permission unavailable · saved audio can be retried</h2>
    <VoiceRecordingRail state={state} onCancel={noop} onSend={noop} onRetry={noop} onTrimRange={noop} />
    <h2 style={{ fontSize: 14, marginTop: 36, marginBottom: 12 }}>Transcribing · send waits for speech</h2>
    <VoiceRecordingRail state={{ ...state, transcriptionPhase: 'transcribing', error: null }} onCancel={noop} onSend={noop} onRetry={noop} onTrimRange={noop} />
  </main>,
);
