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
import {
  loadChatSyncConversations,
  loadChatSyncMessagesPage,
  loadChatSyncRecoveryMessageIds,
} from '@/lib/desktopChatSync';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { cloudMessageFromChatSync } from './chatSyncMapping';
import {
  fetchExistingCanonicalMessageSources,
} from '@/features/canonical/canonicalMessageSources';

const NATIVE_SELF_AGENT_RECOVERY_PAGE_SIZE = 200;

export function useCloudSelfAgentCanonicalSync({
  account,
  canonicalState,
  setCanonicalState,
  messagesByPeer,
  messageIndex,
  forksBySessionId,
  titlesBySessionId,
  initialMessagesSettled,
  onSettled,
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
  onSettled?: () => void;
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
    onSettled,
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
  const nativeHistoryRef = useRef<{
    accountId: string | null;
    recovered: boolean;
    failed: boolean;
    inFlight: Promise<void> | null;
  }>({
    accountId: null,
    recovered: false,
    failed: false,
    inFlight: null,
  });
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
      onSettled,
      reportWarning,
    };
  }, [
    account,
    canonicalState,
    forksBySessionId,
    initialMessagesSettled,
    messageIndex,
    messagesByPeer,
    onSettled,
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
    const nativeHistory = nativeHistoryRef.current.accountId === account.accountId
      ? nativeHistoryRef.current
      : {
          accountId: account.accountId,
          recovered: false,
          failed: false,
          inFlight: null,
        };
    nativeHistoryRef.current = nativeHistory;
    if (nativeHistory.failed) return;
    if (!nativeHistory.recovered) {
      if (nativeHistory.inFlight) return;
      const accountId = account.accountId;
      nativeHistory.inFlight = (async () => {
        const conversations = await loadChatSyncConversations(accountId);
        let workingState = latestInputRef.current.canonicalState;
        if (!workingState) return;
        for (const conversation of conversations) {
          if (
            !mountedRef.current
            || latestInputRef.current.account?.accountId !== accountId
          ) return;
          if (conversation.kind !== 'ai') continue;
          const recoveryIds = await loadChatSyncRecoveryMessageIds(
            accountId,
            conversation.id,
          );
          const existingSources = await fetchExistingCanonicalMessageSources(
            (recoveryIds?.messageIds ?? []).flatMap((messageId) => [
              {
                sourceTransport: 'cloud-self-agent',
                sourceEventId: messageId,
              },
              {
                sourceTransport: 'canonical-fork-snapshot',
                sourceEventId: messageId,
              },
            ]),
          );
          const durableSourceEventIds = new Set(
            existingSources.map((source) => source.sourceEventId),
          );
          if (
            recoveryIds
            && recoveryIds.messageIds.every((messageId) => (
              durableSourceEventIds.has(messageId)
            ))
          ) continue;
          const messages: CloudMessage[] = [];
          let afterSequence: number | null = null;
          while (true) {
            const page = await loadChatSyncMessagesPage(
              accountId,
              conversation.id,
              afterSequence,
              NATIVE_SELF_AGENT_RECOVERY_PAGE_SIZE,
            );
            if (!page) return;
            messages.push(...page.messages.map((snapshot) => (
              cloudMessageMetadataOnly(
                cloudMessageFromChatSync(snapshot, conversation, accountId),
              )
            )));
            if (!page.hasMore) break;
            const next = page.nextAfterSequence;
            if (
              next === null
              || (afterSequence !== null && next <= afterSequence)
            ) {
              throw new Error(
                'Native self-agent history did not advance its sequence cursor.',
              );
            }
            afterSequence = next;
          }
          if (messages.length === 0) continue;
          const current = latestInputRef.current;
          const plan = planCloudSelfAgentCanonicalSync({
            account,
            messages,
            state: workingState,
            forksBySessionId: current.forksBySessionId,
            groupRowByWireMessageId:
              current.messageIndex.groupRowByWireMessageId,
            cloudTitlesBySessionId: current.titlesBySessionId,
            durableSourceEventIds,
          });
          if (
            plan.sessionRequests.length === 0
            && plan.messageRequests.length === 0
            && plan.mirrorReconciliations.length === 0
          ) continue;
          const batch = await persistCloudSelfAgentCanonicalSyncPlan(plan, {
            shouldContinue: () => (
              mountedRef.current
              && latestInputRef.current.account?.accountId === accountId
            ),
          });
          if (!batch) return;
          const merged = mergeCloudSelfAgentCanonicalSyncBatch(
            workingState,
            batch,
          );
          if (merged) workingState = merged;
          current.setCanonicalState?.((state) => (
            mergeCloudSelfAgentCanonicalSyncBatch(state, batch)
          ));
        }
        if (
          mountedRef.current
          && latestInputRef.current.account?.accountId === accountId
        ) {
          nativeHistory.recovered = true;
        }
      })().catch((error) => {
        nativeHistory.failed = true;
        latestInputRef.current.reportWarning(
          '[cloud-self-agent-sync] native history recovery failed',
          error,
        );
      }).finally(() => {
        nativeHistory.inFlight = null;
        if (mountedRef.current && nativeHistory.recovered) requestFollowUp();
      });
      return;
    }
    const selfMessages = messagesByPeer[account.accountId] ?? [];
    if (selfMessages.length === 0) {
      onSettled?.();
      return;
    }
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
    ) {
      onSettled?.();
      return;
    }
    const signature = cloudSelfAgentCanonicalSyncPlanSignature(plan);
    if (inFlightRef.current) return;
    if (
      completedRef.current?.accountId === account.accountId
      && completedRef.current.signature === signature
    ) {
      onSettled?.();
      return;
    }
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
      latestInputRef.current.onSettled?.();
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
    onSettled,
    reportWarning,
    setCanonicalState,
    titlesBySessionId,
  ]);
}
