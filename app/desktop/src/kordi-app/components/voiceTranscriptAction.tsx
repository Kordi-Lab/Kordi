import { useMemo } from 'react';

import {
  MAX_TRANSCRIPTION_ATTEMPTS,
  voiceTranscript,
  voiceTranscriptionFailureNote,
} from '@/features/chat/voiceTranscription';
import {
  hideVoiceTranscriptionReveal,
  useVoiceTranscriptionJob,
  voiceTranscriptionKeys,
} from '@/features/chat/voiceTranscriptionJobs';
import { transcribeVoiceMessageOnDemand } from '@/features/cloud/cloudVoiceTranscription';
import type { MessageVoice } from '@/kordi-app/types/message';

/** The sender's server message. Only the sender may store a transcript for everyone. */
export type VoiceTranscriptPersistTarget = { conversationId: string; messageId: string; version: number };

export type VoiceTranscriptStatus = 'ready' | 'running' | 'failed' | 'idle' | 'unavailable';

/**
 * Transcript state for one voice bubble. Jobs live outside the component, so
 * a running or finished job is found again after re-rendering or
 * virtualization, and a second click never starts a duplicate job.
 */
export function useVoiceTranscriptState({
  voice,
  persistTarget,
  canTranscribeOnDevice,
}: {
  voice: MessageVoice;
  persistTarget?: VoiceTranscriptPersistTarget;
  canTranscribeOnDevice: boolean;
}) {
  const { mediaId, localPath } = voice;
  const keys = useMemo(() => voiceTranscriptionKeys({ mediaId, localPath }), [mediaId, localPath]);
  const job = useVoiceTranscriptionJob(keys);
  const transcript = voiceTranscript(voice)
    || (job?.outcome?.status === 'ready' ? job.outcome.transcript : '');
  const running = !transcript && job?.status === 'running';
  const failure = !transcript && !running && job?.outcome && job.outcome.status !== 'ready'
    ? job.outcome.error
    : null;
  // The sender's attempts are stored on the message; a recipient counts attempts on this device.
  const attempts = persistTarget
    ? Math.max(voice.transcription?.attempts ?? 0, job?.attempts ?? 0)
    : job?.attempts ?? 0;
  const canTranscribe = canTranscribeOnDevice && keys.length > 0 && attempts < MAX_TRANSCRIPTION_ATTEMPTS;
  const status: VoiceTranscriptStatus = transcript ? 'ready'
    : running ? 'running'
    : failure !== null ? 'failed'
    : canTranscribe ? 'idle'
    : 'unavailable';
  const note = status === 'failed' ? voiceTranscriptionFailureNote(failure ?? '')
    : status === 'unavailable'
      ? !canTranscribeOnDevice || keys.length === 0
        ? 'Transcription isn’t available on this device.'
        : 'Transcript unavailable. The retry limit was reached.'
      : null;
  return {
    transcript,
    status,
    note,
    canRetry: status === 'failed' && canTranscribe,
    /** A person asked for this transcript; every bubble for the recording stays open until they hide it. */
    reveal: Boolean(job?.reveal),
    hideReveal: () => hideVoiceTranscriptionReveal(keys),
    transcribe: () => {
      void transcribeVoiceMessageOnDemand({
        voice,
        persistTarget,
        retry: status === 'failed',
      }).catch(() => undefined);
    },
  };
}

export function voiceTranscriptTriggerLabel(status: VoiceTranscriptStatus, expanded: boolean) {
  if (status === 'running') return 'Transcribing…';
  if (status === 'idle') return 'Transcribe';
  if (expanded) return 'Hide transcript';
  if (status === 'ready') return 'Show transcript';
  return status === 'failed' ? 'Transcription failed' : 'Transcript unavailable';
}
