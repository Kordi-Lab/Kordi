import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { upsertCanonicalMessageFast } from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import { cloudAgentTurnLifecycleState } from '@/features/canonical/cloudAgentTurnLifecycle';
import type { CloudAccount, CloudAgentRun, CloudAuthClient } from './authClient';
import { cloudGroupAgentConversationId } from './cloudGroupMessages';
import { removeCloudGroupPendingRowsForTerminalResponse } from './cloudAgentRequestState';
import { loadSession } from './session';

export const CLOUD_AGENT_INTERRUPTED_TURN_NOTICE =
  'This reply was interrupted before it completed. Try again.';

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function interruptedCloudGroupAgentTurnRecovery({
  message,
  accountId,
  now = Date.now(),
}: {
  message: CanonicalSessionMessage;
  accountId: string;
  now?: number;
}): { requestId: string; request: AppendCanonicalMessageRequest } | null {
  const localAccountId = accountId.trim();
  if (
    !localAccountId
    || message.messageKind !== 'agent-turn'
    || message.senderRole !== 'owned-agent'
    || message.senderIdentityId !== `agent:cloud:${localAccountId}`
    || message.sourceTransport !== 'cloud-group-agent'
  ) return null;
  const lifecycle = cloudAgentTurnLifecycleState(message);
  if (lifecycle !== 'queued' && lifecycle !== 'processing') return null;

  const content = objectContent(message.content);
  const requestId = cleanText(message.parentMessageId)
    || cleanText(content.requestId)
    || cleanText(content.replyToMessageId);
  if (!requestId) return null;
  const sender = cleanText(content.sender) || 'Kordi';
  return {
    requestId,
    request: {
      id: message.id,
      sessionId: message.sessionId,
      senderIdentityId: message.senderIdentityId,
      senderRole: message.senderRole,
      messageKind: 'agent-turn',
      contentText: '',
      content: {
        ...content,
        sender,
        timestampMs: now,
        deliveryState: 'failed',
        sourceConversationId:
          cleanText(content.sourceConversationId)
          || cloudGroupAgentConversationId(message.sessionId),
        requestId,
        replyToMessageId: requestId,
        error: CLOUD_AGENT_INTERRUPTED_TURN_NOTICE,
      },
      createdAtMs: now,
      parentMessageId: requestId,
      status: 'failed',
      sourceTransport: 'cloud-group-agent',
      sourceEventId:
        `cloud-group-agent-recovered:${requestId}:${localAccountId}`,
    },
  };
}

export function interruptedCloudGroupAgentTurnRecoveries({
  messages,
  accountId,
  now = Date.now(),
}: {
  messages: CanonicalSessionMessage[];
  accountId: string;
  now?: number;
}): Array<NonNullable<ReturnType<
  typeof interruptedCloudGroupAgentTurnRecovery
>>> {
  const recoveries: Array<NonNullable<ReturnType<
    typeof interruptedCloudGroupAgentTurnRecovery
  >>> = [];
  for (const message of messages) {
    // Keep startup recovery off the ordinary transcript-history path. Most
    // rows are user/system messages and should not pay lifecycle parsing cost.
    if (
      message.messageKind !== 'agent-turn'
      || message.sourceTransport !== 'cloud-group-agent'
    ) continue;
    const recovery = interruptedCloudGroupAgentTurnRecovery({
      message,
      accountId,
      now,
    });
    if (recovery) recoveries.push(recovery);
  }
  return recoveries;
}

export type InterruptedCloudAgentTurnDisposition =
  | 'interrupted-locally'
  | 'retry-after-cloud-failure'
  | 'server-active'
  | 'server-terminal';

export function interruptedCloudAgentTurnDisposition(
  run: CloudAgentRun | null | undefined,
): InterruptedCloudAgentTurnDisposition {
  if (run === null) return 'interrupted-locally';
  if (run?.status === 'failed') return 'retry-after-cloud-failure';
  if (run?.status === 'completed' || run?.status === 'cancelled') {
    return 'server-terminal';
  }
  // `undefined` means the lookup itself was unavailable, so preserve
  // Processing instead of fabricating a terminal failure while Cloud may
  // still own the request.
  return 'server-active';
}

