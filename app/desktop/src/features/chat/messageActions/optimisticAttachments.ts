import { voiceAgentText } from '../voiceTranscription';
import type { Message } from '@/kordi-app/types';

import type { AttachmentItem } from '../composerController.types';

export function toOptimisticAttachments(attachments: AttachmentItem[]) {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    ...(attachment.livePhoto ? { livePhoto: attachment.livePhoto } : {}),
    ...(attachment.livePhotoFiles ? { livePhotoFiles: attachment.livePhotoFiles } : {}),
    ...(attachment.subtype === 'sticker' ? { subtype: 'sticker' as const } : {}),
    name: attachment.name,
    formatLabel: attachment.formatLabel,
    previewUrl: attachment.previewUrl,
    mimeType: attachment.mimeType,
    localPath: attachment.path,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.widthPixels && attachment.heightPixels ? {
      widthPixels: attachment.widthPixels,
      heightPixels: attachment.heightPixels,
    } : {}),
  }));
}

export function voiceMessageDraftFromAttachments(attachments: readonly AttachmentItem[]) {
  const draft = attachments.length === 1 ? attachments[0]?.voiceMessage ?? null : null;
  if (!draft) return null;
  const { localPath: _localPath, ...portableDraft } = draft;
  return portableDraft;
}

export function voiceMessageSendFields(attachments: readonly AttachmentItem[]) {
  const voiceMessage = voiceMessageDraftFromAttachments(attachments);
  const sticker = !voiceMessage
    && attachments.length === 1
    && attachments[0]?.subtype === 'sticker';
  return { messageKind: voiceMessage ? 'voice' : sticker ? 'sticker' : 'text', voiceMessage };
}

function optimisticVoiceMessage(attachments: readonly AttachmentItem[]) {
  const draft = voiceMessageDraftFromAttachments(attachments);
  const attachment = attachments[0];
  if (!draft || !attachment) return null;
  return {
    ...draft,
    mediaId: attachment.attachmentId?.trim() || `pending:${attachment.id}`,
    localPath: attachment.path,
  };
}

export function optimisticAttachmentContent(attachments: AttachmentItem[]) {
  const voiceMessage = optimisticVoiceMessage(attachments);
  return {
    attachments: voiceMessage ? [] : toOptimisticAttachments(attachments),
    ...(voiceMessage ? { voiceMessage } : {}),
  };
}

export function retryAttachmentItemsFromMessage(message: Message): AttachmentItem[] | null {
  if (message.voiceMessage?.localPath) {
    const path = message.voiceMessage.localPath;
    return [{
      id: message.voiceMessage.mediaId || `${message.id ?? 'voice'}:${path}`,
      path,
      localPath: path,
      name: 'Voice message.m4a',
      kind: 'file',
      mimeType: message.voiceMessage.mimeType,
      formatLabel: 'M4A',
      voiceMessage: {
        mimeType: message.voiceMessage.mimeType,
        durationMs: message.voiceMessage.durationMs,
        waveformSamples: message.voiceMessage.waveformSamples,
        transcript: message.voiceMessage.transcript,
        transcription: message.voiceMessage.transcription,
        localPath: path,
      },
    }];
  }
  const attachments = message.attachments ?? [];
  const retryAttachments = attachments.map((attachment, index) => {
    const path = attachment.localPath?.trim();
    if (!path) return null;
    return {
      ...attachment,
      id: attachment.attachmentId?.trim() || `${message.id ?? 'message'}:${index}:${path}`,
      path,
    } satisfies AttachmentItem;
  });
  return retryAttachments.every((attachment): attachment is AttachmentItem => attachment !== null)
    ? retryAttachments
    : null;
}

export function voiceMessageAgentText(text: string, attachments: readonly AttachmentItem[]): string {
  const voice = voiceMessageDraftFromAttachments(attachments);
  return voice ? voiceAgentText(voice) : text;
}
