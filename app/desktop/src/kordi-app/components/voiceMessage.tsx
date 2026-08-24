import { FileText, LoaderCircle, Pause, Play, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { displayVoiceWaveform, type VoiceMessageRecorderState } from '@/features/chat/useVoiceMessageRecorder';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { downloadCloudAttachmentToLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import type { MessageVoice } from '@/kordi-app/types/message';
import { isNativeDesktopShell, readDesktopChatAttachment } from '@/lib/desktop';
import { pauseDesktopVoiceMessage, playDesktopVoiceMessage, seekDesktopVoiceMessage, stopDesktopVoiceMessage } from '@/lib/desktopVoice';
import { cn } from '@/lib/utils';

const VOICE_PLAY_EVENT = 'kordi:voice-message-play';
const MIN_PLAYABLE_VOICE_BYTES = 1_024;

function formatVoiceDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function VoiceWaveform({ samples, progress = 0, live = false }: {
  samples: readonly number[];
  progress?: number;
  live?: boolean;
}) {
  const values = displayVoiceWaveform(samples);
  return (
    <span className="app-voice-waveform" aria-hidden="true">
      {values.map((sample, index) => (
        <span
          key={index}
          className={cn(
            'app-voice-waveform-bar',
            index / values.length <= progress && 'app-voice-waveform-bar-played',
          )}
          style={{ height: `${Math.max(16, Math.min(100, sample * 100))}%` }}
          data-live={live ? 'true' : undefined}
        />
      ))}
    </span>
  );
}

async function localVoiceSource(path: string | null | undefined) {
  if (!path) return null;
  const bytes = await readDesktopChatAttachment(path);
  if (bytes.length < MIN_PLAYABLE_VOICE_BYTES) {
    throw new Error('Voice message audio is unavailable.');
  }
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }));
}

function VoiceDraftReview({ state, onTrimRange }: {
  state: VoiceMessageRecorderState;
  onTrimRange: (startMs: number, endMs: number) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(state.trimStartMs);
  const [speed, setSpeed] = useState(1);
  const [source, setSource] = useState<string | null>(null);
  const path = state.attachment?.localPath ?? state.attachment?.path;
  const trimDurationMs = Math.max(1, state.trimEndMs - state.trimStartMs);
  const progress = Math.max(0, Math.min(1, (elapsedMs - state.trimStartMs) / trimDurationMs));

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    let cancelled = false;
    void localVoiceSource(path).then((nextSource) => {
      if (cancelled || !nextSource) return;
      objectUrlRef.current = nextSource;
      setSource(nextSource);
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };
  }, [path]);

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !source) return;
    if (audio.currentTime * 1_000 < state.trimStartMs || audio.currentTime * 1_000 >= state.trimEndMs) {
      audio.currentTime = state.trimStartMs / 1_000;
    }
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = (state.trimStartMs + value * trimDurationMs) / 1_000;
    setElapsedMs(audio.currentTime * 1_000);
  }

  return (
    <div className="app-voice-draft-review">
      <audio
        ref={audioRef}
        preload="metadata"
        src={source ?? undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setElapsedMs(state.trimStartMs); }}
        onTimeUpdate={(event) => {
          const next = event.currentTarget.currentTime * 1_000;
          if (next >= state.trimEndMs) {
            event.currentTarget.pause();
            event.currentTarget.currentTime = state.trimStartMs / 1_000;
            setElapsedMs(state.trimStartMs);
          } else {
            setElapsedMs(next);
          }
        }}
      />
      <button type="button" className="app-voice-play-button" onClick={togglePlayback} disabled={!source} aria-label={playing ? 'Pause voice recording preview' : 'Play voice recording preview'}>
        {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
      </button>
      <div className="app-voice-scrubber">
        <VoiceWaveform samples={state.waveformSamples} progress={progress} />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={progress}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Voice recording preview position"
          aria-valuetext={`${formatVoiceDuration(elapsedMs - state.trimStartMs)} of ${formatVoiceDuration(trimDurationMs)}`}
        />
        <div className="app-voice-trim-controls">
          <input
            type="range"
            min="0"
            max={state.durationMs}
            step="50"
            value={state.trimStartMs}
            onChange={(event) => onTrimRange(Number(event.target.value), state.trimEndMs)}
            aria-label="Trim voice message start"
            aria-valuetext={formatVoiceDuration(state.trimStartMs)}
          />
          <input
            type="range"
            min="0"
            max={state.durationMs}
            step="50"
            value={state.trimEndMs}
            onChange={(event) => onTrimRange(state.trimStartMs, Number(event.target.value))}
            aria-label="Trim voice message end"
            aria-valuetext={formatVoiceDuration(state.trimEndMs)}
          />
        </div>
      </div>
      <button type="button" className="app-voice-speed" onClick={() => setSpeed((value) => value === 1 ? 1.5 : value === 1.5 ? 2 : 1)} aria-label={`Playback speed ${speed} times`}>
        {speed}×
      </button>
      <span className="app-voice-duration tabular-nums">{formatVoiceDuration(trimDurationMs)}</span>
    </div>
  );
}

