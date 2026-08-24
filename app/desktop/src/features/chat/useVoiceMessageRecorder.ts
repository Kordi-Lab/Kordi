import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cancelDesktopVoiceRecording,
  sampleDesktopVoiceRecording,
  startDesktopVoiceRecording,
  stopDesktopVoiceRecording,
  transcribeDesktopVoiceMessage,
  trimDesktopVoiceMessage,
} from '@/lib/desktop';
import type { AttachmentItem } from './composerController.types';

export const MAX_VOICE_MESSAGE_DURATION_MS = 60_000;
export const VOICE_CANCEL_SWIPE_PX = 64;
export type VoiceGestureIntent = 'hold' | 'cancel';
type VoiceStopOptions = {
  directSend?: boolean;
  onAttachmentReady?: (attachment: AttachmentItem) => void;
};
type RecorderPhase = 'idle' | 'recording' | 'sending' | 'review' | 'error';
type TranscriptionPhase = 'idle' | 'transcribing' | 'ready' | 'error';

export type VoiceMessageRecorderState = {
  phase: RecorderPhase;
  transcriptionPhase: TranscriptionPhase;
  locked: boolean;
  durationMs: number;
  waveformSamples: number[];
  transcript: string;
  attachment: AttachmentItem | null;
  trimStartMs: number;
  trimEndMs: number;
  error: string | null;
};

const IDLE_STATE: VoiceMessageRecorderState = {
  phase: 'idle',
  transcriptionPhase: 'idle',
  locked: false,
  durationMs: 0,
  waveformSamples: [],
  transcript: '',
  attachment: null,
  trimStartMs: 0,
  trimEndMs: 0,
  error: null,
};

export function voiceGestureIntent(verticalOffset: number): VoiceGestureIntent {
  return verticalOffset <= -VOICE_CANCEL_SWIPE_PX ? 'cancel' : 'hold';
}

export function downsampleVoiceWaveform(samples: readonly number[], count = 48) {
  if (samples.length === 0) return Array.from({ length: count }, () => 0.08);
  const outputCount = Math.min(count, samples.length);
  return Array.from({ length: outputCount }, (_, index) => {
    const start = Math.floor((index * samples.length) / outputCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * samples.length) / outputCount));
    return Math.max(0.08, ...samples.slice(start, end));
  });
}

export function displayVoiceWaveform(samples: readonly number[], count = 36) {
  if (count <= 0) return [];
  if (samples.length === 0) return Array.from({ length: count }, () => 0.08);
  if (samples.length >= count) return downsampleVoiceWaveform(samples, count);
  if (samples.length === 1 || count === 1) {
    return Array.from({ length: count }, () => Math.max(0.08, Math.min(1, samples[0] ?? 0.08)));
  }
  return Array.from({ length: count }, (_, index) => {
    const position = (index * (samples.length - 1)) / (count - 1);
    const lower = Math.floor(position);
    const upper = Math.min(samples.length - 1, lower + 1);
    const fraction = position - lower;
    const value = (samples[lower] ?? 0.08) * (1 - fraction)
      + (samples[upper] ?? 0.08) * fraction;
    return Math.round(Math.max(0.08, Math.min(1, value)) * 10_000) / 10_000;
  });
}

export function trimVoiceWaveform(
  samples: readonly number[],
  durationMs: number,
  startMs: number,
  endMs: number,
) {
  if (samples.length === 0 || durationMs <= 0) return downsampleVoiceWaveform([]);
  const start = Math.floor((Math.max(0, startMs) / durationMs) * samples.length);
  const end = Math.max(start + 1, Math.ceil((Math.min(durationMs, endMs) / durationMs) * samples.length));
  return downsampleVoiceWaveform(samples.slice(start, end));
}

function voiceAttachment({
  path,
  sizeBytes,
  durationMs,
  waveformSamples,
  transcript,
}: {
  path: string;
  sizeBytes: number;
  durationMs: number;
  waveformSamples: number[];
  transcript: string;
}): AttachmentItem {
  return {
    id: `voice:${path}`,
    name: 'Voice message.m4a',
    path,
    localPath: path,
    kind: 'file',
    mimeType: 'audio/mp4',
    formatLabel: 'M4A',
    sizeBytes,
    voiceMessage: {
      mimeType: 'audio/mp4',
      durationMs,
      waveformSamples,
      transcript,
      localPath: path,
    },
  };
}

