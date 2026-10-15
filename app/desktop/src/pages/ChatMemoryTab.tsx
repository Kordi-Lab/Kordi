import { useMemo } from 'react';

import { projectForChat, useChatProjects } from '@/features/projects/chatProjects';
import { useCloudGroupConversationIds, type CloudConversationLoader } from '@/features/memory/cloudGroupConversation';
import { ConversationMemoryPanel } from '@/features/memory/ConversationMemoryPanel';
import { conversationMemoryAddTarget, conversationMemoryScopes } from '@/features/memory/conversationMemory';
import { memoryClientForEnvironment, type MemoryClient } from '@/features/memory/memoryClient';
import type { Conversation } from '@/kordi-app/types';

type MemoryConversation = Pick<Conversation, 'id' | 'canonicalSessionId' | 'agentSubsessionId' | 'participantSpaceId'>
  & Partial<Pick<Conversation, 'name'>>;

/**
 * The Memory tab of a chat. Conversation memories match the canonical session
 * id (also the cloud `sessionId`), group memories the group id or the cloud
 * group conversation id from the chat sync mapping, and project memories the
 * project root or the chat project id. A project's tab adds memories to the
 * project; a chat's tab adds them to the chat, or to its group.
 */
export function ChatMemoryTab({
  conversation,
  projectRoot,
  project,
  client = memoryClientForEnvironment(),
  loadCloudConversations,
}: {
  conversation: MemoryConversation;
  projectRoot?: string | null;
  /** Set on a project's tab: memories added there belong to this project. */
  project?: { name: string; root?: string | null };
  client?: MemoryClient;
  loadCloudConversations?: CloudConversationLoader;
}) {
  const chatProjects = useChatProjects();
  const sessionId = conversation.canonicalSessionId ?? conversation.id;
  const chatProject = chatProjects ? projectForChat(chatProjects.projects, sessionId) : undefined;
  const cloudConversationIds = useCloudGroupConversationIds(
    client,
    [conversation.canonicalSessionId, conversation.id],
    loadCloudConversations,
  );
  // Until the cloud group id resolves the list stays in its loading state.
  const scopes = useMemo(() => (cloudConversationIds ? conversationMemoryScopes({
    sessionIds: [conversation.canonicalSessionId, conversation.id, conversation.agentSubsessionId],
    participantSpaceId: conversation.participantSpaceId,
    projectIds: [projectRoot, chatProject?.root, chatProject?.id],
    cloudConversationIds,
  }) : null), [
    chatProject?.id,
    chatProject?.root,
    cloudConversationIds,
    conversation.agentSubsessionId,
    conversation.canonicalSessionId,
    conversation.id,
    conversation.participantSpaceId,
    projectRoot,
  ]);
  const isProjectTab = Boolean(project);
  const label = project ? project.name : conversation.name;
  const addRoot = project?.root;
  const addTarget = useMemo(() => (cloudConversationIds ? conversationMemoryAddTarget({
    sessionIds: [conversation.canonicalSessionId, conversation.id],
    cloudConversationIds,
    project: isProjectTab ? { root: addRoot } : undefined,
    label,
  }) : null), [addRoot, cloudConversationIds, conversation.canonicalSessionId, conversation.id, isProjectTab, label]);
  return (
    <div className="app-detail-sheet">
      <ConversationMemoryPanel client={client} scopes={scopes} addTarget={addTarget} />
    </div>
  );
}
