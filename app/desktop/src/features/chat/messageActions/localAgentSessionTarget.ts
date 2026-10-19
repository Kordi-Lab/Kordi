import type { CanonicalSessionState, ComposerQuoteState, DesktopChatState } from '@/kordi-app/types';
import { fetchDesktopChatState } from '@/lib/desktop';
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

export const AGENT_SESSION_NOT_ON_THIS_MAC_DETAIL =
  'This Agent chat has no history on this Mac. Choose a Kordi Cloud model to continue it here, or start a new chat.';

/**
 * Loads the target session's runtime transcript before a send.
 *
 * A session synced from another device has no runtime transcript on this Mac,
 * and the runtime then answers with a different session. A Kordi Cloud request
 * does not use the local transcript, so it continues without one. A local
 * turn would lose its history, so it fails with a reason the person can act on.
 */
export async function fetchMaterializedLocalChatTarget(
  sessionId: string,
  currentState: DesktopChatState | null,
  { runsOnKordiCloud = false, fetchState = fetchDesktopChatState }: {
    runsOnKordiCloud?: boolean;
    fetchState?: (sessionId: string) => Promise<DesktopChatState | null>;
  } = {},
) {
  const currentRuntimeMatches = currentState?.activeSessionId === sessionId
    && currentState.activeSession.id === sessionId;
  if (currentRuntimeMatches) return null;
  const materializedState = await fetchState(sessionId);
  if (
    !materializedState
    || materializedState.activeSessionId !== sessionId
    || materializedState.activeSession.id !== sessionId
  ) {
    if (runsOnKordiCloud) return null;
    throw new Error(AGENT_SESSION_NOT_ON_THIS_MAC_DETAIL);
  }
  return materializedState;
}
