import {
  useCallback,
  useEffect,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  DesktopChatMessageRoute,
} from '@/lib/desktop';
import type {
  CanonicalSessionState,
  Contact,
  DesktopChatTurnSnapshot,
  DesktopCollaborationConversation,
  DesktopCollaborationState,
} from '@/kordi-app/types';
import { isChatCreatedDirectAgentSession } from '@/features/canonical/readModel/conversationMapping';
import type {
  CloudAccount,
  CloudMessage,
} from './authClient';
import {
  buildCloudDesktopCollaborationState,
  isCloudCollaborationHostId,
} from './cloudCollaborationState';
import {
  cloudAgentRuntimeRouteForSession,
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import {
  removeCloudSessionMessages,
} from './cloudDiffSync';
import {
  cloudGroupReadCursorsBySessionId,
} from './cloudSelfAgentCanonicalSync';
import type {
  CloudMessageIndex,
} from './cloudMessageIndex';

export function localOwnedAgentSessionsForCloudHiding(
  sessions: CanonicalSessionState['sessions'],
) {
  return sessions.filter((session) => (
    session.kind === 'self-agent' || isChatCreatedDirectAgentSession(session)
  ));
}

export function applyCloudAgentRuntimeRouteToState(
  state: DesktopCollaborationState | null,
  route: DesktopChatMessageRoute | null,
): DesktopCollaborationState | null {
  if (!state) return state;
  const defaultModel = route?.model ?? null;
  const defaultAuthProvider = route?.authProvider ?? null;
  const defaultAuthChoice = route?.authChoice ?? null;
  const thinking = route?.thinking ?? null;
  let changed = false;
  const hosts = state.hosts.map((host) => {
    if (!isCloudCollaborationHostId(host.id)) return host;
    let agentsChanged = false;
    const agents = host.agents.map((agent) => {
      if (!agent.isDefault) return agent;
      if (
        agent.defaultModel === defaultModel
        && agent.defaultAuthProvider === defaultAuthProvider
        && agent.defaultAuthChoice === defaultAuthChoice
        && agent.thinking === thinking
      ) return agent;
      agentsChanged = true;
      return {
        ...agent,
        defaultModel,
        defaultAuthProvider,
        defaultAuthChoice,
        thinking,
      };
    });
    if (!agentsChanged) return host;
    changed = true;
    return { ...host, agents };
  });
  return changed ? { ...state, hosts } : state;
}

export function cloudCollaborationPreviousStateForContext(
  state: DesktopCollaborationState | null,
  stateContextKey: string | null,
  currentContextKey: string | null,
) {
  return currentContextKey && stateContextKey === currentContextKey
    ? state
    : null;
}

export function suppressCloudCollaborationUnreadCounts(
  state: DesktopCollaborationState | null,
): DesktopCollaborationState | null {
  if (!state) return state;
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (conversation.unreadCount === 0) return conversation;
    changed = true;
    return { ...conversation, unreadCount: 0 };
  });
  return changed ? { ...state, conversations } : state;
}

function isOptimisticCloudMessage(
  message: DesktopCollaborationConversation['messages'][number],
): boolean {
  return message.deliveryState === 'sending'
    || message.deliveryState === 'failed'
    || Boolean(
      message.deliveryState === 'delivered'
      && message.direction === 'outbound'
      && message.clientMessageId,
    );
}

function unresolvedOptimisticMessages(
  authoritative: DesktopCollaborationConversation | undefined,
  optimistic: DesktopCollaborationConversation,
) {
  const authoritativeMessageIds = new Set(
    authoritative?.messages.map((message) => message.id) ?? [],
  );
  const authoritativeClientMessageIds = new Set(
    authoritative?.messages.flatMap((message) => (
      message.clientMessageId ? [message.clientMessageId] : []
    )) ?? [],
  );
  return optimistic.messages.filter((message) => (
    isOptimisticCloudMessage(message)
    && !authoritativeMessageIds.has(message.id)
    && !(
      message.clientMessageId
      && authoritativeClientMessageIds.has(message.clientMessageId)
    )
  ));
}