export function VoiceRecordingRail({
  state,
  onCancel,
  onSend,
  onRetry,
  onTrimRange,
}: {
  state: VoiceMessageRecorderState;
  onCancel: () => void;
  onSend: () => void;
  onRetry: () => void;
  onTrimRange: (startMs: number, endMs: number) => void;
}) {
  const phaseLabel = state.phase === 'review'
      ? state.transcriptionPhase === 'transcribing' ? 'Preparing voice message' : 'Voice message ready to review'
      : state.phase === 'error' ? 'Voice recording failed' : 'Recording voice message';

  return (
    <div className="app-voice-recording-rail">
      <span className="sr-only" role="status" aria-live="polite">{phaseLabel}</span>
      {state.attachment ? (
        <>
          <button type="button" className="app-button-quiet app-voice-control" onClick={onCancel} aria-label="Delete voice recording" title="Delete recording">
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
          <VoiceDraftReview state={state} onTrimRange={onTrimRange} />
          {state.transcriptionPhase === 'transcribing' ? (
            <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-label="Preparing transcript" />
          ) : state.transcriptionPhase === 'error' ? (
            <button type="button" className="app-button-quiet app-voice-control" onClick={onRetry} aria-label="Retry voice transcription" title="Retry transcription">
              <RotateCcw className="h-4 w-4" />
            </button>
          ) : null}
          <button type="button" className="app-voice-send-button" onClick={onSend} aria-label="Send voice message">
            <Send className="h-4 w-4" />
          </button>
        </>
      ) : (
        <>
          <div className="app-error-text min-w-0 flex-1">{state.error}</div>
          <button type="button" className="app-button-quiet app-voice-control" onClick={onRetry} aria-label="Record voice message again">
            <RotateCcw className="h-4 w-4" />
          </button>
        </>
      )}
      {state.error && state.attachment ? <div className="app-voice-inline-error">{state.error}</div> : null}
    </div>
  );
}

