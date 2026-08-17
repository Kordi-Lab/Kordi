import { useCallback } from 'react';

type ComposerUi = ReturnType<
  typeof import('@/app/useKordiLocalUiState').useKordiLocalUiState
>['composerUi'];

export function useClearChatQuote(
  sessionId: string,
  setChatQuoteBySessionId: ComposerUi['setChatQuoteBySessionId'],
) {
  return useCallback(() => {
    setChatQuoteBySessionId((current) => ({
      ...current,
      [sessionId]: null,
    }));
  }, [sessionId, setChatQuoteBySessionId]);
}
