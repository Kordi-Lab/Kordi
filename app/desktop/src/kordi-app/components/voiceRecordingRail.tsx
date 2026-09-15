import { LoaderCircle, Mic, Pause, Play, RotateCcw, Scissors, Send, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { VoiceMessageRecorderState } from '@/features/chat/useVoiceMessageRecorder';
import { MAX_TRANSCRIPTION_ATTEMPTS } from '@/features/chat/voiceTranscription';
import { formatVoiceDuration, localVoiceSource } from './voiceAudioSource';
import { VoiceWaveform } from './voiceWaveform';

type Props = {
  state: VoiceMessageRecorderState;
  onCancel: () => void;
  onSend: () => void;
  onRetry: () => void;
  onTrimRange: (startMs: number, endMs: number) => void;
};

export function VoiceRecordingRail({ state, onCancel, onSend, onRetry, onTrimRange }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [trimming, setTrimming] = useState(false);
  const recording = state.phase === 'recording';
  const pending = !recording && state.transcriptionPhase === 'transcribing';
  const failed = !recording && Boolean(state.error);
  const duration = recording ? state.durationMs : Math.max(0, state.trimEndMs - state.trimStartMs);
  const progress = duration ? Math.max(0, Math.min(1, (elapsedMs - state.trimStartMs) / duration)) : 0;
  const path = state.attachment?.localPath ?? state.attachment?.path;
  const canTrim = Boolean(state.attachment) && !pending;
  const retryDisabled = (state.attachment?.voiceMessage?.transcription?.attempts ?? 0) >= MAX_TRANSCRIPTION_ATTEMPTS
    && state.trimStartMs <= 50 && state.trimEndMs >= state.durationMs - 50;
  const status = recording ? 'Recording' : pending ? 'Transcribing…'
    : /Allow Kordi.*microphone/i.test(state.error ?? '') ? 'Allow microphone access in Settings'
    : /Allow Kordi.*Speech Recognition/i.test(state.error ?? '') ? 'Allow Speech Recognition in Settings'
    : failed ? state.attachment ? state.transcriptionPhase === 'ready' ? 'Send failed · recording saved' : 'Transcription failed · recording saved'
      : 'Could not start recording' : 'Ready to send';

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void localVoiceSource(path).then(url => {
      objectUrl = url;
      if (cancelled) { if (url) URL.revokeObjectURL(url); return; }
      setSource(url);
    }).catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !source) return;
    if (audio.currentTime * 1000 < state.trimStartMs || audio.currentTime * 1000 >= state.trimEndMs) audio.currentTime = state.trimStartMs / 1000;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }

  return <div className="app-voice-recording-rail" data-phase={state.phase} onKeyDown={event => {
    if (event.key === 'Escape') { if (trimming) setTrimming(false); else onCancel(); }
  }}>
    <audio ref={audioRef} src={source ?? undefined} preload="metadata" onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={event => {
        const audio = event.currentTarget;
        if (audio.currentTime * 1000 >= state.trimEndMs) { audio.pause(); audio.currentTime = state.trimStartMs / 1000; }
        setElapsedMs(audio.currentTime * 1000);
      }} />
    <button type="button" className="app-voice-control" onClick={onCancel}
      aria-label={recording ? 'Cancel voice recording' : state.attachment ? 'Delete voice recording' : 'Dismiss voice recording'} title="Discard recording">
      {state.attachment || recording ? <Trash2 size={16} /> : <X size={16} />}
    </button>
    {recording ? <span className="app-voice-play-button app-voice-recording-indicator"><Mic size={17} /></span>
      : <button type="button" className="app-voice-play-button" onClick={togglePlayback} disabled={!source}
          aria-label={playing ? 'Pause voice recording preview' : 'Play voice recording preview'}>
          {playing ? <Pause size={16} className="fill-current" /> : <Play size={16} className="fill-current" />}
        </button>}
    <div className="app-voice-recording-main">
      <div className="app-voice-scrubber">
        <VoiceWaveform samples={state.waveformSamples} progress={progress} live={recording} count={96} />
        {!recording && <input type="range" min="0" max="1" step="0.01" value={progress} disabled={!source}
          aria-label="Voice recording preview position" onChange={event => {
            const next = state.trimStartMs + Number(event.target.value) * duration;
            if (audioRef.current) audioRef.current.currentTime = next / 1000;
            setElapsedMs(next);
          }} />}
      </div>
      <span className="app-voice-recording-status" role="status" title={state.error ?? undefined}>
        {pending ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : recording ? <span className="app-voice-recording-dot" /> : null}
        <span>{status}</span>
      </span>
    </div>
    <span className="app-voice-recording-duration">{formatVoiceDuration(duration)}</span>
    <div className="app-voice-trim-action">
      <button type="button" className="app-voice-control" onClick={() => setTrimming(value => !value)} disabled={!canTrim}
        style={{ visibility: state.attachment ? 'visible' : 'hidden' }} aria-label="Trim voice recording" aria-expanded={trimming} title="Trim recording">
        <Scissors size={16} />
      </button>
      {trimming && <div className="app-voice-trim-popover" role="group" aria-label="Trim voice recording range">
        <label>Start <span>{formatVoiceDuration(state.trimStartMs)}</span><input type="range" min="0" max={state.durationMs} step="50" value={state.trimStartMs}
          disabled={!canTrim} onChange={event => onTrimRange(Number(event.target.value), state.trimEndMs)} aria-label="Trim voice message start" /></label>
        <label>End <span>{formatVoiceDuration(state.trimEndMs)}</span><input type="range" min="0" max={state.durationMs} step="50" value={state.trimEndMs}
          disabled={!canTrim} onChange={event => onTrimRange(state.trimStartMs, Number(event.target.value))} aria-label="Trim voice message end" /></label>
        <button type="button" onClick={() => setTrimming(false)}>Done</button>
      </div>}
    </div>
    <span className="app-voice-retry-slot">
      {!pending && !recording && (state.transcriptionPhase === 'error' || state.phase === 'error') ?
        <button type="button" className="app-voice-control" onClick={onRetry} disabled={Boolean(state.attachment) && retryDisabled}
          aria-label={state.attachment ? 'Retry voice transcription' : 'Record voice message again'} title={state.attachment ? 'Retry transcription' : 'Try recording again'}><RotateCcw size={16} /></button> : null}
    </span>
    <button type="button" className="app-voice-send-button" onClick={onSend}
      disabled={!recording && (state.transcriptionPhase !== 'ready')}
      aria-label={recording ? 'Stop and send voice message' : 'Send voice message'} title={recording ? 'Stop and send' : 'Send voice message'}>
      {recording ? <Square size={15} className="fill-current" /> : <Send size={17} />}
    </button>
  </div>;
}
