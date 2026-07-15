import type { MessageActionMetadata } from '@/kordi-app/types/message';

/**
 * Forwarding copies existing content into another conversation. Mentions in
 * that copied content are display-only and must not be interpreted as a new
 * request to an agent or included as a later model turn. Quotes remain
 * eligible because the user can add a new prompt alongside quoted context.
 */
function cloudMessageActionIsForward(
  messageAction: MessageActionMetadata | null | undefined,
): boolean {
  return messageAction?.kind === 'forward';
}

export function cloudMessageActionAllowsAgentTrigger(
  messageAction: MessageActionMetadata | null | undefined,
): boolean {
  return !cloudMessageActionIsForward(messageAction);
}

export function cloudMessageActionAllowsAgentContext(
  messageAction: MessageActionMetadata | null | undefined,
): boolean {
  return !cloudMessageActionIsForward(messageAction);
}
