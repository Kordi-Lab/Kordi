import { useCallback, type MutableRefObject } from 'react';

import { getLocalAgentAvatarSeed, getLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { firstPersonPossessiveLabel, selfDisplayName } from '@/lib/identityLabels';
import type { DesktopChatMessage, Message } from '@/kordi-app/types';

type LocalAvatarSeedsRef = MutableRefObject<{
  human?: string | null;
  humanDisplayName?: string | null;
  humanProfileImageUrl?: string | null;
  agent?: string | null;
  agentDisplayName?: string | null;
}>;

type UseDesktopTranscriptAdapterArgs = {
  localAvatarSeedsRef?: LocalAvatarSeedsRef;
};

type DesktopTranscriptAvatarSeeds = {
  human?: string | null;
  humanDisplayName?: string | null;
  humanProfileImageUrl?: string | null;
  agent?: string | null;
  agentDisplayName?: string | null;
};

type DesktopTranscriptSessionContext = {
  metadata?: unknown;
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

function cloudAgentTranscriptIdentity(context?: DesktopTranscriptSessionContext) {
  const metadata = metadataRecord(context?.metadata);
  const id = metadataText(metadata, 'cloudAgentId');
  const name = metadataText(metadata, 'cloudAgentName');
  if (!id || !name) return null;
  return { id, name };
}

function desktopTranscriptMessageId(sessionId: string, message: DesktopChatMessage, index: number) {
  const renderId = message.transcriptRenderId?.trim();
  if (renderId) return renderId;
  const entryId = message.entryId?.trim();
  if (entryId) return `desktop-entry:${sessionId}:${entryId}`;
  const role = message.role.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'message';
  return `desktop-message:${sessionId}:${message.timestampMs}:${index}:${role}`;
}

function desktopMessageActionSource(message: DesktopChatMessage) {
  const source = message.messageAction?.source;
  if (!source) return null;
  return {
    messageId: source.sourceMessageId,
    senderLabel: source.senderLabel,
    text: source.textPreview,
    mentions: source.mentions,
    attachmentCount: source.attachmentCount,
    time: source.timeLabel ?? null,
  };
}

function assistantSenderLabelForTranscript(
  sender: string | null | undefined,
  explicitDisplayName?: string | null,
) {
  const displayName = explicitDisplayName?.trim();
  if (displayName && !/^kordi$/iu.test(displayName)) return displayName;
  const label = sender?.trim() || displayName || 'Kordi';
  if (/·\s+.+?'s Agent$/u.test(label)) return label;
  return firstPersonPossessiveLabel(label);
}

export function mapDesktopMessagesForTranscript(
  sessionId: string,
  messages: DesktopChatMessage[],
  avatarSeeds?: DesktopTranscriptAvatarSeeds,
  sessionContext?: DesktopTranscriptSessionContext,
): Message[] {
  const cloudAgentIdentity = cloudAgentTranscriptIdentity(sessionContext);
  return messages.flatMap((message, index) => {
    const messageId = desktopTranscriptMessageId(sessionId, message, index);
    const isAssistant = message.role === 'assistant';
    const failedAssistant = isAssistant && message.failed === true;
    const cancelledAssistant = isAssistant && message.cancelled === true;
    const assistantText = message.text.trim();
    const hasHistoricalTurn =
      isAssistant
      && (
        failedAssistant
        || cancelledAssistant
        || assistantText.length > 0
        || ((message.thinkingText ?? '').trim().length > 0)
        || ((message.tools?.length ?? 0) > 0)
      );

    if (isAssistant && !hasHistoricalTurn) {
      return [];
    }

    const assistantSenderLabel = cloudAgentIdentity?.name
      || assistantSenderLabelForTranscript(message.sender, avatarSeeds?.agentDisplayName);
    const assistantAvatarSeed = cloudAgentIdentity?.id || avatarSeeds?.agent?.trim() || getLocalAgentAvatarSeed();

    return [{
      id: messageId,
      entryId: message.entryId ?? null,
      role:
        message.role === 'assistant'
          ? ('owned-agent' as const)
          : message.role === 'action'
            ? ('action' as const)
            : message.role === 'system'
              ? ('system' as const)
              : ('user' as const),
      sender:
        message.role === 'assistant'
          ? assistantSenderLabel
          : message.role === 'user'
            ? selfDisplayName(message.sender ?? 'Me', true)
            : message.sender ?? undefined,
      sourceSenderLabel: message.role === 'assistant'
        ? assistantSenderLabel
        : message.role === 'user'
          ? (avatarSeeds?.humanDisplayName?.trim() || selfDisplayName(message.sender ?? 'Me', true))
          : message.sender ?? null,
      text: message.text,
      time: message.timeLabel,
      timestampMs: message.timestampMs,
      detail: message.role === 'assistant' ? undefined : (message.detail ?? undefined),
      senderAvatarSeed: message.role === 'assistant'
        ? assistantAvatarSeed
        : message.role === 'user'
          ? (avatarSeeds?.human?.trim() || getLocalProfileAvatarSeed())
          : undefined,
      senderProfileImageUrl: message.role === 'user'
        ? (avatarSeeds?.humanProfileImageUrl?.trim() || null)
        : undefined,
      attachments: message.attachments?.map((attachment) => {
        const mapped = {
          kind: attachment.kind,
          ...(attachment.subtype === 'sticker'
            ? { subtype: 'sticker' as const }
            : attachment.subtype === 'meme' ? {
                subtype: 'meme' as const,
                altText: attachment.altText ?? null,
              } : {}),
          name: attachment.name,
          formatLabel: attachment.formatLabel,
          previewUrl: attachment.previewUrl,
          mimeType: attachment.mimeType,
          localPath: attachment.localPath,
          sizeBytes: attachment.sizeBytes,
          ...(attachment.widthPixels && attachment.heightPixels ? {
            widthPixels: attachment.widthPixels,
            heightPixels: attachment.heightPixels,
          } : {}),
        };
        if (attachment.downloadUrl) Object.assign(mapped, { downloadUrl: attachment.downloadUrl });
        if (attachment.attachmentId) Object.assign(mapped, { attachmentId: attachment.attachmentId });
        return mapped;
      }),
      mentions: message.mentions,
      replyToMessageId: message.replyToMessageId ?? (
        message.messageAction?.kind === 'quote' || message.messageAction?.kind === 'thread'
          ? message.messageAction.source.sourceMessageId
          : undefined
      ),
      messageAction: message.messageAction ?? null,
      sourceMessage: desktopMessageActionSource(message),
      turn:
        hasHistoricalTurn
          ? {
              id: messageId,
              sessionId,
              prompt: '',
              status: failedAssistant ? 'failed' : cancelledAssistant ? 'cancelled' : 'succeeded',
              message: failedAssistant
                ? (message.detail ?? 'Request failed')
                : cancelledAssistant
                  ? 'Response stopped'
                  : 'Response complete',
              assistantText: failedAssistant ? '' : message.text,
              thinkingText: message.thinkingText ?? '',
              tools: message.tools ?? [],
              completed: true,
              succeeded: !failedAssistant && !cancelledAssistant,
              startedAtMs: message.turnStartedAtMs ?? null,
              completedAtMs: message.turnCompletedAtMs ?? message.timestampMs,
              error: failedAssistant ? message.text : undefined,
            }
          : undefined,
    }];
  });
}

export function useDesktopTranscriptAdapter({ localAvatarSeedsRef }: UseDesktopTranscriptAdapterArgs = {}) {
  const mapDesktopMessages = useCallback((sessionId: string, messages: DesktopChatMessage[], sessionContext?: DesktopTranscriptSessionContext): Message[] => (
    mapDesktopMessagesForTranscript(sessionId, messages, localAvatarSeedsRef?.current, sessionContext)
  ), [localAvatarSeedsRef]);

  return {
    mapDesktopMessages,
  };
}
