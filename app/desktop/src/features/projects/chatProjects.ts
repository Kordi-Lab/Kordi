import { createContext, useContext } from 'react';
import type { ChatWorkspaceSelection, GitWorkspace } from './gitWorkspace';
import type { Conversation } from '@/kordi-app/types';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { isPersonalAgentSession } from '@/features/personalAgent/personalAgentStore';

export type ChatProject = {
  id: string;
  name: string;
  root?: string;
  sessions: readonly { id: string }[];
};

export type ChatProjects = {
  enabled: boolean;
  openImporter?: (sessionId?: string) => void;
  projects: readonly ChatProject[];
  gitWorkspace?: (root: string, workspaceRoot?: string, workspaceId?: string) => Promise<GitWorkspace | null>;
  assign: (sessionId: string, root: string, workspace?: ChatWorkspaceSelection) => Promise<void>;
  create: (sessionId: string, name: string, folder: string) => Promise<void>;
};

export const ChatProjectsContext = createContext<ChatProjects | null>(null);
export function useChatProjects() { return useContext(ChatProjectsContext); }

export function projectForChat(projects: readonly ChatProject[], sessionId: string) {
  return projects.find((project) => project.sessions.some((session) => session.id === sessionId));
}

export function canChooseChatProject(conversation: Conversation) {
  // An agent's personal session never becomes a project session.
  return !conversation.agentSubsessionId && !conversation.collaborationTarget
    && !isPersonalAgentSession(conversation.canonicalSessionId ?? conversation.id, conversation.metadata)
    && (isLocalDraftChatConversationId(conversation.id)
      || (Boolean(conversation.desktopRuntimeBacked) && !isCloudChatRuntimeCopy(conversation)));
}

/**
 * Opening or running a cloud chat on this Mac loads an in-memory runtime copy, and
 * routine refreshes load and drop it. The answer must not follow that copy.
 */
function isCloudChatRuntimeCopy(conversation: Conversation) {
  return conversation.desktopRuntimeUnlisted === true && isCloudAgentSession(conversation);
}

function isCloudAgentSession(conversation: Conversation) {
  const metadata = conversation.metadata as { cloudSelfAgentSession?: unknown } | null | undefined;
  return metadata?.cloudSelfAgentSession === true;
}

/** A cloud agent chat this Mac does not keep as a saved local chat, with or without a runtime copy loaded. */
export function isCloudAgentChat(conversation: Conversation) {
  return !conversation.agentSubsessionId && !conversation.collaborationTarget && isCloudAgentSession(conversation)
    && (!conversation.desktopRuntimeBacked || conversation.desktopRuntimeUnlisted === true);
}
