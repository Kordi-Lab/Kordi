import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CloudAccount, CloudMessage } from './authClient';
import {
  buildCloudMessageIndex,
  type CloudMessageIndex,
} from './cloudMessageIndex';
import type { CloudCollaborationMessageStore } from './useCloudCollaborationStores';

const EMPTY_CLOUD_MESSAGES_BY_PEER: Record<string, CloudMessage[]> = {};

type AccountMessageState = {
  accountId: string | null;
  messagesByPeer: Record<string, CloudMessage[]>;
};

export function useCloudCollaborationMessageStore(
  account: CloudAccount | null,
): CloudCollaborationMessageStore {
  const [messageState, setMessageState] = useState<AccountMessageState>({
    accountId: null,
    messagesByPeer: {},
  });
  const messagesByPeer = messageState.messagesByPeer;
  const setMessagesByPeer = useCallback<
    CloudCollaborationMessageStore['setValue']
  >((update) => {
    setMessageState((current) => ({
      accountId: account?.accountId ?? null,
      messagesByPeer: typeof update === 'function'
        ? update(current.messagesByPeer)
        : update,
    }));
  }, [account?.accountId]);
  const cacheAccountRef = useRef<string | null>(null);
  const hydratedCacheAccountRef = useRef<string | null>(null);
  const peerReadAtByPeerRef = useRef<Record<string, string>>({});
  const belongsToCurrentAccount = Boolean(
    account?.accountId && messageState.accountId === account.accountId,
  );
  const currentAccountMessagesByPeer = belongsToCurrentAccount
    ? messagesByPeer
    : EMPTY_CLOUD_MESSAGES_BY_PEER;
  const indexRef = useRef<CloudMessageIndex>(null!);
  const index = useMemo(
    () => buildCloudMessageIndex(
      account?.accountId ?? null,
      currentAccountMessagesByPeer,
    ),
    [account?.accountId, currentAccountMessagesByPeer],
  );
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  const valueRef = useRef<Record<string, CloudMessage[]>>({});

  return {
    value: messagesByPeer,
    setValue: setMessagesByPeer,
    valueRef,
    currentAccountValue: currentAccountMessagesByPeer,
    belongsToCurrentAccount,
    index,
    indexRef,
    cacheAccountRef,
    hydratedCacheAccountRef,
    peerReadAtByPeerRef,
  };
}
