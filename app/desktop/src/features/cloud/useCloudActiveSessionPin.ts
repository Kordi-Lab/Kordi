import {
  useEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {
  CloudAccount,
  CloudAuthClient,
} from './authClient';
import {
  cloudSessionIdFromConversationId,
} from './cloudCollaborationState';
import type {
  CloudSessionPinsById,
} from './cloudDiffSync';
import {
  loadSession,
} from './session';

export function useCloudActiveSessionPin({
  account,
  activeConversationId,
  client,
  setPinsBySessionId,
}: {
  account: CloudAccount | null;
  activeConversationId: string | null | undefined;
  client: CloudAuthClient;
  setPinsBySessionId: Dispatch<
    SetStateAction<CloudSessionPinsById>
  >;
}) {
  const activePinSessionId = useMemo(() => {
    const fromConversation = activeConversationId
      ? cloudSessionIdFromConversationId(activeConversationId)
      : null;
    const trimmedActive = activeConversationId?.trim() ?? '';
    return fromConversation
      || (trimmedActive.startsWith('session:')
        ? trimmedActive
        : null);
  }, [activeConversationId]);

  useEffect(() => {
    if (!account || !activePinSessionId) return;
    let cancelled = false;
    void loadSession()
      .then(async (session) => {
        if (!session?.token) return null;
        return client.getCloudSessionPin(
          session.token,
          activePinSessionId,
        );
      })
      .then((pin) => {
        if (cancelled || !pin) return;
        setPinsBySessionId((current) => ({
          ...current,
          [pin.sessionId]: pin,
        }));
      })
      .catch(() => {
        // Best effort. Cursor sync also applies pin updates.
      });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    activePinSessionId,
    client,
    setPinsBySessionId,
  ]);
}
