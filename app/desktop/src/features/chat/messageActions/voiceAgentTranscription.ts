import type { CloudMessage } from '@/features/cloud/authClient';
import {
  cloudVoiceTranscriptTarget,
  persistCloudVoiceTranscript,
} from '@/features/cloud/cloudVoiceTranscriptPersistence';

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

/** Waits for the background transcript before an agent turn is dispatched. */
export async function transcribeAgentVoiceAttachments(
  attachments: readonly AttachmentItem[],
  transcription = startAgentVoiceTranscription(attachments),
): Promise<{ attachments: readonly AttachmentItem[]; outcome: VoiceTranscriptionOutcome | null }> {
  if (!transcription) return { attachments, outcome: null };
  const outcome = await transcription;
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
  const outcome = await transcription;
  const target = sent ? cloudVoiceTranscriptTarget(sent) : null;
  if (!target || (sent?.voiceMessage && voiceTranscript(sent.voiceMessage))) return null;
  return persistCloudVoiceTranscript(target, outcome);
}
