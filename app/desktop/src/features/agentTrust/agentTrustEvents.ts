// Window events that tell open views when AI access settings or actions that
// need a person changed. Views re-read from the server when they hear one;
// the detail is a hint, never the source of truth.
import { normalizeAiAccess, normalizePendingAgentAction } from '@/features/cloud/agentTrustClient';
import type { ChatSyncAiAccess, PendingAgentAction } from '@/features/cloud/agentTrustTypes';
import type { CloudSyncEvent } from '@/features/cloud/authClient';
import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';

export const AGENT_ACTION_UPDATED_EVENT = 'kordi-agent-action-updated';
export const AI_ACCESS_UPDATED_EVENT = 'kordi-ai-access-updated';

export type AgentActionUpdatedDetail = { action: PendingAgentAction | null };
export type AiAccessUpdatedDetail = {
  sessionId: string;
  conversationId: string;
  aiAccess: ChatSyncAiAccess | null;
};

function dispatch<T>(name: string, detail: T): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

/** Handles `agent_action.updated`. It changes no chat state, so it yields no sync events. */
export function notifyAgentActionUpdated(payload: Record<string, unknown>): CloudSyncEvent[] {
  dispatch<AgentActionUpdatedDetail>(AGENT_ACTION_UPDATED_EVENT, {
    action: normalizePendingAgentAction(payload.agentAction),
  });
  return [];
}

/** Announces a conversation snapshot that carries AI access settings. */
export function notifyAiAccess(conversation: ChatSyncConversation): void {
  if (!('ai_access' in conversation)) return;
  dispatch<AiAccessUpdatedDetail>(AI_ACCESS_UPDATED_EVENT, {
    sessionId: conversation.legacy_session_id?.trim() || conversation.id,
    conversationId: conversation.id,
    aiAccess: normalizeAiAccess(conversation.ai_access),
  });
}

export function onAgentActionUpdated(listener: (detail: AgentActionUpdatedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handle = (event: Event) => listener((event as CustomEvent<AgentActionUpdatedDetail>).detail);
  window.addEventListener(AGENT_ACTION_UPDATED_EVENT, handle);
  return () => window.removeEventListener(AGENT_ACTION_UPDATED_EVENT, handle);
}

export function onAiAccessUpdated(listener: (detail: AiAccessUpdatedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handle = (event: Event) => listener((event as CustomEvent<AiAccessUpdatedDetail>).detail);
  window.addEventListener(AI_ACCESS_UPDATED_EVENT, handle);
  return () => window.removeEventListener(AI_ACCESS_UPDATED_EVENT, handle);
}