export function useCloudAgentTurnRecovery({
  account,
  client,
  canonicalStateRef,
  setCanonicalState,
  initialMessagesSettled,
  processedRequestIdsRef,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  initialMessagesSettled: boolean;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  reportWarning: (message: string, error: unknown) => void;
}): boolean {
  const contextKey = account?.accountId ?? null;
  const [settledContextKey, setSettledContextKey] = useState<string | null>(
    null,
  );
  const reportWarningRef = useRef(reportWarning);

  useEffect(() => {
    reportWarningRef.current = reportWarning;
  }, [reportWarning]);

  useEffect(() => {
    if (!contextKey) return;
    if (!initialMessagesSettled) return;
    let active = true;

    // Hydration owns the current frame. Recovery is a bounded follow-up for
    // interrupted Cloud agent rows and must not compete with transcript paint.
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        const state = canonicalStateRef.current;
        if (!state || !setCanonicalState) return;
        const recoveries = interruptedCloudGroupAgentTurnRecoveries({
          messages: state.messages,
          accountId: contextKey,
        });
        if (recoveries.length === 0) return;

        const session = await loadSession().catch((error) => {
          reportWarningRef.current(
            '[cloud-group-agent] recovery session lookup failed',
            error,
          );
          return null;
        });
        const checkedRecoveries = await Promise.all(recoveries.map(
          async (recovery) => {
            if (!session?.token) return { recovery, run: undefined };
            const run = await client.lookupCloudAgentRunForRequest(
              session.token,
              recovery.requestId,
            ).catch((error) => {
              reportWarningRef.current(
                '[cloud-group-agent] recovery run lookup failed',
                error,
              );
              return undefined;
            });
            return { recovery, run };
          },
        ));
        const classifiedRecoveries = checkedRecoveries.map((checked) => ({
          ...checked,
          disposition: interruptedCloudAgentTurnDisposition(checked.run),
        }));
        const recoverable = classifiedRecoveries.filter(({ disposition }) =>
          disposition === 'interrupted-locally'
        ).map(({ recovery }) => recovery);
        const pendingRemoval = classifiedRecoveries.filter(
          ({ disposition }) =>
            disposition === 'retry-after-cloud-failure'
            || disposition === 'server-terminal',
        ).map(({ recovery }) => recovery);
        classifiedRecoveries.filter(({ disposition }) =>
          disposition === 'server-active'
          || disposition === 'server-terminal'
        ).forEach(({ recovery }) => {
          processedRequestIdsRef.current.add(recovery.requestId);
        });
        if (recoverable.length === 0 && pendingRemoval.length === 0) return;

        const persistedRows = await Promise.all(
          recoverable.map(({ request }) => upsertCanonicalMessageFast(request)),
        );
        if (!active) return;
        recoverable.forEach(({ requestId }) => {
          processedRequestIdsRef.current.add(requestId);
        });
        setCanonicalState((current) => {
          let next = current;
          persistedRows.forEach((row, index) => {
            next = mergeCanonicalMessageRow(next, row);
            if (!next) return;
            next = removeCloudGroupPendingRowsForTerminalResponse(
              next,
              recoverable[index].requestId,
              contextKey,
            );
          });
          pendingRemoval.forEach(({ requestId }) => {
            next = removeCloudGroupPendingRowsForTerminalResponse(
              next,
              requestId,
              contextKey,
            );
          });
          canonicalStateRef.current = next;
          return next;
        });
      })().catch((error) => {
        reportWarningRef.current(
          '[cloud-group-agent] interrupted turn recovery failed',
          error,
        );
      }).finally(() => {
        if (active) setSettledContextKey(contextKey);
      });
    }, 0);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    canonicalStateRef,
    client,
    contextKey,
    initialMessagesSettled,
    processedRequestIdsRef,
    setCanonicalState,
  ]);

  return Boolean(contextKey && settledContextKey === contextKey);
}
