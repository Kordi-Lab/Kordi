import type { CanonicalSessionState } from '@/kordi-app/types';

/** Where a session route change is recorded: the session's conversation kind and its active human members. */
export function cloudAgentRuntimeRouteMessageTarget(
  canonicalSessionState: CanonicalSessionState | null | undefined,
  sessionId: string,
): { conversationKind: 'group' | 'direct' | 'ai'; memberAccountIds: string[] } {
  const session = canonicalSessionState?.sessions.find((candidate) => candidate.id === sessionId);
  const conversationKind = session?.kind === 'group'
    ? 'group'
    : session?.kind === 'direct-person' || session?.kind === 'relationship'
      ? 'direct'
      : 'ai';
  const memberAccountIds = canonicalSessionState
    ? canonicalSessionState.participants
      .filter((participant) => participant.sessionId === sessionId && participant.state === 'active')
      .flatMap((participant) => {
        const identity = canonicalSessionState.identities.find(
          (candidate) => candidate.id === participant.identityId,
        );
        if (!identity || identity.kind !== 'human') return [];
        const memberAccountId = identity.humanId?.trim() || identity.sourceIdentityId?.trim() || '';
        return memberAccountId ? [memberAccountId] : [];
      })
    : [];
  return { conversationKind, memberAccountIds };
}
