import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

import { isLocalDraftChatConversationId } from './draftSessions';

/**
 * Whether the chat composer mirrors this Mac's runtime session settings.
 * A chat on a hosted account shows its session route instead: that route is
 * what a send carries and what the turn runs, while the runtime keeps only
 * the session's own settings between turns.
 */
export function chatComposerFollowsRuntimeSession({
  activeConversationUsesCollaboration,
  activeConvId,
  desktopActiveSessionId,
  activeChatRoute,
}: {
  activeConversationUsesCollaboration: boolean;
  activeConvId: string;
  desktopActiveSessionId: string;
  activeChatRoute: DesktopChatMessageRoute | null;
}) {
  if (activeConversationUsesCollaboration || routeRunsOnKordiCloud(activeChatRoute)) return false;
  return !isLocalDraftChatConversationId(activeConvId) || isLocalDraftChatConversationId(desktopActiveSessionId);
}
