import {
  useEffect,
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
  const failedRef = useRef<{
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
    if (
      !account
      || !canonicalState
      || !setCanonicalState
      || !initialMessagesSettled
    ) return;
    const selfMessages = messagesByPeer[account.accountId] ?? [];
    if (selfMessages.length === 0) return;
    const plan = planCloudSelfAgentCanonicalSync({
      account,
      messages: selfMessages,
      state: canonicalState,
      forksBySessionId,
      groupRowByWireMessageId:
        messageIndex.groupRowByWireMessageId,
      cloudTitlesBySessionId: titlesBySessionId,
    });
    if (
      plan.sessionRequests.length === 0
      && plan.messageRequests.length === 0
      && plan.mirrorReconciliations.length === 0
    ) return;
    const signature = cloudSelfAgentCanonicalSyncPlanSignature(plan);
    if (inFlightRef.current) return;
    if (
      completedRef.current?.accountId === account.accountId
      && completedRef.current.signature === signature
    ) return;
    if (
      failedRef.current?.accountId === account.accountId
      && failedRef.current.signature === signature
    ) return;

    const accountId = account.accountId;
    inFlightRef.current = { accountId, signature };
    void persistCloudSelfAgentCanonicalSyncPlan(plan, {
      shouldContinue: () => (
        mountedRef.current
        && latestInputRef.current.account?.accountId === accountId
      ),
    }).then((batch) => {
      if (
        !batch
        || !mountedRef.current
        || latestInputRef.current.account?.accountId !== accountId
      ) return;
      completedRef.current = { accountId, signature };
      failedRef.current = null;
      latestInputRef.current.setCanonicalState?.((current) => (
        mergeCloudSelfAgentCanonicalSyncBatch(current, batch)
      ));
    }).catch((error) => {
      failedRef.current = { accountId, signature };
      latestInputRef.current.reportWarning(
        '[cloud-self-agent-sync] failed to materialize cloud session locally',
        error,
      );
    }).finally(() => {
      if (
        inFlightRef.current?.accountId === accountId
        && inFlightRef.current.signature === signature
      ) {
        inFlightRef.current = null;
      }
      if (mountedRef.current) requestFollowUp();
    });
  }, [
    account,
    canonicalState,
    forksBySessionId,
    initialMessagesSettled,
    followUpRevision,
    messageIndex,
    messagesByPeer,
    reportWarning,
    setCanonicalState,
    titlesBySessionId,
  ]);
}
