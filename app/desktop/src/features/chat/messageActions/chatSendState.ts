import type { ComposerQuoteState, Message, MessageActionMetadata } from '@/kordi-app/types';

export function chatSendShouldAutoFollowMain(
  quote?: ComposerQuoteState | null,
  retryMessage?: Message,
) {
  return quote?.action !== 'thread' && retryMessage?.messageAction?.kind !== 'thread';
}

export function composerQuoteFromMessageAction(
  action?: MessageActionMetadata | null,
): ComposerQuoteState | null {
  if (action?.kind !== 'quote' && action?.kind !== 'thread') return null;
  return { action: action.kind, source: action.source };
}

export function chatSendIsBusy({
  isDesktopChatSending = false,
  localSendInFlight = false,
}: {
  isDesktopChatSending?: boolean;
  desktopLiveTurn?: { completed?: boolean } | null;
  localSendInFlight?: boolean;
}) {
  return Boolean(isDesktopChatSending || localSendInFlight);
}
