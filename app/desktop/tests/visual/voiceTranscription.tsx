import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Send } from 'lucide-react';
import { VoiceRecordingRail } from '../../src/kordi-app/components/voiceMessage';
import type { VoiceMessageRecorderState } from '../../src/features/chat/useVoiceMessageRecorder';
import { ComposerDropSurface } from '../../src/pages/chatsPage.composerDropSurface';
import '../../src/index.css';

const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'theme-dark' : 'theme-light';
document.body.classList.add('kordi-native-shell', theme);
document.body.dataset.kordiChatTheme = 'quiet';
const waveform = Array.from({ length: 48 }, (_, i) => 0.12 + Math.abs(Math.sin(i * 0.71) * Math.cos(i * 0.23)) * 0.8);
const initial: VoiceMessageRecorderState = {
  phase: 'review', durationMs: 8000,
  waveformSamples: waveform, trimStartMs: 0, trimEndMs: 8000, error: null,
  attachment: { id: 'synthetic-audio', name: 'Voice message.m4a', path: '', kind: 'file',
    voiceMessage: { mimeType: 'audio/mp4', durationMs: 8000, waveformSamples: waveform, transcript: '',
      transcription: { status: 'pending', sourceVersion: 'synthetic-audio', engine: 'apple-speech-v1', attempts: 0 } } },
};
const noop = () => {};
function Fixture() {
  const [mode, setMode] = useState('Idle');
  const [range, setRange] = useState([0, 8000]);
  const active = mode !== 'Idle';
  const state: VoiceMessageRecorderState = { ...initial, trimStartMs: range[0], trimEndMs: range[1],
    phase: mode === 'Recording' ? 'recording' : 'review',
    error: mode === 'Send failed' ? 'Could not send this voice message. Your recording is saved; try sending again.' : null,
    attachment: mode === 'Recording' ? null : initial.attachment,
  };
  return <main className={`kordi-app ${theme}`} style={{ padding: 24, minHeight: '100vh', background: 'var(--app-main-bg)' }}>
    <nav style={{ display: 'flex', gap: 16, height: 40, marginBottom: 80 }}>
      {['Idle', 'Recording', 'Ready', 'Send failed'].map(value => <button key={value} onClick={() => setMode(value)}>{value}</button>)}
    </nav>
    <ComposerDropSurface saveDesktopAttachments={async () => {}}>
      <div className="relative"><div className="app-composer-input rounded-[18px] px-4 py-2.5">
        <div style={{ minHeight: 24, lineHeight: '24px' }}>Message</div>
      </div></div>
      <div className="app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2.5">
        <div className="flex shrink-0 items-center gap-2">
          {active ? null : <button className="app-button-quiet grid h-9 w-9 place-items-center rounded-full" aria-label="Add attachment"><Plus size={18} /></button>}
        </div>
        {active ? <VoiceRecordingRail state={state} onCancel={() => setMode('Idle')} onSend={noop} onRetry={noop} onTrimRange={(a, b) => setRange([a, b])} />
          : <div className="flex h-10 items-center gap-2 pr-1">
            <button className="app-button-quiet grid h-9 w-9 place-items-center rounded-full" aria-label="Record voice message">Mic</button>
            <button className="app-button-primary app-composer-send app-composer-send-compact grid h-8 w-8 place-items-center rounded-full" aria-label="Send message" disabled><Send size={15} /></button>
          </div>}
      </div>
    </ComposerDropSurface>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
