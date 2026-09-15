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

type Voice = { transcript: string; transcription?: VoiceTranscription; mediaId?: string | null };

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
