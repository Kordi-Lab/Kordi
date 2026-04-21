import { useCallback } from 'react';

import type { DesktopChatMessage, Message } from '@/kordi-app/types';

export function useDesktopTranscriptAdapter() {
  const mapDesktopMessages = useCallback((sessionId: string, messages: DesktopChatMessage[]): Message[] => (
    messages.flatMap((message, index) => {
      const hasHistoricalTurn =
        message.role === 'assistant'
        && (((message.thinkingText ?? '').trim().length > 0) || ((message.tools?.length ?? 0) > 0));
      const assistantText = message.text.trim();

      if (message.role === 'assistant' && !hasHistoricalTurn && assistantText.length === 0) {
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
            ? message.sender ?? 'Kordi'
            : message.role === 'user'
              ? message.sender ?? 'You'
              : message.sender ?? undefined,
        text: message.text,
        time: message.timeLabel,
        detail: message.role === 'assistant' ? undefined : (message.detail ?? undefined),
        turn:
          hasHistoricalTurn
            ? {
                id: `${sessionId}-historical-${message.timestampMs}-${index}`,
                sessionId,
                prompt: '',
                status: (message.tools ?? []).some((tool) => tool.isError) ? 'failed' : 'succeeded',
                message: 'Response complete',
                assistantText: message.text,
                thinkingText: message.thinkingText ?? '',
                tools: message.tools ?? [],
                completed: true,
                succeeded: !(message.tools ?? []).some((tool) => tool.isError),
                error: undefined,
              }
            : undefined,
      }];
    })
  ), []);

  return {
    mapDesktopMessages,
  };
}
