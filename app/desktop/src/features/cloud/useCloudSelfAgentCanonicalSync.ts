import {
  useEffect,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  mergeCanonicalMessageRow,
} from '@/features/canonical/canonicalStateReducers';
import {
  openOrCreateCanonicalSessionFast,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import type { CloudSessionTitlesById } from './cloudDiffSync';
import {
  mergeOpenCanonicalSessionFastResultIntoLocalState,
  upsertCanonicalIdentityIntoLocalState,
} from './cloudCanonicalStateMerge';
import {
  planCloudSelfAgentCanonicalSync,
} from './cloudSelfAgentCanonicalSync';
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
    ) return;
    let cancelled = false;
    void (async () => {
      let nextState: CanonicalSessionState | null = canonicalState;
      const agentIdentity = await upsertCanonicalIdentityFast(
        plan.agentIdentityRequest,
      );
      nextState = upsertCanonicalIdentityIntoLocalState(
        nextState,
        agentIdentity,
      );
      for (const sessionRequest of plan.sessionRequests) {
        if (cancelled) return;
        const openResult =
          await openOrCreateCanonicalSessionFast(sessionRequest);
        nextState =
          mergeOpenCanonicalSessionFastResultIntoLocalState(
            nextState,
            openResult,
          );
      }
      for (const messageRequest of plan.messageRequests) {
        if (cancelled) return;
        const persistedMessage =
          await upsertCanonicalMessageFast(messageRequest);
        nextState = mergeCanonicalMessageRow(
          nextState,
          persistedMessage,
        );
      }
      if (!cancelled) setCanonicalState(nextState);
    })().catch((error) => {
      reportWarning(
        '[cloud-self-agent-sync] failed to materialize cloud session locally',
        error,
      );
    });
    return () => {
      cancelled = true;
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
}
