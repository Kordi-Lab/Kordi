import { mergePinSnapshot, mergePinSyncSnapshot } from './cloudPinHistory';
import {
  useEffect, useCallback, useLayoutEffect, useRef,
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
  pinsBySessionId,
}: {
  account: CloudAccount | null;
  activeConversationId: string | null | undefined;
  client: CloudAuthClient;
  pinsBySessionId: CloudSessionPinsById;
  setPinsBySessionId: Dispatch<
    SetStateAction<CloudSessionPinsById>
  >;
}) {
  const currentAccount = useRef(account?.accountId);
  const pins = useRef(pinsBySessionId);
  useLayoutEffect(() => { currentAccount.current = account?.accountId; pins.current = pinsBySessionId; });
  const preparePin = useCallback(async (conversationId: string) => {
    const sessionId = cloudSessionIdFromConversationId(conversationId)
      || (conversationId.startsWith('session:') ? conversationId : null);
    if (!account || !sessionId || pins.current[sessionId]) return;
    const session = await loadSession();
    if (!session?.token || session.accountId !== account.accountId) return;
    const pin = await client.getCloudSessionPinState(session.token, sessionId);
    if (currentAccount.current !== account.accountId || pins.current[sessionId]) return;
    pins.current = { ...pins.current, [pin.sessionId]: mergePinSnapshot(pins.current[pin.sessionId], pin) };
    setPinsBySessionId(current => ({ ...current, [pin.sessionId]: mergePinSnapshot(current[pin.sessionId], pin) }));
  }, [account, client, setPinsBySessionId]);
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
    const baseline = pins.current;
    let cancelled = false;
    const controller = new AbortController();
    void loadSession()
      .then(async (session) => {
        if (!session?.token || session.accountId !== account.accountId) return null;
        return client.getCloudSessionPin(
          session.token,
          activePinSessionId,
          controller.signal,
        );
      })
      .then((pin) => {
        if (cancelled || !pin) return;
        setPinsBySessionId(current => mergePinSyncSnapshot(current, { [pin.sessionId]: pin }, baseline));
      })
      .catch(() => {
        // Best effort. Cursor sync also applies pin updates.
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    account,
    activePinSessionId,
    client,
    setPinsBySessionId,
  ]);
  return preparePin;
}
