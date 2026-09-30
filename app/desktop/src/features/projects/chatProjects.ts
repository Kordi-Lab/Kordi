import { createContext, useContext } from 'react';
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
  assign: (sessionId: string, root: string) => Promise<void>;
  create: (sessionId: string, name: string, folder: string) => Promise<void>;
};

export const ChatProjectsContext = createContext<ChatProjects | null>(null);
export function useChatProjects() { return useContext(ChatProjectsContext); }

export function projectForChat(projects: readonly ChatProject[], sessionId: string) {
  return projects.find((project) => project.sessions.some((session) => session.id === sessionId));
}

export function canChooseChatProject(conversation: Conversation) {
  return !conversation.agentSubsessionId && !conversation.collaborationTarget
    && (conversation.desktopRuntimeBacked || isLocalDraftChatConversationId(conversation.id));
}
