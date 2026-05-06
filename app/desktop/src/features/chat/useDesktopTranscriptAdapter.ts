import { useCallback, type MutableRefObject } from 'react';

import { getLocalAgentAvatarSeed, getLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { firstPersonPossessiveLabel, selfDisplayName } from '@/lib/identityLabels';
import type { DesktopChatMessage, Message } from '@/kordi-app/types';

type LocalAvatarSeedsRef = MutableRefObject<{
  human?: string | null;
  agent?: string | null;
}>;

type UseDesktopTranscriptAdapterArgs = {
  localAvatarSeedsRef?: LocalAvatarSeedsRef;
};

type DesktopTranscriptAvatarSeeds = {
  human?: string | null;
  agent?: string | null;
};

export function mapDesktopMessagesForTranscript(
  sessionId: string,
  messages: DesktopChatMessage[],
  avatarSeeds?: DesktopTranscriptAvatarSeeds,
): Message[] {
  return messages.flatMap((message, index) => {
    const isAssistant = message.role === 'assistant';
    const failedAssistant = isAssistant && message.failed === true;
    const assistantText = message.text.trim();
    const hasHistoricalTurn =
      isAssistant
      && (
        failedAssistant
        || assistantText.length > 0
        || ((message.thinkingText ?? '').trim().length > 0)
        || ((message.tools?.length ?? 0) > 0)
      );

    if (isAssistant && !hasHistoricalTurn) {
      return [];
    }

    return [{
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
          ? firstPersonPossessiveLabel(message.sender ?? 'Kordi')
          : message.role === 'user'
            ? selfDisplayName(message.sender ?? 'Me', true)
            : message.sender ?? undefined,
      text: message.text,
      time: message.timeLabel,
      detail: message.role === 'assistant' ? undefined : (message.detail ?? undefined),
      senderAvatarSeed: message.role === 'assistant'
        ? (avatarSeeds?.agent?.trim() || getLocalAgentAvatarSeed(message.sender ?? 'Kordi'))
        : message.role === 'user'
          ? (avatarSeeds?.human?.trim() || getLocalProfileAvatarSeed())
          : undefined,
      attachments: message.attachments?.map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        formatLabel: attachment.formatLabel,
        previewUrl: attachment.previewUrl,
        mimeType: attachment.mimeType,
        localPath: attachment.localPath,
        sizeBytes: attachment.sizeBytes,
      })),
      mentions: message.mentions,
      turn:
        hasHistoricalTurn
          ? {
              id: `${sessionId}-historical-${message.timestampMs}-${index}`,
              sessionId,
              prompt: '',
              status: failedAssistant ? 'failed' : 'succeeded',
              message: failedAssistant ? (message.detail ?? 'Request failed') : 'Response complete',
              assistantText: failedAssistant ? '' : message.text,
              thinkingText: message.thinkingText ?? '',
              tools: message.tools ?? [],
              completed: true,
              succeeded: !failedAssistant,
              startedAtMs: message.turnStartedAtMs ?? null,
              completedAtMs: message.turnCompletedAtMs ?? message.timestampMs,
              error: failedAssistant ? message.text : undefined,
            }
          : undefined,
    }];
  });
}

export function useDesktopTranscriptAdapter({ localAvatarSeedsRef }: UseDesktopTranscriptAdapterArgs = {}) {
  const mapDesktopMessages = useCallback((sessionId: string, messages: DesktopChatMessage[]): Message[] => (
    mapDesktopMessagesForTranscript(sessionId, messages, localAvatarSeedsRef?.current)
  ), [localAvatarSeedsRef]);

  return {
    mapDesktopMessages,
  };
}
