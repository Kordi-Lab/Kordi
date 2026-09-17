import {
  voiceTranscriptionNotStarted,
  voiceWithTranscriptionOutcome,
} from '@/features/chat/voiceTranscription';
import {
  voiceTranscriptionJob,
  voiceTranscriptionKeys,
} from '@/features/chat/voiceTranscriptionJobs';

import type { CloudVoiceMessage } from './cloudAttachmentTypes';

/** How long an agent turn waits for the sender to store a transcript before it proceeds without one. */
export const VOICE_AGENT_TRANSCRIPT_WAIT_MS = 60_000;
const VOICE_AGENT_TRANSCRIPT_POLL_MS = 500;

type AgentVoice = Pick<CloudVoiceMessage, 'mediaId' | 'transcript' | 'transcription'> & Partial<CloudVoiceMessage>;

export type VoiceAgentGate<T extends AgentVoice> =
  | { status: 'ready'; voice: T | null }
  | { status: 'waiting'; retryAtMs: number };

/**
 * Decides whether an agent may read a voice message now.
 *
 * A message sent without transcription (`pending`, zero attempts) waits until
 * its transcript arrives through `message.updated`. When the sender is this
 * device, its finished background job is used directly. After the bounded
 * wait the turn proceeds with the pending-transcription text.
 */
export function voiceForAgentExecution<T extends AgentVoice>({
  voice,
  createdAt,
  waitingSinceMs,
  nowMs = Date.now(),
}: {
  voice: T | null | undefined;
  createdAt?: string | null;
  /** When this executor first saw the request; bounds the wait when clocks disagree. */
  waitingSinceMs: number;
  nowMs?: number;
}): VoiceAgentGate<T> {
  if (!voice || !voiceTranscriptionNotStarted(voice)) return { status: 'ready', voice: voice ?? null };
  const localJob = voiceTranscriptionJob(voiceTranscriptionKeys(voice));
  if (localJob?.outcome) {
    return { status: 'ready', voice: voiceWithTranscriptionOutcome(voice, localJob.outcome, voice.mediaId) };
  }
  const createdAtMs = Date.parse(createdAt ?? '');
  const startedAtMs = Number.isFinite(createdAtMs) ? Math.min(createdAtMs, waitingSinceMs) : waitingSinceMs;
  const retryAtMs = startedAtMs + VOICE_AGENT_TRANSCRIPT_WAIT_MS;
  return nowMs >= retryAtMs ? { status: 'ready', voice } : { status: 'waiting', retryAtMs };
}

/** Remembers when each request was first seen so repeated effect passes share one deadline. */
export function voiceAgentWaitingSince(firstSeenById: Map<string, number>, requestId: string, nowMs = Date.now()) {
  const existing = firstSeenById.get(requestId);
  if (existing !== undefined) return existing;
  firstSeenById.set(requestId, nowMs);
  return nowMs;
}

/** For executors that already own a request: poll the latest message until the gate opens. */
export async function waitForVoiceTranscriptForAgent<T extends AgentVoice>({
  latestVoice,
  createdAt,
  signal,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  latestVoice: () => T | null | undefined;
  createdAt?: string | null;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<T | null> {
  const waitingSinceMs = now();
  for (;;) {
    const gate = voiceForAgentExecution({ voice: latestVoice(), createdAt, waitingSinceMs, nowMs: now() });
    if (gate.status === 'ready' || signal?.aborted) return gate.status === 'ready' ? gate.voice : latestVoice() ?? null;
    await sleep(Math.max(1, Math.min(VOICE_AGENT_TRANSCRIPT_POLL_MS, gate.retryAtMs - now())));
  }
}
