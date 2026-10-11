import { useSyncExternalStore } from 'react';

import {
  getLocalAgentAvatar,
  SIGNED_OUT_LOCAL_AGENT_AVATAR,
  subscribeLocalAgentAvatar,
} from '@/features/canonical/localAgentAvatar';

/** The signed-in account's default agent avatar, or the local fallback when signed out. */
export function useLocalAgentAvatar() {
  return useSyncExternalStore(subscribeLocalAgentAvatar, getLocalAgentAvatar, () => SIGNED_OUT_LOCAL_AGENT_AVATAR);
}
