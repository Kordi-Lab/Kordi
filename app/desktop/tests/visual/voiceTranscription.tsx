import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceRecordingRail } from '../../src/kordi-app/components/voiceMessage';
import type { VoiceMessageRecorderState } from '../../src/features/chat/useVoiceMessageRecorder';
import { ComposerDropSurface } from '../../src/pages/chatsPage.composerDropSurface';
import { useVoiceComposerLayout } from '../../src/pages/useVoiceComposerLayout';
import '../../src/index.css';

const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'theme-dark' : 'theme-light';
document.body.classList.add('kordi-native-shell', theme);
document.body.dataset.kordiChatTheme = 'quiet';
const waveform = Array.from({ length: 48 }, (_, i) => 0.12 + Math.abs(Math.sin(i * 0.71) * Math.cos(i * 0.23)) * 0.8);
const initial: VoiceMessageRecorderState = {
  phase: 'review', transcriptionPhase: 'error', locked: true, durationMs: 8000,
  waveformSamples: waveform, transcript: '', trimStartMs: 0, trimEndMs: 8000, error: 'Retry',
  attachment: { id: 'synthetic-audio', name: 'Voice message.m4a', path: '', kind: 'file',
    voiceMessage: { mimeType: 'audio/mp4', durationMs: 8000, waveformSamples: waveform, transcript: '',
      transcription: { status: 'failed', sourceVersion: 'synthetic-audio', engine: 'apple-speech-v1', attempts: 1 } } },
};
const noop = () => {};
function Fixture() {
  const [mode, setMode] = useState('Idle');
  const [range, setRange] = useState([0, 8000]);
  const active = mode !== 'Idle';
  const ref = useVoiceComposerLayout(active);
  const state: VoiceMessageRecorderState = { ...initial, trimStartMs: range[0], trimEndMs: range[1],
    phase: mode === 'Recording' ? 'recording' : mode === 'Pending' ? 'sending' : 'review',
    transcriptionPhase: mode === 'Pending' ? 'transcribing' : mode === 'Retry' ? 'error' : 'ready',
    error: mode === 'Retry' ? 'Retry' : null,
    attachment: mode === 'Recording' ? null : initial.attachment,
  };
  return <main className={`kordi-app ${theme}`} style={{ padding: 24, minHeight: '100vh', background: 'var(--app-main-bg)' }}>
    <nav style={{ display: 'flex', gap: 16, height: 40, marginBottom: 80 }}>
      {['Idle', 'Recording', 'Pending', 'Retry', 'Ready'].map(value => <button key={value} onClick={() => setMode(value)}>{value}</button>)}
    </nav>
    <div ref={ref}>
      <ComposerDropSurface saveDesktopAttachments={async () => {}}>
        <div className="relative"><div className="app-composer-input rounded-[18px] px-4 py-2.5">
          {active ? <VoiceRecordingRail state={state} onCancel={() => setMode('Idle')} onSend={noop} onRetry={noop} onTrimRange={(a, b) => setRange([a, b])} />
            : <div style={{ minHeight: 24, lineHeight: '24px' }}>Message</div>}
        </div></div>
        <div className={`app-composer-meta mt-2 items-center justify-between gap-4 pt-2.5 ${active ? 'hidden' : 'flex'}`}>
          <span>+</span><button style={{ width: 40, height: 40 }}>Mic</button>
        </div>
      </ComposerDropSurface>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
