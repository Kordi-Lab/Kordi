export { VoiceRecordingRail } from './voiceRecordingRail';
import { formatVoiceDuration, localVoiceSource } from './voiceAudioSource';
import { VoiceWaveform } from './voiceWaveform';
import {
  useVoiceTranscriptState,
  voiceTranscriptPersistTarget,
  voiceTranscriptTriggerLabel,
  type VoiceTranscriptOwnMessage,
} from './voiceTranscriptAction';
import { FileText, LoaderCircle, Pause, Play } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { downloadCloudAttachmentToLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import type { MessageVoice } from '@/kordi-app/types/message';
import { isNativeDesktopShell, readDesktopChatAttachment } from '@/lib/desktop';
import { pauseDesktopVoiceMessage, playDesktopVoiceMessage, seekDesktopVoiceMessage, stopDesktopVoiceMessage } from '@/lib/desktopVoice';

const VOICE_PLAY_EVENT = 'kordi:voice-message-play';
const MIN_PLAYABLE_VOICE_BYTES = 1_024;

type RetainedVoiceSources = Map<string, 'object-url' | 'native'>;

function releaseVoiceSource(sources: RetainedVoiceSources, source: string | null) {
  if (!source) return;
  const kind = sources.get(source);
  if (!kind) return;
  sources.delete(source);
  if (kind === 'object-url') URL.revokeObjectURL(source);
  else void stopDesktopVoiceMessage(source);
}

export function VoiceMessageContent({ voice, footer, ownMessage }: {
  /** Present only for the sender's own message; recipients transcribe for this device. */
  ownMessage?: VoiceTranscriptOwnMessage;
  voice: MessageVoice;
  footer?: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountedRef = useRef(false);
  const retainedSourcesRef = useRef<RetainedVoiceSources>(new Map());
  const playbackBaseMsRef = useRef(0);
  const playbackStartedAtRef = useRef<number | null>(null);
  const playerKey = useId();
  const nativePlayback = isNativeDesktopShell();
  const [source, setSource] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [transcriptOpened, setTranscriptOpened] = useState(false);
  const [showsFullTranscript, setShowsFullTranscript] = useState(false);
  const transcription = useVoiceTranscriptState({
    voice,
    persistTarget: voiceTranscriptPersistTarget(ownMessage),
    canTranscribeOnDevice: nativePlayback,
  });
  const transcript = transcription.transcript;
  const hasTranscript = Boolean(transcript);
  const progress = voice.durationMs > 0 ? Math.min(1, elapsedMs / voice.durationMs) : 0;
  const transcriptIsLong = transcript.length > 320 || transcript.split('\n').length > 5;
  const visibleTranscript = useMemo(() => (
    transcriptIsLong && !showsFullTranscript ? `${transcript.slice(0, 300).trimEnd()}…` : transcript
  ), [showsFullTranscript, transcriptIsLong, transcript]);
  const transcriptStatus = transcription.status;
  // A requested transcription stays open even if this row was re-rendered or virtualized meanwhile.
  const showsTranscript = transcriptOpened || transcription.reveal;
  const triggerLabel = voiceTranscriptTriggerLabel(transcriptStatus, showsTranscript);

  function handleTranscriptTrigger() {
    if (showsTranscript) {
      transcription.hideReveal();
      setTranscriptOpened(false);
      return;
    }
    // Without a transcript, the transcript icon is the transcribe action.
    if (transcriptStatus === 'idle') transcription.transcribe();
    setTranscriptOpened(true);
  }

  useEffect(() => {
    mountedRef.current = true;
    const audio = audioRef.current;
    const retainedSources = retainedSourcesRef.current;
    return () => {
      mountedRef.current = false;
      for (const retainedSource of retainedSources.keys()) releaseVoiceSource(retainedSources, retainedSource);
      if (!nativePlayback && audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    };
  }, [nativePlayback]);

  useEffect(() => {
    const retainedSources = retainedSourcesRef.current;
    return () => releaseVoiceSource(retainedSources, source);
  }, [source]);

  function retainSource(nextSource: string, objectUrl = false) {
    // A delete event or virtualization can remove the row while audio loads.
    if (!mountedRef.current) {
      if (objectUrl) URL.revokeObjectURL(nextSource);
      return null;
    }
    retainedSourcesRef.current.set(nextSource, objectUrl ? 'object-url' : 'native');
    setSource(nextSource);
    return nextSource;
  }

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
      if (force) releaseVoiceSource(retainedSourcesRef.current, source);
      if (voice.localPath) {
        try {
          if (nativePlayback) {
            const bytes = await readDesktopChatAttachment(voice.localPath);
            if (bytes.length < MIN_PLAYABLE_VOICE_BYTES) {
              throw new Error('Voice message audio is unavailable.');
            }
            return retainSource(voice.localPath);
          }
          const localSource = await localVoiceSource(voice.localPath);
          if (localSource) {
            return retainSource(localSource, true);
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
        return retainSource(path);
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
      return retainSource(objectUrl, true);
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
        if (!mountedRef.current) return;
        if (!path) {
          playbackBaseMsRef.current = 0;
          playbackStartedAtRef.current = null;
          setPlaying(false);
          return;
        }
        const sample = await playDesktopVoiceMessage(path);
        if (!mountedRef.current) {
          void stopDesktopVoiceMessage(path);
          return;
        }
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
    if (!mountedRef.current || !audio || !nextSource) return;
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
              <button
                type="button"
                className="app-voice-transcript-trigger"
                onClick={handleTranscriptTrigger}
                aria-label={triggerLabel}
                aria-expanded={showsTranscript}
                title={triggerLabel}
              >
                <FileText className="h-3 w-3" aria-hidden="true" />
              </button>
              {footer ? <div className="app-voice-inline-footer">{footer}</div> : null}
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
          ) : transcriptStatus === 'running' || transcriptStatus === 'idle' ? (
            <div className="app-voice-transcript-status" role="status">
              <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>Transcribing…</span>
            </div>
          ) : (
            <div className="app-voice-transcript-unavailable" role="status">
              <span>{transcription.note}</span>
              {transcription.canRetry ? (
                <button type="button" className="app-voice-transcript-toggle" onClick={transcription.transcribe}>
                  Try again
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
