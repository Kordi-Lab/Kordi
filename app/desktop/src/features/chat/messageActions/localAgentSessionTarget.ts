import type { CanonicalSessionState, ComposerQuoteState, DesktopChatState } from '@/kordi-app/types';
import { fetchDesktopChatSessionDetail, fetchDesktopChatState } from '@/lib/desktop';
import type { AttachmentItem } from '../composerController.types';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '../draftSessions';
import { appendOptimisticOutboundMessage } from './optimistic';
import type { ResolvedMentionedCollaborationTarget } from './types';

export function isOwnedAgentMention(target: ResolvedMentionedCollaborationTarget | null, localAgentMentioned: boolean) {
  if (!target) return localAgentMentioned;
  const owner = target.peer.humanId?.trim() || target.peer.nodeId?.trim();
  const localOwner = target.host.humanId?.trim() || target.host.nodeId?.trim();
  return target.targetKind === 'agent' && Boolean(
    (owner && localOwner && owner === localOwner)
    || (target.peer.agentId && target.host.agents.some(agent => agent.id === target.peer.agentId)),
  );
}

export function appendOptimisticLocalDraftMessage(
  current: DesktopChatState | null,
  previewText: string,
  text: string,
  attachments: AttachmentItem[],
  sentAt: string,
  quote: ComposerQuoteState | null | undefined,
) {
  return current
    ? appendOptimisticOutboundMessage(current, LOCAL_DRAFT_CHAT_CONVERSATION_ID, previewText, text, attachments, sentAt, [], quote ?? null)
    : current;
}

export function generatedSelfAgentSessionId() {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `session:self-agent:${randomId}`;
}

export function shouldUseNoProviderSelfAgentShortcut({
  activeConversationUsesCollaborationRouting,
  activeConvCanonicalSessionId,
  canonicalSessionState,
  hasAnyDesktopAuth,
}: {
  activeConversationUsesCollaborationRouting: boolean;
  activeConvCanonicalSessionId?: string | null;
  canonicalSessionState: CanonicalSessionState | null;
  hasAnyDesktopAuth: boolean;
}) {
  if (hasAnyDesktopAuth || activeConversationUsesCollaborationRouting) return false;
  const sessionId = activeConvCanonicalSessionId?.trim();
  if (!sessionId) return true;
  const session = canonicalSessionState?.sessions.find((candidate) => candidate.id === sessionId);
  return !session || session.kind === 'self-agent';
}

function isTargetChatState(state: DesktopChatState | null, sessionId: string): state is DesktopChatState {
  return Boolean(state && state.activeSessionId === sessionId && state.activeSession.id === sessionId);
}

/**
 * The runtime state of the session a send targets, or null when this Mac
 * cannot open a runtime copy of it. A session this profile never stored (one
 * synced or migrated from another Mac) falls back to another session in the
 * chat state until it is opened, so it is opened first, as selecting it does.
 * Another session's state is never returned as the target's, and a session
 * that cannot be opened does not stop the send: its own reply or failure
 * shows on the message, never in the sidebar.
 */
export async function fetchMaterializedLocalChatTarget(
  sessionId: string,
  currentState: DesktopChatState | null,
  readState: (sessionId: string) => Promise<DesktopChatState | null> = fetchDesktopChatState,
  openSession: (sessionId: string) => Promise<unknown> = fetchDesktopChatSessionDetail,
) {
  if (isTargetChatState(currentState, sessionId)) return null;
  try {
    const materializedState = await readState(sessionId);
    if (isTargetChatState(materializedState, sessionId)) return materializedState;
    await openSession(sessionId);
    const openedState = await readState(sessionId);
    return isTargetChatState(openedState, sessionId) ? openedState : null;
  } catch {
    return null;
  }
}
