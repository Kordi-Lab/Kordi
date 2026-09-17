/** Portable transcription state. Source versions identify immutable audio, never a path. */
export type VoiceTranscription = {
  status: 'pending' | 'ready' | 'failed' | 'unavailable';
  sourceVersion: string;
  engine: 'apple-speech-v1' | 'legacy';
  language?: string;
  attempts: number;
};

export const MAX_TRANSCRIPTION_ATTEMPTS = 3;
export const VOICE_TRANSCRIPT_LIMIT = 20_000;
/** Message body for a voice message without a transcript: previews, notifications and search read it. */
export const VOICE_MESSAGE_BODY_TEXT = 'Voice message';

/** The result of one native transcription attempt, independent of where it is stored. */
export type VoiceTranscriptionOutcome =
  | { status: 'ready'; transcript: string; language: string }
  | { status: 'failed' | 'unavailable'; error: string };

type Voice = { transcript: string; transcription?: VoiceTranscription; mediaId?: string | null };

export function pendingVoiceTranscription(sourceVersion: string): VoiceTranscription {
  return { status: 'pending', sourceVersion, engine: 'apple-speech-v1', attempts: 0 };
}

/** A voice message that was sent without transcription and has not been attempted yet. */
export function voiceTranscriptionNotStarted(voice: Voice): boolean {
  return !voiceTranscript(voice)
    && voice.transcription?.status === 'pending'
    && voice.transcription.attempts === 0;
}

/** Applies one attempt to voice metadata. The attempt count only grows and stays within the server limit. */
export function voiceWithTranscriptionOutcome<T extends Voice>(
  voice: T,
  outcome: VoiceTranscriptionOutcome,
  sourceVersion = voice.transcription?.sourceVersion ?? voice.mediaId ?? '',
): T {
  const transcription: VoiceTranscription = {
    status: outcome.status,
    sourceVersion,
    engine: 'apple-speech-v1',
    attempts: Math.min(MAX_TRANSCRIPTION_ATTEMPTS, (voice.transcription?.attempts ?? 0) + 1),
    ...(outcome.status === 'ready' ? { language: outcome.language } : {}),
  };
  return { ...voice, transcript: outcome.status === 'ready' ? outcome.transcript : '', transcription };
}

export function voiceTranscript(voice: Voice): string {
  const text = voice.transcript.trim();
  const state = voice.transcription;
  if (state && (state.status !== 'ready'
    || (voice.mediaId && !voice.mediaId.startsWith('pending:') && state.sourceVersion !== voice.mediaId))) return '';
  return text === 'Transcription unavailable.' ? '' : text;
}

export function voiceTranscriptionStatus(voice: Voice): VoiceTranscription['status'] {
  if (voiceTranscript(voice)) return 'ready';
  return voice.transcription?.status === 'ready' ? 'unavailable'
    : voice.transcription?.status ?? 'unavailable';
}

export function voiceTranscriptionLabel(voice: Voice): string {
  switch (voiceTranscriptionStatus(voice)) {
    case 'pending': return 'Transcription pending.';
    case 'failed': return 'Transcription failed.';
    case 'unavailable': return 'Transcript unavailable for this recording.';
    case 'ready': return 'Transcript ready.';
  }
}

export function voiceAgentText(voice: Voice): string {
  const text = voiceTranscript(voice);
  return text
    ? `[Voice transcript; audio was not provided. Tone, speaker identity, and background sounds are unknown.]\n${text}`
    : `[Voice message: ${voiceTranscriptionLabel(voice)} No spoken content or audio was provided to the agent.]`;
}

export function parseVoiceTranscription(value: unknown): VoiceTranscription | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Record<string, unknown>;
  if (!['pending', 'ready', 'failed', 'unavailable'].includes(String(state.status))
    || typeof state.sourceVersion !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(state.sourceVersion)
    || !['apple-speech-v1', 'legacy'].includes(String(state.engine))
    || !Number.isInteger(state.attempts) || Number(state.attempts) < 0
    || Number(state.attempts) > MAX_TRANSCRIPTION_ATTEMPTS) return undefined;
  return {
    status: state.status as VoiceTranscription['status'],
    sourceVersion: state.sourceVersion,
    engine: state.engine as VoiceTranscription['engine'],
    attempts: Number(state.attempts),
    ...(typeof state.language === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(state.language)
      ? { language: state.language } : {}),
  };
}

export function voiceTranscriptionFailureStatus(error: unknown): 'failed' | 'unavailable' {
  const message = error instanceof Error ? error.message : String(error);
  return /Allow Kordi|unavailable|does not support|only on macOS/i.test(message) ? 'unavailable' : 'failed';
}

/** A short, user-facing note for a failed attempt. */
export function voiceTranscriptionFailureNote(error: string): string {
  if (/Allow Kordi.*Speech Recognition/i.test(error)) return 'Allow Speech Recognition in System Settings.';
  if (/No (?:recognizable )?speech/i.test(error)) return 'No speech detected.';
  if (/exceeds the message limit/i.test(error)) return 'This recording is too long to transcribe.';
  if (/Sign in/i.test(error)) return 'Sign in to transcribe this message.';
  return 'Could not transcribe this recording.';
}
