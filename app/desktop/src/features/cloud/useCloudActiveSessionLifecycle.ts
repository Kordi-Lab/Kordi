import type { Dispatch, SetStateAction } from 'react';

import type { CanonicalSessionState } from '@/kordi-app/types';

import type { CloudAccount, CloudAuthClient } from './authClient';
import type { CloudSessionPinsById } from './cloudDiffSync';
import { useCanonicalActiveSessionRead } from './useCanonicalActiveSessionRead';
import { useCloudActiveSessionPin } from './useCloudActiveSessionPin';

export function useCloudActiveSessionLifecycle({
  account,
  activeConversationId,
  canMarkActiveConversationRead,
  canonicalState,
  setCanonicalState,
  client,
  markRead,
  setPinsBySessionId,
}: {
  account: CloudAccount | null;
  activeConversationId?: string | null;
  canMarkActiveConversationRead: boolean;
  canonicalState?: CanonicalSessionState | null;
  setCanonicalState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  client: CloudAuthClient;
  markRead: (sessionIds: string[]) => Promise<void>;
  setPinsBySessionId: Dispatch<SetStateAction<CloudSessionPinsById>>;
}) {
  useCanonicalActiveSessionRead({
    account,
    activeConversationId,
    canMarkActiveConversationRead,
    canonicalState,
    markRead,
    setCanonicalState,
  });
  useCloudActiveSessionPin({
    account,
    activeConversationId,
    client,
    setPinsBySessionId,
  });
}