export function mergeCloudCollaborationOptimisticState(
  authoritative: DesktopCollaborationState | null,
  optimistic: DesktopCollaborationState | null,
): DesktopCollaborationState | null {
  if (!authoritative) return optimistic;
  if (!optimistic) return authoritative;

  const optimisticByConversationId = new Map(
    optimistic.conversations.map((conversation) => [conversation.id, conversation]),
  );
  const authoritativeConversationIds = new Set(
    authoritative.conversations.map((conversation) => conversation.id),
  );
  let changed = false;
  const conversations = authoritative.conversations.map((conversation) => {
    const optimisticConversation = optimisticByConversationId.get(conversation.id);
    if (!optimisticConversation) return conversation;
    const pending = unresolvedOptimisticMessages(
      conversation,
      optimisticConversation,
    );
    if (pending.length === 0) return conversation;
    changed = true;
    const latest = pending[pending.length - 1];
    return {
      ...conversation,
      subtitle: optimisticConversation.subtitle,
      updatedAtMs: latest.timestampMs,
      updatedAtLabel: latest.timeLabel,
      awaitingReply: optimisticConversation.awaitingReply,
      messages: [...conversation.messages, ...pending]
        .sort((left, right) => left.timestampMs - right.timestampMs),
    };
  });

  for (const optimisticConversation of optimistic.conversations) {
    if (authoritativeConversationIds.has(optimisticConversation.id)) continue;
    const pending = unresolvedOptimisticMessages(
      undefined,
      optimisticConversation,
    );
    if (pending.length === 0) continue;
    changed = true;
    conversations.push({
      ...optimisticConversation,
      messages: pending,
    });
  }

  if (!changed) return authoritative;
  conversations.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return { ...authoritative, conversations };
}

