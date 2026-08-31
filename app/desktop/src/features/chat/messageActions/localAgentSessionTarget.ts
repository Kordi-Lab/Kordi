import type { CanonicalSessionState, ComposerQuoteState, DesktopChatState } from '@/kordi-app/types';
import { fetchDesktopChatState } from '@/lib/desktop';
import type { AttachmentItem } from '../composerController.types';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '../draftSessions';
import { appendOptimisticOutboundMessage } from './optimistic';

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

export async function fetchMaterializedLocalChatTarget(
  sessionId: string,
  currentState: DesktopChatState | null,
) {
  const currentRuntimeMatches = currentState?.activeSessionId === sessionId
    && currentState.activeSession.id === sessionId;
  if (currentRuntimeMatches) return null;
  const materializedState = await fetchDesktopChatState(sessionId);
  if (
    !materializedState
    || materializedState.activeSessionId !== sessionId
    || materializedState.activeSession.id !== sessionId
  ) {
    throw new Error('Unable to load that Agent session. Try again.');
  }
  return materializedState;
}
