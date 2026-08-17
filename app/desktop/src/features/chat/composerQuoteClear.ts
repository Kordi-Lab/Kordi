import type { ComposerQuoteState } from '@/kordi-app/types';
import type { DesktopChatContextMessage } from '@/lib/desktop';
import type { AttachmentItem } from './composerController.types';

export type SendChatMessageWithImmediateQuoteClearArgs = {
  draftOverride?: string;
  targetSessionId?: string;
  contextMessages?: DesktopChatContextMessage[];
  attachmentOverride?: AttachmentItem[];
  currentDraft: string;
  attachmentCount: number;
  activeChatQuote?: ComposerQuoteState | null;
  send: (draftOverride?: string, targetSessionId?: string, contextMessages?: DesktopChatContextMessage[], attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  clearQuote: () => void;
};

export async function sendChatMessageWithImmediateQuoteClear({
  draftOverride,
  targetSessionId,
  contextMessages,
  attachmentOverride,
  currentDraft,
  attachmentCount,
  activeChatQuote,
  send,
  clearQuote,
}: SendChatMessageWithImmediateQuoteClearArgs) {
  const hasSendableContent = (draftOverride ?? currentDraft).trim().length > 0
    || (attachmentOverride?.length ?? attachmentCount) > 0;
  const result = attachmentOverride === undefined
    ? send(draftOverride, targetSessionId, contextMessages)
    : send(draftOverride, targetSessionId, contextMessages, attachmentOverride);
  if (!targetSessionId && hasSendableContent && activeChatQuote) {
    clearQuote();
  }
  await result;
}
