import { useCallback } from 'react';
import type { MutableRefObject } from 'react';

import type { Contact } from '@/kordi-app/types';

import type { CloudAccount, CloudMessage } from './authClient';
import { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { mergeCloudMessagesByPeerSnapshot } from './cloudMessageSyncState';
import type { CloudFallbackRunClaimer } from './useCloudAgentAvailability';

export function useCloudFreshGroupFallbackClaim({
  account,
  contacts,
  messagesByPeerRef,
  claimFallbackRun,
}: {
  account: CloudAccount | null;
  contacts: Contact[];
  messagesByPeerRef: MutableRefObject<Record<string, CloudMessage[]>>;
  claimFallbackRun: CloudFallbackRunClaimer;
}) {
  return useCallback(async (
    sentMessages: readonly CloudMessage[],
    requestMessageId: string,
    token: string,
  ) => {
    if (!account || sentMessages.length === 0 || !requestMessageId.trim()) {
      return;
    }
    const incomingByPeer: Record<string, CloudMessage[]> = {};
    for (const sentMessage of sentMessages) {
      const message = cloudMessageMetadataOnly(sentMessage);
      const peerId = message.fromAccountId === account.accountId
        ? message.toAccountId
        : message.fromAccountId;
      if (!peerId) continue;
      incomingByPeer[peerId] = [
        ...(incomingByPeer[peerId] ?? []),
        message,
      ];
    }
    const latestMessagesByPeer = mergeCloudMessagesByPeerSnapshot(
      messagesByPeerRef.current,
      incomingByPeer,
    );
    messagesByPeerRef.current = latestMessagesByPeer;
    const exactClaims = cloudFallbackRunClaimsForMessages({
      account,
      contacts,
      messagesByPeer: latestMessagesByPeer,
    }).filter((claim) => claim.requestMessageId === requestMessageId);
    await Promise.all(
      exactClaims.map((claim) => claimFallbackRun(claim, token)),
    );
  }, [
    account,
    claimFallbackRun,
    contacts,
    messagesByPeerRef,
  ]);
}
