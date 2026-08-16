export type ActiveConversationReadPresentation = {
  isSelected: boolean;
  isTranscriptPresented: boolean;
  isAppForeground: boolean;
  isAtLatest: boolean;
};

export function canMarkActiveConversationRead({
  isSelected,
  isTranscriptPresented,
  isAppForeground,
  isAtLatest,
}: ActiveConversationReadPresentation) {
  return isSelected
    && isTranscriptPresented
    && isAppForeground
    && isAtLatest;
}

export function documentHasActivePresentation(
  documentValue: Pick<Document, 'visibilityState' | 'hasFocus'>,
) {
  return documentValue.visibilityState === 'visible'
    && documentValue.hasFocus();
}

export function transcriptIsAtLatest(
  container: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  tolerance = 140,
) {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom < tolerance;
}
