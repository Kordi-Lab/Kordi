import type { ComposerQuoteState } from '@/kordi-app/types';
import type { DesktopChatContextMessage } from '@/lib/desktop';

export type SendChatMessageWithImmediateQuoteClearArgs = {
  draftOverride?: string;
  targetSessionId?: string;
  contextMessages?: DesktopChatContextMessage[];
  currentDraft: string;
  attachmentCount: number;
  activeChatQuote?: ComposerQuoteState | null;
  send: (draftOverride?: string, targetSessionId?: string, contextMessages?: DesktopChatContextMessage[]) => Promise<void> | void;
  clearQuote: () => void;
};

export async function sendChatMessageWithImmediateQuoteClear({
  draftOverride,
  targetSessionId,
  contextMessages,
  currentDraft,
  attachmentCount,
  activeChatQuote,
  send,
  clearQuote,
}: SendChatMessageWithImmediateQuoteClearArgs) {
  const hasSendableContent = (draftOverride ?? currentDraft).trim().length > 0 || attachmentCount > 0;
  const result = send(draftOverride, targetSessionId, contextMessages);
  if (!targetSessionId && hasSendableContent && activeChatQuote) {
    clearQuote();
  }
  await result;
}
