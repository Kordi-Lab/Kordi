import { useCallback } from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';

type ForkResult = {
  forkedSessionId: string;
  sourceSessionId: string;
  sourceMessageId: string;
};

export function useKordiCloudAgentFork({
  account,
  recordCloudSessionFork,
}: {
  account: CloudAccount | null;
  recordCloudSessionFork: (
    ...args: Parameters<UseCloudCollaborationStateResult['recordCloudSessionFork']>
  ) => ReturnType<UseCloudCollaborationStateResult['recordCloudSessionFork']>;
}) {
  return useCallback(async (result: ForkResult) => {
    if (!account) return;
    await recordCloudSessionFork({
      sourceSessionId: result.sourceSessionId,
      forkSessionId: result.forkedSessionId,
      parentMessageId: result.sourceMessageId,
    }).catch((error) => {
      if (
        error
        && typeof error === 'object'
        && 'status' in error
        && (error as { status?: number }).status === 409
      ) return;
      // The local Agent fork remains usable and can retry Cloud lineage later.
    });
  }, [account, recordCloudSessionFork]);
}