export function useCloudCollaborationReadModel({
  account,
  activeConversationId,
  canonicalState,
  routesBySessionId,
  defaultRoute,
  localAgentLabel,
  contacts,
  hiddenSessionIds,
  deletedSessionIds,
  accountContextKey,
  override,
  setOverride,
  overrideContextKey,
  setOverrideContextKey,
  stateRef,
  stateContextKeyRef,
  localAgentTurnsByRequestId,
  initialMessagesSettled,
  messageIndex,
  messagesByPeer,
  readInboundMessageIdsByPeer,
}: {
  account: CloudAccount | null;
  activeConversationId?: string | null;
  canonicalState?: CanonicalSessionState | null;
  routesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultRoute?: DesktopChatMessageRoute | null;
  localAgentLabel?: string | null;
  contacts: Contact[];
  hiddenSessionIds: Set<string>;
  deletedSessionIds: Set<string>;
  accountContextKey: string | null;
  override: DesktopCollaborationState | null;
  setOverride: Dispatch<
    SetStateAction<DesktopCollaborationState | null>
  >;
  overrideContextKey: string | null;
  setOverrideContextKey: Dispatch<SetStateAction<string | null>>;
  stateRef: MutableRefObject<DesktopCollaborationState | null>;
  stateContextKeyRef: MutableRefObject<string | null>;
  localAgentTurnsByRequestId:
    Record<string, DesktopChatTurnSnapshot>;
  initialMessagesSettled: boolean;
  messageIndex: CloudMessageIndex;
  messagesByPeer: Record<string, CloudMessage[]>;
  readInboundMessageIdsByPeer: Record<string, Set<string>>;
}) {
  const baseCloudCollaborationState = useMemo(() => {
    if (!account) return null;
    const currentOverride = cloudCollaborationPreviousStateForContext(
      override,
      overrideContextKey,
      accountContextKey,
    );
    const canonicalSelfAgentSessions = localOwnedAgentSessionsForCloudHiding(
      canonicalState?.sessions ?? [],
    );
    const cloudSessionTitlesById = Object.fromEntries(
      canonicalSelfAgentSessions.map(
        (session) => [session.id, session.title],
      ),
    );
    const hiddenCloudSessionIds = new Set([
      ...canonicalSelfAgentSessions
        .map((session) => session.id.trim())
        .filter(Boolean),
      ...hiddenSessionIds,
      ...deletedSessionIds,
    ]);
    const canonicalSelfAgentSessionIds = new Set(
      canonicalSelfAgentSessions.map((session) => session.id),
    );
    const suppressUnscopedSelfAgentConversation =
      (canonicalState?.messages ?? []).some((message) => (
        canonicalSelfAgentSessionIds.has(message.sessionId)
        && message.sourceTransport !== 'canonical-fork-snapshot'
        && message.sourceTransport !== 'cloud-group-fork-snapshot'
      ));
    const visibleMessagesByPeer = (() => {
      let next = messagesByPeer;
      for (const sessionId of hiddenCloudSessionIds) {
        next = removeCloudSessionMessages(
          account.accountId,
          next,
          sessionId,
        );
      }
      return next;
    })();
    const generated = buildCloudDesktopCollaborationState({
      account,
      contacts,
      messagesByPeer: visibleMessagesByPeer,
      messageIndex,
      readInboundMessageIdsByPeer,
      readCursorsBySessionId:
        cloudGroupReadCursorsBySessionId(canonicalState),
      localAgentTurnsByRequestId,
      localAgentRuntimeRoute: null,
      localAgentLabel,
      cloudSessionTitlesById,
      hiddenCloudSessionIds,
      suppressUnscopedSelfAgentConversation,
    });
    return mergeCloudCollaborationOptimisticState(
      generated,
      currentOverride,
    );
  }, [
    account,
    accountContextKey,
    canonicalState,
    contacts,
    deletedSessionIds,
    hiddenSessionIds,
    localAgentTurnsByRequestId,
    localAgentLabel,
    messageIndex,
    messagesByPeer,
    override,
    overrideContextKey,
    readInboundMessageIdsByPeer,
  ]);

  const cloudCollaborationState = useMemo(() => {
    if (!account) return null;
    const activeRuntimeSessionId = cloudAgentRuntimeSessionId(
      account.accountId,
      activeConversationId,
    );
    const activeRuntimeRoute = cloudAgentRuntimeRouteForSession(
      routesBySessionId,
      activeRuntimeSessionId,
      defaultRoute,
    );
    const routed = applyCloudAgentRuntimeRouteToState(
      baseCloudCollaborationState,
      activeRuntimeRoute,
    );
    return initialMessagesSettled
      ? routed
      : suppressCloudCollaborationUnreadCounts(routed);
  }, [
    account,
    activeConversationId,
    baseCloudCollaborationState,
    defaultRoute,
    initialMessagesSettled,
    routesBySessionId,
  ]);

  useEffect(() => {
    stateRef.current = cloudCollaborationState;
    stateContextKeyRef.current = accountContextKey;
  }, [
    accountContextKey,
    cloudCollaborationState,
    stateContextKeyRef,
    stateRef,
  ]);

  const setCloudCollaborationState = useCallback<
    Dispatch<SetStateAction<DesktopCollaborationState | null>>
  >((action) => {
    const current = cloudCollaborationPreviousStateForContext(
      stateRef.current,
      stateContextKeyRef.current,
      accountContextKey,
    );
    const next = typeof action === 'function'
      ? action(current)
      : action;
    setOverrideContextKey(accountContextKey);
    setOverride(next);
  }, [
    accountContextKey,
    setOverride,
    setOverrideContextKey,
    stateContextKeyRef,
    stateRef,
  ]);

  return {
    cloudCollaborationState,
    setCloudCollaborationState,
  };
}
