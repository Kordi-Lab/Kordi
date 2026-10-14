import type { CloudMessage } from '@/features/cloud/authClient';
import {
  cloudVoiceTranscriptTarget,
  markCloudVoiceTranscriptSettled,
  persistCloudVoiceTranscript,
} from '@/features/cloud/cloudVoiceTranscriptPersistence';
import { VOICE_AGENT_TRANSCRIPT_WAIT_MS } from '@/features/cloud/cloudVoiceAgentGate';

import type { AttachmentItem } from '../composerController.types';
import {
  MAX_TRANSCRIPTION_ATTEMPTS,
  voiceTranscript,
  voiceWithTranscriptionOutcome,
  type VoiceTranscriptionOutcome,
} from '../voiceTranscription';
import {
  linkVoiceTranscriptionKeys,
  startVoiceTranscription,
  voiceTranscriptionKeys,
} from '../voiceTranscriptionJobs';

/**
 * A voice message addressed to an agent is transcribed in the background as
 * soon as sending starts. Upload and the sender's bubble never wait for it;
 * only the agent turn does.
 */
function untranscribedVoiceAttachment(attachments: readonly AttachmentItem[]) {
  const attachment = attachments.length === 1 ? attachments[0] : null;
  const voice = attachment?.voiceMessage;
  if (!attachment || !voice || voiceTranscript(voice)) return null;
  if ((voice.transcription?.attempts ?? 0) >= MAX_TRANSCRIPTION_ATTEMPTS) return null;
  const path = (attachment.localPath ?? attachment.path)?.trim();
  return path ? { attachment, path } : null;
}

function attachmentKeys(attachment: AttachmentItem, path: string) {
  return voiceTranscriptionKeys({ mediaId: attachment.attachmentId, localPath: path });
}

export function startAgentVoiceTranscription(
  attachments: readonly AttachmentItem[],
): Promise<VoiceTranscriptionOutcome> | null {
  const voice = untranscribedVoiceAttachment(attachments);
  if (!voice) return null;
  return startVoiceTranscription({
    keys: attachmentKeys(voice.attachment, voice.path),
    source: () => Promise.resolve(voice.path),
  });
}

export function attachmentsWithVoiceTranscription(
  attachments: readonly AttachmentItem[],
  outcome: VoiceTranscriptionOutcome,
): AttachmentItem[] {
  return attachments.map((attachment) => (
    attachment.voiceMessage
      ? { ...attachment, voiceMessage: voiceWithTranscriptionOutcome(attachment.voiceMessage, outcome) }
      : attachment
  ));
}

export const AGENT_VOICE_TRANSCRIPT_TIMEOUT_ERROR = 'Transcription did not finish in time.';

/**
 * Bounds how long an agent turn waits for the words. A late result fails the turn's
 * attempt only; the job keeps running and the bubble still shows its transcript.
 */
export function agentVoiceTranscriptionWithin(
  transcription: Promise<VoiceTranscriptionOutcome>,
  timeoutMs = VOICE_AGENT_TRANSCRIPT_WAIT_MS,
): Promise<VoiceTranscriptionOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<VoiceTranscriptionOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'failed', error: AGENT_VOICE_TRANSCRIPT_TIMEOUT_ERROR }), timeoutMs);
  });
  return Promise.race([transcription, timeout]).finally(() => clearTimeout(timer));
}

/** Waits, within the bounded agent wait, for the background transcript before an agent turn is dispatched. */
export async function transcribeAgentVoiceAttachments(
  attachments: readonly AttachmentItem[],
  transcription = startAgentVoiceTranscription(attachments),
  timeoutMs = VOICE_AGENT_TRANSCRIPT_WAIT_MS,
): Promise<{ attachments: readonly AttachmentItem[]; outcome: VoiceTranscriptionOutcome | null }> {
  if (!transcription) return { attachments, outcome: null };
  const outcome = await agentVoiceTranscriptionWithin(transcription, timeoutMs);
  return { attachments: attachmentsWithVoiceTranscription(attachments, outcome), outcome };
}

/**
 * Stores the agent-bound transcript on the sent message. Agent executors wait
 * for the resulting `message.updated` before they start the turn.
 */
export async function persistSentAgentVoiceTranscript(
  sent: Pick<CloudMessage, 'conversationId' | 'messageId' | 'version' | 'voiceMessage'> | null | undefined,
  attachments: readonly AttachmentItem[],
  transcription: Promise<VoiceTranscriptionOutcome>,
) {
  const voice = untranscribedVoiceAttachment(attachments);
  const mediaId = sent?.voiceMessage?.mediaId?.trim();
  if (voice && mediaId) {
    linkVoiceTranscriptionKeys([...attachmentKeys(voice.attachment, voice.path), `media:${mediaId}`]);
  }
  try {
    const outcome = await transcription;
    const target = sent ? cloudVoiceTranscriptTarget(sent) : null;
    if (!target || (sent?.voiceMessage && voiceTranscript(sent.voiceMessage))) return null;
    return await persistCloudVoiceTranscript(target, outcome);
  } finally {
    // Fallback runs for this request may be claimed now, whether or not a transcript was stored.
    markCloudVoiceTranscriptSettled(sent?.messageId);
  }
}

/** A queued local agent message takes its background transcript before its turn starts. */
export async function queuedMessageWithAgentTranscript<T extends { text: string; attachments: AttachmentItem[] }>(
  message: T,
  timeoutMs = VOICE_AGENT_TRANSCRIPT_WAIT_MS,
): Promise<T> {
  const { attachments, outcome } = await transcribeAgentVoiceAttachments(
    message.attachments,
    startAgentVoiceTranscription(message.attachments),
    timeoutMs,
  );
  if (!outcome) return message;
  return {
    ...message,
    text: outcome.status === 'ready' ? outcome.transcript : message.text,
    attachments: [...attachments],
  };
}

/**
 * Starts transcription for a Cloud voice send that an agent will read. The returned hooks store the
 * transcript once the message exists, without delaying the send itself.
 */
export function agentVoiceSend(addressedToAgent: boolean, attachments: readonly AttachmentItem[]) {
  const transcription = addressedToAgent ? startAgentVoiceTranscription(attachments) : null;
  if (!transcription) return null;
  return {
    persistAfterSend: (sent: CloudMessage) => {
      void persistSentAgentVoiceTranscript(sent, attachments, transcription).catch(() => undefined);
    },
    beforeFallbackClaim: async (sent: readonly CloudMessage[]) => {
      await persistSentAgentVoiceTranscript(sent.find((message) => message.voiceMessage) ?? null, attachments, transcription);
    },
  };
}