export function VoiceMessageContent({ voice, footer }: {
  voice: MessageVoice;
  footer?: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const playbackBaseMsRef = useRef(0);
  const playbackStartedAtRef = useRef<number | null>(null);
  const playerKey = useId();
  const nativePlayback = isNativeDesktopShell();
  const [source, setSource] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showsTranscript, setShowsTranscript] = useState(false);
  const [showsFullTranscript, setShowsFullTranscript] = useState(false);
  const hasTranscript = Boolean(
    voice.transcript.trim()
      && voice.transcript.trim() !== 'Transcription unavailable.',
  );
  const progress = voice.durationMs > 0 ? Math.min(1, elapsedMs / voice.durationMs) : 0;
  const transcriptIsLong = voice.transcript.length > 320 || voice.transcript.split('\n').length > 5;
  const visibleTranscript = useMemo(() => (
    transcriptIsLong && !showsFullTranscript ? `${voice.transcript.slice(0, 300).trimEnd()}…` : voice.transcript
  ), [showsFullTranscript, transcriptIsLong, voice.transcript]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    if (nativePlayback && source) void stopDesktopVoiceMessage(source);
  }, [nativePlayback, source]);

  useEffect(() => {
    const stopOtherPlayer = (event: Event) => {
      if ((event as CustomEvent<string>).detail === playerKey) return;
      audioRef.current?.pause();
      if (nativePlayback && source) void stopDesktopVoiceMessage(source);
      playbackBaseMsRef.current = 0;
      playbackStartedAtRef.current = null;
      setPlaying(false);
    };
    window.addEventListener(VOICE_PLAY_EVENT, stopOtherPlayer);
    return () => window.removeEventListener(VOICE_PLAY_EVENT, stopOtherPlayer);
  }, [nativePlayback, playerKey, source]);

  useEffect(() => {
    if (!nativePlayback || !playing || !source) return undefined;
    const interval = window.setInterval(() => {
      if (playbackStartedAtRef.current === null) return;
      const next = playbackBaseMsRef.current
        + performance.now() - playbackStartedAtRef.current;
      if (next >= voice.durationMs) {
        playbackBaseMsRef.current = 0;
        playbackStartedAtRef.current = null;
        setPlaying(false);
        setElapsedMs(0);
        void stopDesktopVoiceMessage(source);
      } else {
        setElapsedMs(next);
      }
    }, 50);
    return () => window.clearInterval(interval);
  }, [nativePlayback, playing, source, voice.durationMs]);

  async function ensureSource(force = false) {
    if (source && !force) return source;
    setLoading(true);
    setPlaybackError(null);
    try {
      if (force && objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      if (voice.localPath) {
        try {
          if (nativePlayback) {
            const bytes = await readDesktopChatAttachment(voice.localPath);
            if (bytes.length < MIN_PLAYABLE_VOICE_BYTES) {
              throw new Error('Voice message audio is unavailable.');
            }
            setSource(voice.localPath);
            return voice.localPath;
          }
          const localSource = await localVoiceSource(voice.localPath);
          if (localSource) {
            objectUrlRef.current = localSource;
            setSource(localSource);
            return localSource;
          }
        } catch {
          // Fall through to the authenticated Cloud copy.
        }
      }
      const session = await loadSession();
      if (!session?.token) throw new Error('Sign in to play this voice message.');
      if (nativePlayback) {
        const path = await downloadCloudAttachmentToLocalPath(
          session.token,
          voice.mediaId,
          'Voice message.m4a',
        );
        const bytes = await readDesktopChatAttachment(path);
        if (bytes.length < MIN_PLAYABLE_VOICE_BYTES) {
          throw new Error('Voice message audio is unavailable.');
        }
        setSource(path);
        return path;
      }
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      const blob = await defaultCloudAuthClient()
        .downloadAttachmentContent(session.token, voice.mediaId, controller.signal)
        .finally(() => window.clearTimeout(timeout));
      if (blob.size < MIN_PLAYABLE_VOICE_BYTES) {
        throw new Error('Voice message audio is unavailable.');
      }
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      setSource(objectUrl);
      return objectUrl;
    } catch (error) {
      setPlaybackError(error instanceof Error ? error.message : 'Unable to play this voice message.');
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (nativePlayback) {
      try {
        if (playing && source) {
          const sample = await pauseDesktopVoiceMessage(source);
          const pausedAt = sample.currentMs || elapsedMs;
          playbackBaseMsRef.current = pausedAt;
          playbackStartedAtRef.current = null;
          setElapsedMs(pausedAt);
          setPlaying(false);
          return;
        }
        setPlaybackError(null);
        window.dispatchEvent(new CustomEvent(VOICE_PLAY_EVENT, { detail: playerKey }));
        setPlaying(true);
        const path = await ensureSource(Boolean(playbackError));
        if (!path) {
          playbackBaseMsRef.current = 0;
          playbackStartedAtRef.current = null;
          setPlaying(false);
          return;
        }
        const sample = await playDesktopVoiceMessage(path);
        playbackBaseMsRef.current = sample.currentMs;
        playbackStartedAtRef.current = performance.now();
        setElapsedMs(sample.currentMs);
        setPlaying(true);
      } catch (error) {
        playbackBaseMsRef.current = 0;
        playbackStartedAtRef.current = null;
        setPlaying(false);
        setPlaybackError(error instanceof Error ? error.message : 'Unable to play this voice message.');
      }
      return;
    }
    if (audio && !audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    const nextSource = await ensureSource(Boolean(playbackError));
    if (!audio || !nextSource) return;
    if (audio.src !== nextSource) audio.src = nextSource;
    try {
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch {
      setPlaying(false);
      setPlaybackError('Unable to play this voice message.');
    }
  }

  async function seek(progressValue: number) {
    if (nativePlayback && source) {
      const sample = await seekDesktopVoiceMessage(
        source,
        Math.round(voice.durationMs * progressValue),
      );
      playbackBaseMsRef.current = sample.currentMs;
      playbackStartedAtRef.current = playing ? performance.now() : null;
      setElapsedMs(sample.currentMs);
      return;
    }
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.duration * progressValue));
  }

  return (
    <div className="app-voice-message" data-voice-message="true">
      <audio
        ref={audioRef}
        preload="metadata"
        src={nativePlayback ? undefined : source ?? undefined}
        onPlay={() => {
          window.dispatchEvent(new CustomEvent(VOICE_PLAY_EVENT, { detail: playerKey }));
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onError={(event) => {
          if (nativePlayback) return;
          event.currentTarget.pause();
          setPlaying(false);
          setElapsedMs(0);
          setPlaybackError('Unable to play this voice message.');
        }}
        onEnded={(event) => {
          event.currentTarget.currentTime = 0;
          setPlaying(false);
          setElapsedMs(0);
        }}
        onTimeUpdate={(event) => setElapsedMs(event.currentTarget.currentTime * 1_000)}
      />
      <div className="app-voice-player-row">
        <button type="button" className="app-voice-play-button" onClick={() => void togglePlayback()} disabled={loading} aria-label={playing ? 'Pause voice message' : 'Play voice message'} title={playbackError ?? undefined}>
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
        </button>
        <div className="app-voice-main">
          <div className="app-voice-scrubber">
            <VoiceWaveform samples={voice.waveformSamples} progress={progress} />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={progress}
              onChange={(event) => void seek(Number(event.target.value))}
              aria-label="Voice message position"
              aria-valuetext={`${formatVoiceDuration(elapsedMs)} of ${formatVoiceDuration(voice.durationMs)}`}
            />
          </div>
          <div className="app-voice-metadata-row">
            <span className="app-voice-duration tabular-nums" data-error={playbackError ? 'true' : undefined}>
              {playbackError ? 'Unavailable' : formatVoiceDuration(playing ? elapsedMs : voice.durationMs)}
            </span>
            <div className="app-voice-meta-actions">
              {footer ? <div className="app-voice-inline-footer">{footer}</div> : null}
              <button
                type="button"
                className="app-voice-transcript-trigger"
                onClick={() => setShowsTranscript((value) => !value)}
                aria-label={showsTranscript ? 'Hide voice transcript' : 'Show voice transcript'}
                aria-expanded={showsTranscript}
                title={hasTranscript ? 'Transcript' : 'Transcript unavailable'}
              >
                <FileText className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
      {showsTranscript ? (
        <div className="app-voice-transcript" data-kordi-copy-surface="message">
          {hasTranscript ? (
            <>
              <div className="whitespace-pre-wrap break-words">{visibleTranscript}</div>
              {transcriptIsLong ? (
                <button type="button" className="app-voice-transcript-toggle" onClick={() => setShowsFullTranscript((value) => !value)} aria-expanded={showsFullTranscript}>
                  {showsFullTranscript ? 'Show less' : 'Show full transcript'}
                </button>
              ) : null}
            </>
          ) : <div className="app-voice-transcript-unavailable">Transcript unavailable for this recording.</div>}
        </div>
      ) : null}
    </div>
  );
}
