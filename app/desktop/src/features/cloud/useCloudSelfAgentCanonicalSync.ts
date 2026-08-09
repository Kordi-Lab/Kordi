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
} from './cloudCanonicalStateMerge';
import {
  planCloudSelfAgentCanonicalSync,
} from './cloudSelfAgentCanonicalSync';
import {
  cloudSelfAgentCanonicalSyncPlanSignature,
  persistCloudSelfAgentCanonicalSyncPlan,
} from './cloudSelfAgentCanonicalSyncExecution';
import type { CloudMessageIndex } from './cloudMessageIndex';

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
    const selfMessages = input.messagesByPeer[currentAccount.accountId] ?? [];
    if (selfMessages.length === 0) return;
    // Persistence may take many IPC calls for a large history. Do not rebuild
    // and re-sort the full plan on every unrelated render while that batch is
    // already in flight.
    if (inFlightRef.current) return;
    const plan = planCloudSelfAgentCanonicalSync({
      account: currentAccount,
      messages: selfMessages,
      state: input.canonicalState,
      forksBySessionId: input.forksBySessionId,
      groupRowByWireMessageId:
        input.messageIndex.groupRowByWireMessageId,
      cloudTitlesBySessionId: input.titlesBySessionId,
    });
    if (
      plan.sessionRequests.length === 0
      && plan.messageRequests.length === 0
    ) return;
    const signature = cloudSelfAgentCanonicalSyncPlanSignature(plan);
    if (
      completedRef.current?.accountId === currentAccount.accountId
      && completedRef.current.signature === signature
    ) return;

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
