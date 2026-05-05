import { findOwnedAgentConversation } from '@/features/canonical/sessionResolver';
import type { Conversation } from '@/kordi-app/types';
import { createDesktopChatSession, updateDesktopChatSessionConfig } from '@/lib/desktop';

type LocalAgentChatNavigationArgs = {
  setActiveNav: (nav: 'chats') => void;
  chatConversations: Conversation[];
  handleSelectChatSession: (sessionId: string) => Promise<void>;
  handleCreateChatSession: () => Promise<void>;
};

export async function openLocalAgentChatFromArgs(
  args: LocalAgentChatNavigationArgs,
  preferredModelValue?: string,
) {
  args.setActiveNav('chats');
  const existingLocalConversation = findOwnedAgentConversation(args.chatConversations);

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
