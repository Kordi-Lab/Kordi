import { createContext, useContext } from 'react';
import type { ChatWorkspaceSelection, GitWorkspace } from './gitWorkspace';
import type { Conversation } from '@/kordi-app/types';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';

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
  gitWorkspace?: (root: string, workspaceRoot?: string) => Promise<GitWorkspace | null>;
  assign: (sessionId: string, root: string, workspace?: ChatWorkspaceSelection) => Promise<void>;
  create: (sessionId: string, name: string, folder: string) => Promise<void>;
};

export const ChatProjectsContext = createContext<ChatProjects | null>(null);
export function useChatProjects() { return useContext(ChatProjectsContext); }

export function projectForChat(projects: readonly ChatProject[], sessionId: string) {
  return projects.find((project) => project.sessions.some((session) => session.id === sessionId));
}

export function canChooseChatProject(conversation: Conversation) {
  return !conversation.agentSubsessionId && !conversation.collaborationTarget
    && (isLocalDraftChatConversationId(conversation.id)
      || (Boolean(conversation.desktopRuntimeBacked) && !isCloudChatRuntimeCopy(conversation)));
}

/**
 * Opening or running a cloud chat on this Mac loads an in-memory runtime copy, and
 * routine refreshes load and drop it. The answer must not follow that copy.
 */
function isCloudChatRuntimeCopy(conversation: Conversation) {
  const metadata = conversation.metadata as { cloudSelfAgentSession?: unknown } | null | undefined;
  return conversation.desktopRuntimeUnlisted === true && metadata?.cloudSelfAgentSession === true;
}
