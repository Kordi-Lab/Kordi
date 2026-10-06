import type { Dispatch, SetStateAction } from 'react';
import type { CanonicalSessionCatalog, CanonicalSessionState } from '@/kordi-app/types';
import { createDesktopChatSession, fetchCanonicalSessionCatalog, openOrCreateCanonicalSessionFast } from '@/lib/desktop';
import { ownedAgentIdentityId } from './agentMessageLifecycle';

/** Publish the newly materialized chat to the send/forward state together. */
export async function materializeLocalChatSession(
  setCanonicalState: Dispatch<SetStateAction<CanonicalSessionState | null>>,
) {
  const desktopState = await createDesktopChatSession();
  // DesktopChatState does not update the frontend catalog. Native sync also
  // deliberately omits blank sessions; the first send must create that shell.
  // A message without its session is invisible to forwarding until a refresh.
  const catalog = await fetchCanonicalSessionCatalog();
  if (!catalog) {
    throw new Error('Unable to prepare the new chat. Try again.');
  }
  let session = catalog.sessions.find(item => item.id === desktopState.activeSessionId);
  let participants = catalog.participants.filter(item => item.sessionId === desktopState.activeSessionId);
  if (!session) {
    const primaryIdentityId = ownedAgentIdentityId({ ...catalog, messages: [], contextSnapshots: [] }, catalog.profile.activeAgentIdentityId);
    if (!catalog.profile.humanIdentityId || !primaryIdentityId) {
      throw new Error('Unable to prepare the new chat. Try again.');
    }
    const created = await openOrCreateCanonicalSessionFast({
      id: desktopState.activeSessionId, kind: 'self-agent', title: desktopState.activeSession.title, status: 'active',
      createdByIdentityId: catalog.profile.humanIdentityId, primaryIdentityId, participantIdentityIds: [primaryIdentityId],
      metadata: { source: 'desktop-chat-detail' },
    });
    session = created.session;
    participants = created.participants;
  }
  publishCatalogSession(setCanonicalState, catalog, session, participants);
  return desktopState;
}

/**
 * A side-panel chat is created natively (its canonical row is written by the
 * side-session command), but the frontend catalog is not refreshed. The cloud
 * forward sync only forwards messages of sessions in that catalog, so publish
 * the row before the first send instead of waiting for a reload.
 */
export async function ensureLocalChatSessionInCanonicalState(
  sessionId: string,
  currentState: CanonicalSessionState | null,
  setCanonicalState: Dispatch<SetStateAction<CanonicalSessionState | null>>,
) {
  if (currentState?.sessions.some(item => item.id === sessionId)) return;
  const catalog = await fetchCanonicalSessionCatalog();
  const session = catalog?.sessions.find(item => item.id === sessionId);
  if (!catalog || !session) return;
  publishCatalogSession(setCanonicalState, catalog, session, catalog.participants.filter(item => item.sessionId === sessionId));
}

function publishCatalogSession(
  setCanonicalState: Dispatch<SetStateAction<CanonicalSessionState | null>>,
  catalog: CanonicalSessionCatalog,
  session: CanonicalSessionCatalog['sessions'][number],
  participants: CanonicalSessionCatalog['participants'],
) {
  setCanonicalState(current => {
    const base = current ?? { ...catalog, messages: [], contextSnapshots: [] };
    const identityIds = new Set(base.identities.map(identity => identity.id));
    return {
      ...base,
      identities: [...base.identities, ...catalog.identities.filter(identity => !identityIds.has(identity.id))],
      sessions: [session, ...base.sessions.filter(item => item.id !== session.id)],
      participants: [...base.participants.filter(item => item.sessionId !== session.id), ...participants],
    };
  });
}
