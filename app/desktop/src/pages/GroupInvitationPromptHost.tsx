import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { defaultCloudAuthClient, type CloudGroupInvitationAcceptance } from '@/features/cloud/authClient';
import type { CloudPendingGroupInvitation } from '@/features/cloud/cloudIdentityTypes';
import { dispatchCloudGroupInvitationAccepted } from '@/features/cloud/groupInvitationDeepLink';
import { setGroupInvitationPromptBusy } from '@/features/cloud/groupInvitationPromptPresence';
import { loadSession } from '@/features/cloud/session';
import {
  useServerPendingGroupInvitations,
  type GroupInvitationPromptClient,
  type LoadSessionToken,
} from '@/features/cloud/useServerPendingGroupInvitations';
import { GroupInvitationDialog } from '@/pages/GroupInvitationDialog';

type DeepLinkInvitation = { token: string | null; dismiss: () => void };

type DeepLinkClaim = { token: string; result: Promise<CloudPendingGroupInvitation | null> };

async function loadSessionToken() {
  return (await loadSession())?.token ?? null;
}

/**
 * Shows at most one group invitation prompt for the signed-in account. A
 * deep-link token wins; otherwise the newest invitation the server keeps for
 * this account (claimed on the web, or from an earlier deep link). Mount it
 * only while signed in: a token that arrived signed out waits in storage and
 * is claimed here after sign-in, so it also survives a reinstall. Key it by
 * account so another account starts with a fresh list.
 */
export function GroupInvitationPromptHost({
  deepLink,
  visible,
  client: injectedClient,
  loadToken = loadSessionToken,
  throttleMs,
}: {
  deepLink: DeepLinkInvitation;
  visible: boolean;
  client?: GroupInvitationPromptClient;
  loadToken?: LoadSessionToken;
  throttleMs?: number;
}) {
  const client = useMemo(() => injectedClient ?? defaultCloudAuthClient(), [injectedClient]);
  const server = useServerPendingGroupInvitations({ enabled: true, client, loadToken, throttleMs });
  const claimRef = useRef<DeepLinkClaim | null>(null);
  const [settlingDeepLink, setSettlingDeepLink] = useState(false);
  const token = deepLink.token;
  const dismissDeepLink = deepLink.dismiss;

  useEffect(() => {
    if (!token || claimRef.current?.token === token) return;
    // Best-effort: already_member, rate limits and network errors are ignored.
    const result = loadToken()
      .then((sessionToken) => (sessionToken ? client.claimGroupInvitation(sessionToken, token) : null))
      .then((claim) => claim?.pending ?? null)
      .catch(() => null);
    claimRef.current = { token, result };
  }, [client, loadToken, token]);

  const { dismiss: dismissServer, refresh: refreshServer } = server;
  const closeDeepLink = useCallback(() => {
    const claim = claimRef.current;
    claimRef.current = null;
    setSettlingDeepLink(true);
    dismissDeepLink();
    // The token join does not resolve the server copy of the same invitation,
    // so answer it here; otherwise it would pop up again from the pending list.
    void (claim?.result ?? Promise.resolve(null))
      .then((pending) => { if (pending) dismissServer(pending); })
      .then(() => refreshServer({ force: true }))
      .finally(() => setSettlingDeepLink(false));
  }, [dismissDeepLink, dismissServer, refreshServer]);

  const onDeepLinkJoined = useCallback((result: CloudGroupInvitationAcceptance) => {
    dispatchCloudGroupInvitationAccepted(result);
    closeDeepLink();
  }, [closeDeepLink]);

  // While a deep link shows, the server list may already hold the same
  // invitation; the deep link wins and its server copy is answered on close.
  const newest = server.newest;
  const { accept: acceptServer } = server;
  const dismissNewest = useCallback(() => {
    if (newest) dismissServer(newest);
  }, [dismissServer, newest]);
  const onPendingJoined = useCallback(() => undefined, []);

  // First-run help waits for the first invitation check and for any prompt.
  const busy = visible && (Boolean(token) || settlingDeepLink || !server.settled || Boolean(newest));
  useLayoutEffect(() => {
    setGroupInvitationPromptBusy(busy);
  }, [busy]);
  useLayoutEffect(() => () => setGroupInvitationPromptBusy(false), []);

  if (!visible) return null;
  if (token) {
    return (
      <GroupInvitationDialog
        key={`token:${token}`}
        invitationToken={token}
        client={injectedClient}
        loadToken={loadToken}
        onDismiss={closeDeepLink}
        onJoined={onDeepLinkJoined}
      />
    );
  }
  if (settlingDeepLink || !newest) return null;
  return (
    <GroupInvitationDialog
      key={`pending:${newest.id}`}
      pendingInvitation={newest}
      onAcceptPending={acceptServer}
      onDismiss={dismissNewest}
      onJoined={onPendingJoined}
    />
  );
}
