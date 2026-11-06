import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CloudAuthClient } from './authClient';
import type {
  CloudPendingGroupInvitation,
  CloudPendingGroupInvitationAcceptance,
} from './cloudIdentityTypes';
import { dispatchCloudGroupInvitationAccepted } from './groupInvitationDeepLink';

/** Focus and visibility refreshes run at most this often; launch and sign-in always fetch. */
export const PENDING_GROUP_INVITATION_REFRESH_MS = 3 * 60_000;

export type GroupInvitationPromptClient = Pick<
  CloudAuthClient,
  | 'resolveGroupInvitation'
  | 'acceptGroupInvitation'
  | 'claimGroupInvitation'
  | 'listPendingGroupInvitations'
  | 'acceptPendingGroupInvitation'
  | 'dismissPendingGroupInvitation'
>;

export type LoadSessionToken = () => Promise<string | null>;

export type ServerPendingGroupInvitations = {
  invitations: CloudPendingGroupInvitation[];
  newest: CloudPendingGroupInvitation | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  accept: (invitation: CloudPendingGroupInvitation) => Promise<CloudPendingGroupInvitationAcceptance>;
  dismiss: (invitation: Pick<CloudPendingGroupInvitation, 'id' | 'invitationId'>) => void;
};

/**
 * Keeps the signed-in account's unanswered group invitations. Fetches are
 * best-effort: a failed request keeps the current list and stays silent.
 * Items dropped locally (joined or dismissed) never come back this session,
 * even when the server still lists them because a DELETE failed. Remount
 * (key by account) to start over for another account.
 */
export function useServerPendingGroupInvitations({
  enabled,
  client,
  loadToken,
  throttleMs = PENDING_GROUP_INVITATION_REFRESH_MS,
}: {
  enabled: boolean;
  client: GroupInvitationPromptClient;
  loadToken: LoadSessionToken;
  throttleMs?: number;
}): ServerPendingGroupInvitations {
  const [invitations, setInvitations] = useState<CloudPendingGroupInvitation[]>([]);
  const droppedRef = useRef(new Set<string>());
  const lastFetchAtRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const isDropped = useCallback((invitation: CloudPendingGroupInvitation) => (
    droppedRef.current.has(`id:${invitation.id}`)
    || droppedRef.current.has(`invitation:${invitation.invitationId}`)
  ), []);

  const refresh = useCallback(({ force = false }: { force?: boolean } = {}): Promise<void> => {
    if (!enabledRef.current) return Promise.resolve();
    const now = Date.now();
    if (!force && lastFetchAtRef.current !== null && now - lastFetchAtRef.current < throttleMs) {
      return Promise.resolve();
    }
    lastFetchAtRef.current = now;
    const request = ++requestRef.current;
    return loadToken()
      .then((token) => (token ? client.listPendingGroupInvitations(token) : null))
      .then((list) => {
        if (!list || request !== requestRef.current || !enabledRef.current) return;
        setInvitations(list.filter((invitation) => !isDropped(invitation)));
      })
      // Best-effort: the next launch, sign-in or focus tries again.
      .catch(() => undefined);
  }, [client, isDropped, loadToken, throttleMs]);

  const drop = useCallback((invitation: Pick<CloudPendingGroupInvitation, 'id' | 'invitationId'>) => {
    droppedRef.current.add(`id:${invitation.id}`);
    if (invitation.invitationId) droppedRef.current.add(`invitation:${invitation.invitationId}`);
    // A fetch already in flight must not bring the dropped item back.
    requestRef.current += 1;
    setInvitations((current) => current.filter((candidate) => !isDropped(candidate)));
  }, [isDropped]);

  const accept = useCallback(async (invitation: CloudPendingGroupInvitation) => {
    const token = await loadToken();
    if (!token) throw new Error('Sign in to join this group.');
    const result = await client.acceptPendingGroupInvitation(token, invitation.id);
    dispatchCloudGroupInvitationAccepted({
      groupId: result.groupId,
      groupSpaceId: result.groupSpaceId,
      groupTitle: result.groupTitle,
    });
    drop(invitation);
    return result;
  }, [client, drop, loadToken]);

  const dismiss = useCallback((invitation: Pick<CloudPendingGroupInvitation, 'id' | 'invitationId'>) => {
    drop(invitation);
    void loadToken()
      .then((token) => (token ? client.dismissPendingGroupInvitation(token, invitation.id) : undefined))
      .catch(() => undefined);
  }, [client, drop, loadToken]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh({ force: true });
    if (typeof window === 'undefined') return undefined;
    const onFocus = () => { void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, refresh]);

  return useMemo(() => ({
    invitations,
    newest: invitations[0] ?? null,
    refresh,
    accept,
    dismiss,
  }), [accept, dismiss, invitations, refresh]);
}
