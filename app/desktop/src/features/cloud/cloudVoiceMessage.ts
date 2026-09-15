import { parseVoiceTranscription, voiceTranscript } from '@/features/chat/voiceTranscription';
import type { MessageVoiceDraft } from '@/kordi-app/types/message';

import type { CloudMessageAttachment, CloudVoiceMessage } from './cloudAttachmentTypes';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function withoutVoiceAttachment<T extends { attachmentId?: string | null }>(
  attachments: T[] | undefined,
  voice: { mediaId?: string | null } | null | undefined,
): T[] | undefined {
  const mediaId = voice?.mediaId?.trim();
  return mediaId ? attachments?.filter((attachment) => attachment.attachmentId !== mediaId) : attachments;
}

export function cloudVoiceDraftMetadataOnly(value: unknown): (MessageVoiceDraft & { mediaId: string | null }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const mediaId = cleanText(record.mediaId);
  const mimeType = cleanText(record.mimeType);
  const transcript = cleanText(record.transcript);
  const durationMs = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
    ? Math.max(0, Math.round(record.durationMs))
    : 0;
  const waveformSamples = Array.isArray(record.waveformSamples)
    ? record.waveformSamples.flatMap((sample) => (
        typeof sample === 'number' && Number.isFinite(sample)
          ? [Math.max(0, Math.min(1, sample))]
          : []
      )).slice(0, 96)
    : [];
  if (!mimeType || durationMs <= 0) return null;
  const transcription = parseVoiceTranscription(record.transcription);
  const voice = { mediaId: mediaId || null, mimeType, durationMs, waveformSamples, transcript,
    ...(transcription ? { transcription } : {}),
  };
  return { ...voice, transcript: record.transcription && !transcription ? '' : voiceTranscript(voice) };
}

export function cloudVoiceMessageMetadataOnly(value: unknown): CloudVoiceMessage | null {
  const voice = cloudVoiceDraftMetadataOnly(value);
  return voice?.mediaId ? { ...voice, mediaId: voice.mediaId } : null;
}

export function cloudVoiceAttachmentReference(
  voiceMessage: (MessageVoiceDraft & { mediaId?: string | null }) | null | undefined,
  attachment: Pick<CloudMessageAttachment, 'attachmentId'> | undefined,
) {
  return voiceMessage && attachment
    ? { voiceMessage: { ...voiceMessage, mediaId: attachment.attachmentId,
        ...(voiceMessage.transcription ? { transcription: {
          ...voiceMessage.transcription, sourceVersion: attachment.attachmentId,
        } } : {}),
      } }
    : {};
}
