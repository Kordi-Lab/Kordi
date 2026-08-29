import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import { canonicalCallActivityIdentity } from '@/features/canonical/readModel/callActivity';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudPublicProfile,
} from './authClient';
import type {
  CloudAgentDefinition,
} from './cloudAgents';
import { CloudAgentTurnCoordinator } from './cloudAgentTurnCoordinator';
import type {
  CloudSessionActivityStore,
} from './cloudSessionActivity';
import {
  applyCloudGroupAgentControl,
} from './cloudGroupAgentControl';
import {
  cloudGroupMessageTargetsLocalAgent,
  cloudGroupNativeContextMessages,
} from './cloudGroupAgentPolicy';
export { cloudGroupMessageTargetsLocalAgent, cloudGroupNativeContextMessages };
import {
  applyCloudGroupMessageControl,
} from './cloudGroupMessageControl';
import {
  applyCloudGroupSessionControl,
  resolveAuthorizedCloudGroupSessionTitleSnapshot,
  resolveCloudGroupAdminSnapshot,
} from './cloudGroupSessionControl';
import type {
  CloudGroupControlEnvelope,
} from './cloudGroupMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';
import {
  cloudFallbackRunAlreadyOwnsRequest,
  cloudGroupAgentResponseExistsForRequest,
  isCloudAgentProcessingPlaceholderText,
  removeCanonicalMessageById,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  removeCloudGroupTimeoutPlaceholderForTerminalResponse,
} from './cloudAgentRequestState';
import {
  isRecentCloudAgentMention,
} from './cloudAgentMentionPolicy';
import {
  mergeOpenCanonicalSessionFastResultIntoLocalState,
  upsertCanonicalIdentityIntoLocalState,
} from './cloudCanonicalStateMerge';
import {
  publishDerivedCloudSessionActivity,
  waitForCloudAgentTurn,
} from './cloudAgentLocalExecution';
import {
  cleanCloudText,
  cloudObjectContent,
} from './cloudValue';
import type {
  CloudGroupSessionPreparationCache,
} from './cloudGroupControlContext';

export function cloudGroupAgentProcessingSlotForResponse(
  messages: CanonicalSessionMessage[],
  groupId: string,
  requestId: string,
  senderAccountId: string,
): CanonicalSessionMessage | null {
  const trimmedGroupId = groupId.trim();
  const trimmedRequestId = requestId.trim();
  const trimmedSenderAccountId = senderAccountId.trim();
  if (
    !trimmedGroupId
    || !trimmedRequestId
    || !trimmedSenderAccountId
  ) return null;
  return messages.find((message) => {
    if (message.sessionId !== trimmedGroupId) return false;
    if (!message.sourceTransport?.startsWith('cloud-group-agent')) {
      return false;
    }
    const content = cloudObjectContent(message.content);
    const ownerAccountId = cleanCloudText(
      typeof content.senderOwnerAccountId === 'string'
        ? content.senderOwnerAccountId
        : null,
    );
    if (
      ownerAccountId
        ? ownerAccountId !== trimmedSenderAccountId
        : message.senderIdentityId !== `agent:cloud:${trimmedSenderAccountId}`
    ) return false;
    const linkedRequestId =
      cleanCloudText(message.parentMessageId)
      || cleanCloudText(
        typeof content.requestId === 'string'
          ? content.requestId
          : null,
      )
      || cleanCloudText(
        typeof content.replyToMessageId === 'string'
          ? content.replyToMessageId
          : null,
      );
    if (linkedRequestId !== trimmedRequestId) return false;
    const deliveryState = cleanCloudText(
      typeof content.deliveryState === 'string'
        ? content.deliveryState
        : null,
    ).toLowerCase();
    return (
      message.status === 'queued'
      || message.status === 'processing'
      || deliveryState === 'queued'
      || deliveryState === 'processing'
    );
  }) ?? null;
}

