import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import type { DesktopChatContextMessage } from '@/lib/desktop';

import { cloudAgentNativeContextMessagesFromDirectCloudSession } from './cloudAgentMessages';
import { boundedRequestContextMessages } from './cloudAgentRequestContext';

/**
 * Context for a self-agent run this Mac claimed: the target agent definition,
 * the bounded direct-session history, then the request's own reference context.
 */
export function cloudSelfAgentExecutionContextMessages({
  definition,
  session,
  requestContextMessages,
}: {
  definition: Parameters<typeof cloudAgentContextMessagesFromDefinition>[0];
  session: Parameters<typeof cloudAgentNativeContextMessagesFromDirectCloudSession>[0];
  requestContextMessages: readonly DesktopChatContextMessage[];
}): DesktopChatContextMessage[] {
  return [
    ...cloudAgentContextMessagesFromDefinition(definition),
    ...cloudAgentNativeContextMessagesFromDirectCloudSession(session),
    ...boundedRequestContextMessages(requestContextMessages),
  ];
}
