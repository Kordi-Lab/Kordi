import type { Dispatch, SetStateAction } from 'react';

import type { CanonicalSessionState } from '@/kordi-app/types';

import type { CloudAccount, CloudAuthClient } from './authClient';
import type { CloudSessionPinsById } from './cloudDiffSync';
import { useCanonicalActiveSessionRead } from './useCanonicalActiveSessionRead';
import { useCloudActiveSessionPin } from './useCloudActiveSessionPin';

export function useCloudActiveSessionLifecycle({
  account,
  activeConversationId,
  canonicalState,
  setCanonicalState,
  client,
  setPinsBySessionId,
}: {
  account: CloudAccount | null;
  activeConversationId?: string | null;
  canonicalState?: CanonicalSessionState | null;
  setCanonicalState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  client: CloudAuthClient;
  setPinsBySessionId: Dispatch<SetStateAction<CloudSessionPinsById>>;
}) {
  useCanonicalActiveSessionRead({
    account,
    activeConversationId,
    canonicalState,
    setCanonicalState,
  });
  useCloudActiveSessionPin({
    account,
    activeConversationId,
    client,
    setPinsBySessionId,
  });
}
