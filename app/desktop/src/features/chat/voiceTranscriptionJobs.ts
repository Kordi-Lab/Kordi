import { useSyncExternalStore } from 'react';

import { transcribeDesktopVoiceMessageResult } from '@/lib/desktopVoice';
import {
  MAX_TRANSCRIPTION_ATTEMPTS,
  VOICE_TRANSCRIPT_LIMIT,
  voiceTranscriptionFailureStatus,
  type VoiceTranscriptionOutcome,
} from './voiceTranscription';

/**
 * Background voice transcription for this device.
 *
 * Jobs live outside React so they survive bubble re-renders and transcript
 * virtualization. A job is identified by every key that names the same audio:
 * the local recording path before upload and the uploaded media id after it.
 * Finished outcomes double as this device's in-memory transcript cache, which
 * is how recipients (who may not persist a transcript) keep their result.
 */
export type VoiceTranscriptionJobSnapshot = {
  status: 'running' | 'ready' | 'failed' | 'unavailable';
  outcome: VoiceTranscriptionOutcome | null;
  /** Attempts started on this device for this audio. */
  attempts: number;
  /** A person asked for this job and has not closed its transcript since. */
  reveal: boolean;
};

type Job = VoiceTranscriptionJobSnapshot & { promise: Promise<VoiceTranscriptionOutcome> };

const MAX_FINISHED_JOBS = 256;
const jobs = new Map<string, Job>();
const aliases = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let nativeTail: Promise<unknown> = Promise.resolve();

function notify() {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function canonicalKey(key: string) {
  return aliases.get(key) ?? key;
}

function jobForKeys(keys: readonly string[]): [string, Job] | null {
  for (const key of keys) {
    const id = canonicalKey(key);
    const job = jobs.get(id);
    if (job) return [id, job];
  }
  return null;
}

function pruneFinishedJobs() {
  const finished = [...jobs.entries()].filter(([, job]) => job.status !== 'running' && !job.reveal);
  for (const [id] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    jobs.delete(id);
    for (const [alias, target] of aliases) if (target === id) aliases.delete(alias);
  }
}

/** Keys that identify one recording. Pending optimistic media ids are never stable identities. */
export function voiceTranscriptionKeys(voice: { mediaId?: string | null; localPath?: string | null }): string[] {
  const mediaId = voice.mediaId?.trim() ?? '';
  const localPath = voice.localPath?.trim() ?? '';
  return [
    ...(mediaId && !mediaId.startsWith('pending:') ? [`media:${mediaId}`] : []),
    ...(localPath ? [`path:${localPath}`] : []),
  ];
}

/** Records that several keys name the same audio, for example after an upload returns its media id. */
export function linkVoiceTranscriptionKeys(keys: readonly string[]) {
  const found = jobForKeys(keys);
  if (!found) return;
  let changed = false;
  for (const key of keys) {
    if (key === found[0] || aliases.get(key) === found[0]) continue;
    if (jobs.has(key)) continue;
    aliases.set(key, found[0]);
    changed = true;
  }
  if (changed) notify();
}

export function voiceTranscriptionJob(keys: readonly string[]): VoiceTranscriptionJobSnapshot | null {
  const found = jobForKeys(keys);
  if (!found) return null;
  const { status, outcome, attempts, reveal } = found[1];
  return { status, outcome, attempts, reveal };
}

async function runNativeTranscription(source: () => Promise<string>): Promise<VoiceTranscriptionOutcome> {
  try {
    const path = await source();
    // Speech recognition is serialized so parallel requests never compete for the native recognizer.
    const result = nativeTail.then(() => transcribeDesktopVoiceMessageResult(path));
    nativeTail = result.catch(() => undefined);
    const { transcript, language } = await result;
    if (transcript.length > VOICE_TRANSCRIPT_LIMIT) {
      throw new Error('The transcript exceeds the message limit.');
    }
    if (!transcript) throw new Error('No recognizable speech was found in this recording.');
    return { status: 'ready', transcript, language };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: voiceTranscriptionFailureStatus(error), error: message || 'Unable to transcribe this voice message.' };
  }
}

/**
 * Starts transcription once per recording. A running job is shared, and a
 * finished job is returned as-is unless `retry` asks for another attempt
 * after a failure within the attempt limit.
 */
export function startVoiceTranscription({
  keys,
  source,
  retry = false,
  reveal = false,
}: {
  keys: readonly string[];
  source: () => Promise<string>;
  retry?: boolean;
  reveal?: boolean;
}): Promise<VoiceTranscriptionOutcome> {
  const usableKeys = keys.filter(Boolean);
  if (usableKeys.length === 0) {
    return Promise.resolve({ status: 'failed', error: 'Voice message audio is unavailable.' });
  }
  const found = jobForKeys(usableKeys);
  if (found) {
    const [id, job] = found;
    linkVoiceTranscriptionKeys(usableKeys);
    const canRetry = retry && job.status !== 'running' && job.status !== 'ready'
      && job.attempts < MAX_TRANSCRIPTION_ATTEMPTS;
    if (!canRetry) {
      if (reveal && !job.reveal) {
        jobs.set(id, { ...job, reveal: true });
        notify();
      }
      return job.promise;
    }
  }
  const id = found?.[0] ?? usableKeys[0];
  const attempts = (found?.[1].attempts ?? 0) + 1;
  const promise = runNativeTranscription(source).then((outcome) => {
    const current = jobs.get(id);
    if (current?.promise === promise) {
      jobs.set(id, { ...current, status: outcome.status, outcome });
      pruneFinishedJobs();
      notify();
    }
    return outcome;
  });
  jobs.set(id, {
    status: 'running',
    outcome: null,
    attempts,
    reveal: reveal || Boolean(found?.[1].reveal),
    promise,
  });
  for (const key of usableKeys) if (key !== id && !jobs.has(key)) aliases.set(key, id);
  notify();
  return promise;
}

/** The person closed the transcript they asked for; re-mounted bubbles stay closed. */
export function hideVoiceTranscriptionReveal(keys: readonly string[]) {
  const found = jobForKeys(keys);
  if (!found || !found[1].reveal) return;
  jobs.set(found[0], { ...found[1], reveal: false });
  notify();
}

export function subscribeVoiceTranscriptionJobs(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function voiceTranscriptionJobsVersion() {
  return version;
}

/** Re-renders when any transcription job changes. Executors use it to re-check waiting requests. */
export function useVoiceTranscriptionJobsVersion() {
  return useSyncExternalStore(subscribeVoiceTranscriptionJobs, voiceTranscriptionJobsVersion, voiceTranscriptionJobsVersion);
}

export function useVoiceTranscriptionJob(keys: readonly string[]): VoiceTranscriptionJobSnapshot | null {
  useVoiceTranscriptionJobsVersion();
  return voiceTranscriptionJob(keys);
}

export function resetVoiceTranscriptionJobsForTests() {
  jobs.clear();
  aliases.clear();
  nativeTail = Promise.resolve();
  notify();
}