export function useVoiceMessageRecorder() {
  const [state, setState] = useState<VoiceMessageRecorderState>(IDLE_STATE);
  const stateRef = useRef(state);
  const timerRef = useRef<number | null>(null);
  const samplesRef = useRef<number[]>([]);
  const activeRef = useRef(false);
  const samplingRef = useRef(false);
  const generationRef = useRef(0);
  const stopRef = useRef<(options?: VoiceStopOptions) => Promise<AttachmentItem | null>>(
    () => Promise.resolve(null),
  );
  const preparationPromiseRef = useRef<Promise<AttachmentItem | null> | null>(null);

  const commit = useCallback((
    next: VoiceMessageRecorderState
      | ((current: VoiceMessageRecorderState) => VoiceMessageRecorderState),
  ) => {
    const value = typeof next === 'function' ? next(stateRef.current) : next;
    stateRef.current = value;
    setState(value);
  }, []);

  const stopSampling = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    samplingRef.current = false;
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    activeRef.current = false;
    stopSampling();
    samplesRef.current = [];
    preparationPromiseRef.current = null;
    void cancelDesktopVoiceRecording();
    commit(IDLE_STATE);
  }, [commit, stopSampling]);

  const transcribeAttachment = useCallback(async (
    attachment: AttachmentItem,
    expectedGeneration = generationRef.current,
  ) => {
    const path = attachment.localPath ?? attachment.path;
    if (!path || !attachment.voiceMessage || expectedGeneration !== generationRef.current) {
      return null;
    }
    commit((current) => ({
      ...current,
      phase: current.phase === 'sending' ? 'sending' : 'review',
      transcriptionPhase: 'transcribing',
      attachment,
      error: null,
    }));
    try {
      const transcript = (await transcribeDesktopVoiceMessage(path)).trim();
      if (expectedGeneration !== generationRef.current) return null;
      if (!transcript) throw new Error('No recognizable speech was found in this recording.');
      const prepared = {
        ...attachment,
        voiceMessage: { ...attachment.voiceMessage, transcript },
      };
      commit((current) => ({
        ...current,
        transcriptionPhase: 'ready',
        transcript,
        attachment: prepared,
        error: null,
      }));
      return prepared;
    } catch (error) {
      if (expectedGeneration !== generationRef.current) return null;
      if (stateRef.current.phase === 'sending' && attachment.voiceMessage) {
        const prepared = {
          ...attachment,
          voiceMessage: {
            ...attachment.voiceMessage,
            transcript: 'Transcription unavailable.',
          },
        };
        commit((current) => ({
          ...current,
          transcriptionPhase: 'error',
          transcript: prepared.voiceMessage.transcript,
          attachment: prepared,
          error: null,
        }));
        return prepared;
      }
      commit((current) => ({
        ...current,
        phase: 'review',
        transcriptionPhase: 'error',
        attachment,
        error: error instanceof Error ? error.message : 'Unable to transcribe this voice message.',
      }));
      return null;
    }
  }, [commit]);

  const start = useCallback(async ({ locked = true }: { locked?: boolean } = {}) => {
    if (!['idle', 'error'].includes(stateRef.current.phase) || activeRef.current) return false;
    generationRef.current += 1;
    const generation = generationRef.current;
    stopSampling();
    await cancelDesktopVoiceRecording().catch(() => {});
    commit(IDLE_STATE);
    try {
      await startDesktopVoiceRecording();
      if (generation !== generationRef.current) {
        await cancelDesktopVoiceRecording().catch(() => {});
        return false;
      }
      activeRef.current = true;
      samplesRef.current = [];
      commit({ ...IDLE_STATE, phase: 'recording', locked });
      timerRef.current = window.setInterval(() => {
        if (!activeRef.current || samplingRef.current) return;
        samplingRef.current = true;
        void sampleDesktopVoiceRecording().then((sample) => {
          if (!activeRef.current || generation !== generationRef.current) return;
          samplesRef.current.push(sample.level);
          commit((current) => ({
            ...current,
            durationMs: Math.min(MAX_VOICE_MESSAGE_DURATION_MS, sample.durationMs),
            waveformSamples: downsampleVoiceWaveform(samplesRef.current.slice(-48)),
          }));
          if (sample.durationMs >= MAX_VOICE_MESSAGE_DURATION_MS) {
            void stopRef.current({ directSend: true });
          }
        }).catch(() => {}).finally(() => {
          samplingRef.current = false;
        });
      }, 100);
      return true;
    } catch (error) {
      activeRef.current = false;
      stopSampling();
      commit({
        ...IDLE_STATE,
        phase: 'error',
        error: error instanceof Error
          ? error.message
          : 'Allow Kordi to use the microphone and try again.',
      });
      return false;
    }
  }, [commit, stopSampling]);

  const stop = useCallback(async (
    { directSend = false, onAttachmentReady }: VoiceStopOptions = {},
  ) => {
    if (stateRef.current.phase !== 'recording' || !activeRef.current) {
      return stateRef.current.attachment;
    }
    activeRef.current = false;
    stopSampling();
    const stopGeneration = generationRef.current;
    commit((current) => ({
      ...current,
      phase: directSend ? 'sending' : 'review',
      transcriptionPhase: 'transcribing',
    }));
    try {
      const stopped = await stopDesktopVoiceRecording();
      if (stopGeneration !== generationRef.current) return null;
      const durationMs = Math.min(
        MAX_VOICE_MESSAGE_DURATION_MS,
        Math.max(1, Math.round(stopped.durationMs)),
      );
      const waveformSamples = downsampleVoiceWaveform(samplesRef.current);
      const attachment = voiceAttachment({
        path: stopped.path,
        sizeBytes: stopped.sizeBytes,
        durationMs,
        waveformSamples,
        transcript: '',
      });
      commit((current) => ({
        ...current,
        durationMs,
        trimStartMs: 0,
        trimEndMs: durationMs,
        waveformSamples,
        attachment,
      }));
      onAttachmentReady?.(attachment);
      const preparation = transcribeAttachment(attachment, stopGeneration);
      preparationPromiseRef.current = preparation;
      const prepared = await preparation;
      if (preparationPromiseRef.current === preparation) {
        preparationPromiseRef.current = null;
      }
      return prepared;
    } catch (error) {
      if (stopGeneration !== generationRef.current) return null;
      commit({
        ...IDLE_STATE,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Unable to save this voice message.',
      });
      return null;
    }
  }, [commit, stopSampling, transcribeAttachment]);

  stopRef.current = stop;

  const setTrimRange = useCallback((startMs: number, endMs: number) => {
    const durationMs = stateRef.current.durationMs;
    const start = Math.max(0, Math.min(durationMs - 250, Math.round(startMs)));
    const end = Math.max(start + 250, Math.min(durationMs, Math.round(endMs)));
    commit((current) => ({ ...current, trimStartMs: start, trimEndMs: end }));
  }, [commit]);

  const discardReview = useCallback(() => commit(IDLE_STATE), [commit]);

  const prepareForSend = useCallback(async () => {
    if (preparationPromiseRef.current) await preparationPromiseRef.current;
    const current = stateRef.current;
    const attachment = current.attachment;
    if (!attachment?.voiceMessage) return null;
    const trimmed = current.trimStartMs > 50 || current.trimEndMs < current.durationMs - 50;
    if (!trimmed) {
      return attachment.voiceMessage.transcript
        ? attachment
        : await transcribeAttachment(attachment);
    }
    const sourcePath = attachment.localPath ?? attachment.path;
    if (!sourcePath) return null;
    const preparationGeneration = generationRef.current;
    try {
      const path = await trimDesktopVoiceMessage(
        sourcePath,
        current.trimStartMs,
        current.trimEndMs,
      );
      if (preparationGeneration !== generationRef.current) return null;
      const durationMs = current.trimEndMs - current.trimStartMs;
      const waveformSamples = trimVoiceWaveform(
        current.waveformSamples,
        current.durationMs,
        current.trimStartMs,
        current.trimEndMs,
      );
      return await transcribeAttachment(voiceAttachment({
        path,
        sizeBytes: attachment.sizeBytes ?? 0,
        durationMs,
        waveformSamples,
        transcript: '',
      }), preparationGeneration);
    } catch (error) {
      if (preparationGeneration !== generationRef.current) return null;
      commit((value) => ({
        ...value,
        transcriptionPhase: 'error',
        error: error instanceof Error ? error.message : 'Unable to trim this voice message.',
      }));
      return null;
    }
  }, [commit, transcribeAttachment]);

  useEffect(() => () => {
    activeRef.current = false;
    stopSampling();
    void cancelDesktopVoiceRecording();
  }, [stopSampling]);

  return {
    state,
    start,
    stop,
    reset,
    discardReview,
    setTrimRange,
    prepareForSend,
  };
}