export function cloudGroupIncomingMessageAlreadyApplied(
  existingMessage: CanonicalSessionMessage | null,
  incomingDeliveryState?: string | null,
  incomingMessageKind?: string | null,
): boolean {
  if (!existingMessage) return false;
  const existingCallActivity = canonicalCallActivityIdentity(
    existingMessage.messageKind,
  );
  const incomingCallActivity = canonicalCallActivityIdentity(
    incomingMessageKind ?? '',
  );
  if (
    existingCallActivity
    && incomingCallActivity
    && existingCallActivity.callId === incomingCallActivity.callId
  ) {
    return existingCallActivity.event === 'ended'
      || incomingCallActivity.event === existingCallActivity.event;
  }
  const incomingState =
    cleanCloudText(incomingDeliveryState).toLowerCase();
  const incomingIsTerminal = Boolean(incomingState)
    && !['sending', 'queued', 'processing'].includes(incomingState);
  if (!incomingIsTerminal) return true;

  const content = cloudObjectContent(existingMessage.content);
  const existingDeliveryState = cleanCloudText(
    typeof content.deliveryState === 'string'
      ? content.deliveryState
      : null,
  ).toLowerCase();
  const existingStatus = existingMessage.status.trim().toLowerCase();
  if (incomingState === 'read') {
    return existingStatus === 'read' || existingDeliveryState === 'read';
  }
  if (incomingState === 'delivered') {
    return ['delivered', 'read'].includes(existingStatus)
      || ['delivered', 'read'].includes(existingDeliveryState);
  }
  const existingIsFailedFallback = (
    existingStatus === 'failed'
    || existingDeliveryState === 'failed'
  ) && existingMessage.sourceEventId?.startsWith(
    'cloud-group-agent:cloudrunmsg_',
  ) === true;
  if (existingIsFailedFallback && incomingState === 'complete') {
    return false;
  }
  const existingIsPending =
    ['sending', 'queued', 'processing'].includes(existingStatus)
    || ['sending', 'queued', 'processing'].includes(existingDeliveryState);
  if (existingIsPending) return false;

  // The offline tier is a local timeout hint, not a terminal Cloud
  // response. A later owner response must still replace it.
  if (
    existingMessage.sourceTransport === 'cloud-group-agent-offline'
  ) return false;
  return true;
}

type CloudGroupControlApplicationProps = {
  account: CloudAccount | null;
  client: CloudAuthClient;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  profileCacheRef: MutableRefObject<Map<string, CloudPublicProfile>>;
  messageIndexRef: MutableRefObject<CloudMessageIndex>;
  mergeMessage: (message: CloudMessage) => void;
  syncDiff: () => Promise<void>;
  sessionActivityRef: MutableRefObject<CloudSessionActivityStore>;
  setSessionActivity: Dispatch<
    SetStateAction<CloudSessionActivityStore>
  >;
  setLocalTurns: Dispatch<
    SetStateAction<Record<string, DesktopChatTurnSnapshot>>
  >;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  turnIdsByRequestIdRef: MutableRefObject<Map<string, string>>;
  agentDefinitionsById: Record<string, CloudAgentDefinition>;
  routesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultRoute?: DesktopChatMessageRoute | null;
  reportWarning: (message: string, error: unknown) => void;
};

