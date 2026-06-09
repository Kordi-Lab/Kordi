import type { ComposerQuoteState } from '@/kordi-app/types';

export type SendChatMessageWithImmediateQuoteClearArgs = {
  draftOverride?: string;
  currentDraft: string;
  attachmentCount: number;
  activeChatQuote?: ComposerQuoteState | null;
  send: (draftOverride?: string) => Promise<void> | void;
  clearQuote: () => void;
};

export async function sendChatMessageWithImmediateQuoteClear({
  draftOverride,
  currentDraft,
  attachmentCount,
  activeChatQuote,
  send,
  clearQuote,
}: SendChatMessageWithImmediateQuoteClearArgs) {
  const hasSendableContent = (draftOverride ?? currentDraft).trim().length > 0 || attachmentCount > 0;
  const result = send(draftOverride);
  if (hasSendableContent && activeChatQuote) {
    clearQuote();
  }
  await result;
}
