import {
  MAX_TRANSCRIPTION_ATTEMPTS,
  pendingVoiceTranscription,
  voiceTranscript,
  voiceWithTranscriptionOutcome,
  type VoiceTranscriptionOutcome,
} from '@/features/chat/voiceTranscription';

import { useSyncExternalStore } from 'react';

import { defaultCloudAuthClient, type CloudAuthClient, type CloudMessage } from './authClient';
import { CloudAuthError } from './cloudAuthError';
import { cloudVoiceMessageMetadataOnly } from './cloudVoiceMessage';
import { loadSession } from './session';

export type VoiceTranscriptClient = {
  chat: Pick<CloudAuthClient['chat'], 'updateVoiceTranscript' | 'threadPage' | 'listHistoryPage'>;
};

/** The server message a sender may update. Recipients never persist a transcript. */
export type CloudVoiceTranscriptTarget = {
  conversationId: string;
  messageId: string;
  version: number;
  mediaId: string;
  /** Attempts already stored on the server. */
  attempts: number;
};

let sharedClient: CloudAuthClient | null = null;
let clientOverride: VoiceTranscriptClient | null = null;
const inFlight = new Map<string, Promise<CloudMessage | null>>();

/**
 * Messages whose sender-side transcript write has finished (stored or failed).
 * Server-built agent prompts read the stored message, so fallback claims wait for this.
 */
const MAX_SETTLED_MESSAGES = 512;
const settledMessageIds = new Set<string>();
const settledListeners = new Set<() => void>();
let settledVersion = 0;

export function markCloudVoiceTranscriptSettled(messageId: string | null | undefined) {
  const id = messageId?.trim();
  if (!id || settledMessageIds.has(id)) return;
  settledMessageIds.add(id);
  for (const oldest of settledMessageIds) {
    if (settledMessageIds.size <= MAX_SETTLED_MESSAGES) break;
    settledMessageIds.delete(oldest);
  }
  settledVersion += 1;
  for (const listener of [...settledListeners]) listener();
}

export function cloudVoiceTranscriptSettled(messageId: string) {
  return settledMessageIds.has(messageId);
}

function subscribeSettled(listener: () => void) {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

const settledSnapshot = () => settledVersion;

/** Re-renders when a sender-side transcript write finishes. */
export function useCloudVoiceTranscriptSettledVersion() {
  return useSyncExternalStore(subscribeSettled, settledSnapshot, settledSnapshot);
}

function voiceTranscriptClient(): VoiceTranscriptClient {
  if (clientOverride) return clientOverride;
  sharedClient ??= defaultCloudAuthClient();
  return sharedClient;
}

export function setCloudVoiceTranscriptClientForTests(client: VoiceTranscriptClient | null) {
  clientOverride = client;
  inFlight.clear();
  settledMessageIds.clear();
}

export function cloudVoiceTranscriptTarget(message: Pick<CloudMessage, 'conversationId' | 'messageId' | 'version' | 'voiceMessage'>): CloudVoiceTranscriptTarget | null {
  const conversationId = message.conversationId?.trim() ?? '';
  const messageId = message.messageId?.trim() ?? '';
  const mediaId = message.voiceMessage?.mediaId?.trim() ?? '';
  const version = Number(message.version);
  if (!conversationId || !messageId || !mediaId || !Number.isInteger(version) || version < 1) return null;
  return {
    conversationId,
    messageId,
    version,
    mediaId,
    attempts: message.voiceMessage?.transcription?.attempts ?? 0,
  };
}

async function latestMessage(client: VoiceTranscriptClient, token: string, target: CloudVoiceTranscriptTarget) {
  const page = await client.chat.threadPage(token, target.conversationId, target.messageId).catch(() => null);
  const fromThread = page && [page.root, ...page.messages].find((message) => message.messageId === target.messageId);
  if (fromThread) {
    return { version: fromThread.version ?? null, voice: fromThread.voiceMessage ?? null };
  }
  const history = await client.chat.listHistoryPage(token, target.conversationId, undefined, 100);
  const row = history.messages.find((message) => message.id === target.messageId);
  if (!row) return null;
  const blocks = (row.content as { blocks?: unknown[] } | null)?.blocks ?? [];
  const block = blocks.find((value) => (value as { type?: unknown } | null)?.type === 'voice');
  return { version: row.version, voice: cloudVoiceMessageMetadataOnly(block) };
}

function update(client: VoiceTranscriptClient, token: string, target: CloudVoiceTranscriptTarget, outcome: VoiceTranscriptionOutcome) {
  const voice = voiceWithTranscriptionOutcome({
    transcript: '',
    mediaId: target.mediaId,
    transcription: { ...pendingVoiceTranscription(target.mediaId), attempts: target.attempts },
  }, outcome, target.mediaId);
  return client.chat.updateVoiceTranscript(
    token,
    target.conversationId,
    target.messageId,
    target.version,
    target.mediaId,
    voice.transcript,
    voice.transcription,
  );
}

/**
 * Stores one attempt on the sender's message so every member receives it
 * through `message.updated`. A version conflict refreshes the message and
 * retries once; a transcript that already exists wins.
 */
export function persistCloudVoiceTranscript(
  target: CloudVoiceTranscriptTarget,
  outcome: VoiceTranscriptionOutcome,
  {
    client = voiceTranscriptClient(),
    session = loadSession,
  }: {
    client?: VoiceTranscriptClient;
    session?: () => Promise<{ token: string } | null>;
  } = {},
): Promise<CloudMessage | null> {
  const key = `${target.conversationId}\u0000${target.messageId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    if (target.attempts >= MAX_TRANSCRIPTION_ATTEMPTS) return null;
    const token = (await session())?.token;
    if (!token) throw new Error('Sign in to save this transcript.');
    try {
      return await update(client, token, target, outcome);
    } catch (error) {
      if (!(error instanceof CloudAuthError) || error.status !== 409) throw error;
      const latest = await latestMessage(client, token, target);
      const version = Number(latest?.version);
      if (!latest?.voice || latest.voice.mediaId !== target.mediaId || !Number.isInteger(version) || version < 1) {
        throw error;
      }
      const attempts = latest.voice.transcription?.attempts ?? 0;
      if (voiceTranscript(latest.voice) || attempts >= MAX_TRANSCRIPTION_ATTEMPTS) return null;
      return update(client, token, { ...target, version, attempts }, outcome);
    }
  })().finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
    markCloudVoiceTranscriptSettled(target.messageId);
  });
  inFlight.set(key, run);
  return run;
}