export function useCloudGroupControlApplication({
  account,
  client,
  canonicalStateRef,
  setCanonicalState,
  profileCacheRef,
  messageIndexRef,
  mergeMessage,
  syncDiff,
  sessionActivityRef,
  setSessionActivity,
  setLocalTurns,
  processedRequestIdsRef,
  turnIdsByRequestIdRef,
  agentDefinitionsById,
  routesBySessionId,
  defaultRoute,
  reportWarning,
}: CloudGroupControlApplicationProps) {
  const turnCoordinator = useMemo(
    () => new CloudAgentTurnCoordinator(account?.accountId ?? null),
    [account?.accountId],
  );
  useEffect(() => () => turnCoordinator.dispose(), [turnCoordinator]);
  const sessionPreparationCacheRef = useRef<{
    accountId: string | null;
    entries: CloudGroupSessionPreparationCache;
  }>({ accountId: null, entries: new Map() });
  const publishCanonicalState = useCallback<Dispatch<SetStateAction<CanonicalSessionState | null>>>(
    (action) => {
      const nextState = typeof action === 'function'
        ? action(canonicalStateRef.current)
        : action;
      canonicalStateRef.current = nextState;
    },
    [canonicalStateRef],
  );
  const flushCanonicalState = useCallback(() => {
    if (!setCanonicalState) return;
    const nextState = canonicalStateRef.current;
    setCanonicalState((currentState) => (
      currentState === nextState ? currentState : nextState
    ));
  }, [canonicalStateRef, setCanonicalState]);
  const publishCanonicalStateImmediately = useCallback<Dispatch<SetStateAction<CanonicalSessionState | null>>>(
    (action) => {
      publishCanonicalState(action);
      flushCanonicalState();
    },
    [flushCanonicalState, publishCanonicalState],
  );
  const apply = useCallback(async (
    cloudMessage: CloudMessage,
    envelope: CloudGroupControlEnvelope,
    options: { deferPublish?: boolean; historyReplay?: boolean } = {},
  ) => {
    const currentAccountId = account?.accountId ?? null;
    if (sessionPreparationCacheRef.current.accountId !== currentAccountId) {
      sessionPreparationCacheRef.current = {
        accountId: currentAccountId,
        entries: new Map(),
      };
    }
    // Canonical state stays behind a ref so replay does not rebuild this
    // callback after every canonical write and re-enter the replay effect.
    const sessionContext = await applyCloudGroupSessionControl({
      cloudMessage,
      envelope,
      runtime: {
        account,
        client,
        profileCache: profileCacheRef.current,
        sessionPreparationCache:
          sessionPreparationCacheRef.current.entries,
      },
      canonical: {
        getState: () => canonicalStateRef.current,
        setState: publishCanonicalState,
      },
      stateOps: {
        objectContent: cloudObjectContent,
        cleanText: cleanCloudText,
        resolveAdminSnapshot: resolveCloudGroupAdminSnapshot,
        resolveSessionTitle:
          resolveAuthorizedCloudGroupSessionTitleSnapshot,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        mergeOpenSession:
          mergeOpenCanonicalSessionFastResultIntoLocalState,
      },
    });
    if (!sessionContext || !setCanonicalState) return;

    const messageContext = await applyCloudGroupMessageControl({
      context: sessionContext,
      setCanonicalState: publishCanonicalState,
      stateOps: {
        objectContent: cloudObjectContent,
        cleanText: cleanCloudText,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        processingSlot: cloudGroupAgentProcessingSlotForResponse,
        incomingAlreadyApplied:
          cloudGroupIncomingMessageAlreadyApplied,
        removeOfflinePlaceholder: removeCloudGroupOfflinePlaceholder,
        removeTimeoutPlaceholder:
          removeCloudGroupTimeoutPlaceholderForTerminalResponse,
        removePendingRows:
          removeCloudGroupPendingRowsForTerminalResponse,
        removeMessage: removeCanonicalMessageById,
        isProcessingPlaceholder:
          isCloudAgentProcessingPlaceholderText,
      },
    });
    if (!messageContext) return;
    if (options.historyReplay) return;

    await applyCloudGroupAgentControl({
      context: messageContext,
      setCanonicalState: options.deferPublish
        ? publishCanonicalState
        : publishCanonicalStateImmediately,
      runtime: {
        client,
        turnCoordinator,
        messageIndex: () => messageIndexRef.current,
        sessionActivity: () => sessionActivityRef.current,
        setSessionActivity,
        setLocalTurns,
        processedMentionIds: processedRequestIdsRef.current,
        turnIdsByRequestId: turnIdsByRequestIdRef.current,
        agentDefinitionsById,
        routesBySessionId,
        defaultRoute,
        mergeMessage,
        syncDiff,
        reportFailure: (kind, error) => {
          reportWarning(
            kind === 'no-provider-notice'
              ? '[cloud-group-agent-mention] no-provider notice failed'
              : '[cloud-group-agent-mention] local agent response failed',
            error,
          );
        },
      },
      stateOps: {
        cleanText: cleanCloudText,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        removePendingRows:
          removeCloudGroupPendingRowsForTerminalResponse,
        removeTimeoutPlaceholder:
          removeCloudGroupTimeoutPlaceholderForTerminalResponse,
      },
      policy: {
        isRecentMention: isRecentCloudAgentMention,
        messageTargetsLocalAgent: cloudGroupMessageTargetsLocalAgent,
        responseExists: cloudGroupAgentResponseExistsForRequest,
        fallbackRunOwnsRequest: cloudFallbackRunAlreadyOwnsRequest,
        nativeContext: cloudGroupNativeContextMessages,
        waitForTurn: waitForCloudAgentTurn,
        publishActivity: (input) => publishDerivedCloudSessionActivity({
          ...input,
          reportWarning,
        }),
      },
    });
  }, [
    account,
    agentDefinitionsById,
    canonicalStateRef,
    client,
    defaultRoute,
    mergeMessage,
    messageIndexRef,
    processedRequestIdsRef,
    profileCacheRef,
    publishCanonicalState,
    publishCanonicalStateImmediately,
    reportWarning,
    routesBySessionId,
    sessionActivityRef,
    setCanonicalState,
    setLocalTurns,
    setSessionActivity,
    syncDiff,
    turnCoordinator,
    turnIdsByRequestIdRef,
  ]);
  return { apply, flushCanonicalState };
}
