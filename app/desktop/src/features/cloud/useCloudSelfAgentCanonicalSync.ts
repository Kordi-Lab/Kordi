import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import type { CloudSessionTitlesById } from './cloudDiffSync';
import {
  mergeCloudSelfAgentCanonicalSyncBatch,
  removeCanonicalMessagesById,
} from './cloudCanonicalStateMerge';
import {
  planCloudSelfAgentCanonicalSync,
} from './cloudSelfAgentCanonicalSync';
import {
  cloudSelfAgentCanonicalSyncPlanSignature,
  persistCloudSelfAgentCanonicalSyncPlan,
} from './cloudSelfAgentCanonicalSyncExecution';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { pruneCanonicalLegacyCloudSelfMessageDuplicates } from './cloudSelfAgentDesktopPersistence';

function stableRecordRevision<T>(record: Record<string, T>) {
  return JSON.stringify(
    Object.entries(record).sort(([left], [right]) => (
      left.localeCompare(right)
    )),
  );
}

export function useCloudSelfAgentCanonicalSync({
  account,
  canonicalState,
  setCanonicalState,
  messagesByPeer,
  messageIndex,
  forksBySessionId,
  titlesBySessionId,
  initialMessagesSettled,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null | undefined;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  messagesByPeer: Record<string, CloudMessage[]>;
  messageIndex: CloudMessageIndex;
  forksBySessionId: Record<string, CloudSessionForkSummary>;
  titlesBySessionId: CloudSessionTitlesById;
  initialMessagesSettled: boolean;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const accountId = account?.accountId ?? null;
  const selfMessagesRevision = accountId
    ? messageIndex.peerRevisionByPeerId.get(accountId) ?? '0::'
    : '0::';
  const forksRevision = useMemo(
    () => stableRecordRevision(forksBySessionId),
    [forksBySessionId],
  );
  const titlesRevision = useMemo(
    () => stableRecordRevision(titlesBySessionId),
    [titlesBySessionId],
  );
  const latestInputRef = useRef({
    account,
    canonicalState,
    setCanonicalState,
    messagesByPeer,
    messageIndex,
    forksBySessionId,
    titlesBySessionId,
    initialMessagesSettled,
    reportWarning,
  });
  const mountedRef = useRef(true);
  const inFlightRef = useRef<{
    accountId: string;
    signature: string;
  } | null>(null);
  const completedRef = useRef<{
    accountId: string;
    signature: string;
  } | null>(null);
  const repairInFlightRef = useRef<string | null>(null);
  const completedRepairRef = useRef<string | null>(null);
  const failedRepairRef = useRef<string | null>(null);
  const [followUpRevision, requestFollowUp] = useReducer(
    (revision: number) => revision + 1,
    0,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    latestInputRef.current = {
      account,
      canonicalState,
      setCanonicalState,
      messagesByPeer,
      messageIndex,
      forksBySessionId,
      titlesBySessionId,
      initialMessagesSettled,
      reportWarning,
    };
  }, [
    account,
    canonicalState,
    forksBySessionId,
    initialMessagesSettled,
    messageIndex,
    messagesByPeer,
    reportWarning,
    setCanonicalState,
    titlesBySessionId,
  ]);

  useEffect(() => {
    const input = latestInputRef.current;
    const currentAccount = input.account;
    if (
      !currentAccount
      || !input.canonicalState
      || !input.setCanonicalState
      || !input.initialMessagesSettled
    ) return;
    const selfMessages =
      input.messagesByPeer[currentAccount.accountId] ?? [];
    // A large restore can take many native calls. Unrelated renders must not
    // rebuild and re-sort the same plan while that persistence is in flight.
    if (inFlightRef.current) return;
    if (selfMessages.length > 0) {
      const plan = planCloudSelfAgentCanonicalSync({
        account: currentAccount,
        messages: selfMessages,
        state: input.canonicalState,
        forksBySessionId: input.forksBySessionId,
        groupRowByWireMessageId:
          input.messageIndex.groupRowByWireMessageId,
        cloudTitlesBySessionId: input.titlesBySessionId,
      });
      const hasPendingWrites = plan.sessionRequests.length > 0
        || plan.messageRequests.length > 0;
      const signature = hasPendingWrites
        ? cloudSelfAgentCanonicalSyncPlanSignature(plan)
        : null;
      const alreadyCompleted = signature !== null
        && completedRef.current?.accountId === currentAccount.accountId
        && completedRef.current.signature === signature;
      if (signature && !alreadyCompleted) {
        const syncingAccountId = currentAccount.accountId;
        inFlightRef.current = { accountId: syncingAccountId, signature };
        void persistCloudSelfAgentCanonicalSyncPlan(plan, {
          shouldContinue: () => (
            mountedRef.current
            && latestInputRef.current.account?.accountId === syncingAccountId
          ),
        }).then((batch) => {
          if (
            !batch
            || !mountedRef.current
            || latestInputRef.current.account?.accountId !== syncingAccountId
          ) return;
          completedRef.current = { accountId: syncingAccountId, signature };
          latestInputRef.current.setCanonicalState?.((current) => (
            mergeCloudSelfAgentCanonicalSyncBatch(current, batch)
          ));
        }).catch((error) => {
          latestInputRef.current.reportWarning(
            '[cloud-self-agent-sync] failed to materialize cloud session locally',
            error,
          );
        }).finally(() => {
          if (
            inFlightRef.current?.accountId === syncingAccountId
            && inFlightRef.current.signature === signature
          ) {
            inFlightRef.current = null;
          }
          if (mountedRef.current) requestFollowUp();
        });
        return;
      }
    }

    // Repair only after the canonical restore has no pending writes. Running
    // it before restoration can let an already-planned legacy replay land
    // immediately after the cleanup and survive until the next app launch.
    const repairKey = [
      currentAccount.accountId,
      input.canonicalState.storagePath,
    ].join('\u001f');
    if (
      completedRepairRef.current === repairKey
      || repairInFlightRef.current
      || failedRepairRef.current === repairKey
    ) return;
    repairInFlightRef.current = repairKey;
    void pruneCanonicalLegacyCloudSelfMessageDuplicates()
      .then((deletedMessageIds) => {
        if (
          !mountedRef.current
          || latestInputRef.current.account?.accountId
            !== currentAccount.accountId
        ) return;
        completedRepairRef.current = repairKey;
        if (deletedMessageIds.length > 0) {
          latestInputRef.current.setCanonicalState?.((current) => (
            removeCanonicalMessagesById(current, deletedMessageIds)
          ));
        }
      })
      .catch((error) => {
        failedRepairRef.current = repairKey;
        latestInputRef.current.reportWarning(
          '[cloud-self-agent-sync] failed to repair legacy duplicate history',
          error,
        );
      })
      .finally(() => {
        if (repairInFlightRef.current === repairKey) {
          repairInFlightRef.current = null;
        }
        if (
          mountedRef.current
          && completedRepairRef.current === repairKey
        ) requestFollowUp();
      });
  }, [
    accountId,
    canonicalState,
    forksRevision,
    initialMessagesSettled,
    followUpRevision,
    selfMessagesRevision,
    setCanonicalState,
    titlesRevision,
  ]);
}
