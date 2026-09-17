import { LoaderCircle, Pause, Play, RotateCcw, Scissors, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { VoiceMessageRecorderState } from '@/features/chat/useVoiceMessageRecorder';
import { MAX_TRANSCRIPTION_ATTEMPTS } from '@/features/chat/voiceTranscription';
import { cn } from '@/lib/utils';
import { formatVoiceDuration, localVoiceSource } from './voiceAudioSource';
import { VoiceWaveform } from './voiceWaveform';

type Props = {
  state: VoiceMessageRecorderState;
  cancelArmed?: boolean;
  onCancel: () => void;
  onSend: () => void;
  onRetry: () => void;
  onTrimRange: (startMs: number, endMs: number) => void;
};

export function VoiceRecordingRail({ state, cancelArmed = false, onCancel, onSend, onRetry, onTrimRange }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [trimming, setTrimming] = useState(false);
  const recording = state.phase === 'recording';
  const holding = recording && !state.locked;
  const pending = !recording && state.transcriptionPhase === 'transcribing';
  const failed = !recording && Boolean(state.error);
  const duration = recording ? state.durationMs : Math.max(0, state.trimEndMs - state.trimStartMs);
  const progress = duration ? Math.max(0, Math.min(1, (elapsedMs - state.trimStartMs) / duration)) : 0;
  const path = state.attachment?.localPath ?? state.attachment?.path;
  const canTrim = Boolean(state.attachment) && !pending;
  const canSend = recording || state.transcriptionPhase === 'ready';
  const retryDisabled = (state.attachment?.voiceMessage?.transcription?.attempts ?? 0) >= MAX_TRANSCRIPTION_ATTEMPTS
    && state.trimStartMs <= 50 && state.trimEndMs >= state.durationMs - 50;
  const status = holding ? cancelArmed ? 'Release to cancel' : 'Swipe up to cancel'
    : recording ? 'Recording' : pending ? 'Transcribing…'
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

  return <div className="app-voice-recording-rail" data-phase={state.phase} data-failed={failed ? 'true' : undefined}
    data-cancel-armed={holding && cancelArmed ? 'true' : undefined} onKeyDown={event => {
      if (event.key === 'Escape') { if (trimming) setTrimming(false); else onCancel(); }
    }}>
    <audio ref={audioRef} src={source ?? undefined} preload="metadata" onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={event => {
        const audio = event.currentTarget;
        if (audio.currentTime * 1000 >= state.trimEndMs) { audio.pause(); audio.currentTime = state.trimStartMs / 1000; }
        setElapsedMs(audio.currentTime * 1000);
      }} />
    <button type="button" className="app-voice-cancel-button" onClick={onCancel}
      aria-label={recording ? 'Cancel voice recording' : state.attachment ? 'Delete voice recording' : 'Dismiss voice recording'} title="Discard recording">
      <X size={18} strokeWidth={2} />
    </button>
    <div className="app-voice-pill">
      {state.attachment ? <button type="button" className="app-voice-control" onClick={togglePlayback} disabled={!source}
        aria-label={playing ? 'Pause voice recording preview' : 'Play voice recording preview'}>
        {playing ? <Pause size={14} className="fill-current" /> : <Play size={14} className="fill-current" />}
      </button> : null}
      {failed ? null : <div className="app-voice-scrubber">
        <VoiceWaveform samples={state.waveformSamples} progress={progress} live={recording} count={recording ? 24 : 40} />
        {!recording && <input type="range" min="0" max="1" step="0.01" value={progress} disabled={!source}
          aria-label="Voice recording preview position" onChange={event => {
            const next = state.trimStartMs + Number(event.target.value) * duration;
            if (audioRef.current) audioRef.current.currentTime = next / 1000;
            setElapsedMs(next);
          }} />}
      </div>}
      <span className={cn('app-voice-recording-status', !(holding || pending || failed) && 'sr-only')}
        role="status" title={state.error ?? undefined}>
        {pending ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : null}
        <span>{status}</span>
      </span>
      {state.phase === 'error' && !state.attachment ? null
        : <span className="app-voice-recording-duration">{formatVoiceDuration(duration)}</span>}
      {state.attachment ? <div className="app-voice-trim-action">
        <button type="button" className="app-voice-control" onClick={() => setTrimming(value => !value)} disabled={!canTrim}
          aria-label="Trim voice recording" aria-expanded={trimming} title="Trim recording">
          <Scissors size={15} />
        </button>
        {trimming && <div className="app-voice-trim-popover" role="group" aria-label="Trim voice recording range">
          <label>Start <span>{formatVoiceDuration(state.trimStartMs)}</span><input type="range" min="0" max={state.durationMs} step="50" value={state.trimStartMs}
            disabled={!canTrim} onChange={event => onTrimRange(Number(event.target.value), state.trimEndMs)} aria-label="Trim voice message start" /></label>
          <label>End <span>{formatVoiceDuration(state.trimEndMs)}</span><input type="range" min="0" max={state.durationMs} step="50" value={state.trimEndMs}
            disabled={!canTrim} onChange={event => onTrimRange(state.trimStartMs, Number(event.target.value))} aria-label="Trim voice message end" /></label>
          <button type="button" onClick={() => setTrimming(false)}>Done</button>
        </div>}
      </div> : null}
      {!pending && !recording && (state.transcriptionPhase === 'error' || state.phase === 'error') ?
        <button type="button" className="app-voice-control" onClick={onRetry} disabled={Boolean(state.attachment) && retryDisabled}
          aria-label={state.attachment ? 'Retry voice transcription' : 'Record voice message again'} title={state.attachment ? 'Retry transcription' : 'Try recording again'}><RotateCcw size={15} /></button> : null}
      <Button className="app-composer-send app-composer-send-compact h-8 w-8 shrink-0 rounded-full p-0" onClick={onSend}
        disabled={!canSend} data-composer-send={canSend ? 'true' : undefined}
        aria-label={recording ? 'Stop and send voice message' : 'Send voice message'} title={recording ? 'Stop and send' : 'Send voice message'}>
        <Send className="h-[15px] w-[15px]" />
      </Button>
    </div>
  </div>;
}
