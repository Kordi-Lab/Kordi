import { findOwnedAgentConversation } from '@/features/canonical/sessionResolver';
import { requestKordiCloudChatRoute } from '@/features/chat/kordiCloudChatRoute';
import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import type { Conversation } from '@/kordi-app/types';
import { createDesktopChatSession, updateDesktopChatSessionConfig, type DesktopChatMessageRoute } from '@/lib/desktop';

export { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';

type LocalAgentChatNavigationArgs = {
  setActiveNav: (nav: 'chats') => void;
  chatConversations: Conversation[];
  handleSelectChatSession: (sessionId: string) => Promise<void>;
  handleCreateChatSession: () => Promise<void>;
};

export async function openLocalAgentChatFromArgs(
  args: LocalAgentChatNavigationArgs,
  preferredModelValue?: string,
  route?: DesktopChatMessageRoute | null,
) {
  args.setActiveNav('chats');
  const existingLocalConversation = findOwnedAgentConversation(args.chatConversations);

  // A hosted-only account runs on Kordi Cloud: the chat opens with that route
  // and this Mac's runtime never loads the model or the credential.
  if (route && routeRunsOnKordiCloud(route)) {
    if (existingLocalConversation) await args.handleSelectChatSession(existingLocalConversation.id);
    else await args.handleCreateChatSession();
    requestKordiCloudChatRoute(route, existingLocalConversation?.id ?? null);
    return;
  }

  if (!preferredModelValue) {
    if (existingLocalConversation) {
      await args.handleSelectChatSession(existingLocalConversation.id);
    } else {
      await args.handleCreateChatSession();
    }
    return;
  }

  const sessionId = existingLocalConversation?.id ?? (await createDesktopChatSession()).activeSessionId;
  await updateDesktopChatSessionConfig(sessionId, preferredModelValue);
  await args.handleSelectChatSession(sessionId);
}
