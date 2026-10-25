import { useCallback } from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';

type ForkResult = {
  forkedSessionId: string;
  sourceSessionId: string;
  sourceMessageId: string;
};

type RecordCloudSessionFork = (
  ...args: Parameters<UseCloudCollaborationStateResult['recordCloudSessionFork']>
) => ReturnType<UseCloudCollaborationStateResult['recordCloudSessionFork']>;

/**
 * Runs after the Mac writes a fork. The catalog refresh loads the new fork's
 * session record, whose fork metadata marks the inherited rows and draws the
 * "Forked from conversation" line; without it the fork shows plain runtime
 * rows until some later refresh.
 */
export async function syncCreatedFork(
  result: ForkResult,
  {
    account,
    recordCloudSessionFork,
    refreshCanonicalState,
  }: {
    account: CloudAccount | null;
    recordCloudSessionFork: RecordCloudSessionFork;
    refreshCanonicalState: () => Promise<void>;
  },
) {
  await refreshCanonicalState().catch(() => undefined);
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
}

export function useKordiCloudAgentFork({
  account,
  recordCloudSessionFork,
  refreshCanonicalState,
}: {
  account: CloudAccount | null;
  recordCloudSessionFork: RecordCloudSessionFork;
  refreshCanonicalState: () => Promise<void>;
}) {
  return useCallback((result: ForkResult) => syncCreatedFork(result, {
    account,
    recordCloudSessionFork,
    refreshCanonicalState,
  }), [account, recordCloudSessionFork, refreshCanonicalState]);
}
