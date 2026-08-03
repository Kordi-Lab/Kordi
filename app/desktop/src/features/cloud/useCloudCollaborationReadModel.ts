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
  DesktopCollaborationState,
} from '@/kordi-app/types';
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
      if (agent.id !== 'cloud-local-agent') return agent;
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

export function useCloudCollaborationReadModel({
  account,
  activeConversationId,
  canonicalState,
  routesBySessionId,
  defaultRoute,
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
    if (currentOverride) return currentOverride;
    const canonicalSelfAgentSessions =
      (canonicalState?.sessions ?? []).filter(
        (session) => session.kind === 'self-agent',
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
      cloudSessionTitlesById,
      hiddenCloudSessionIds,
      suppressUnscopedSelfAgentConversation,
    });
    return generated;
  }, [
    account,
    accountContextKey,
    canonicalState,
    contacts,
    deletedSessionIds,
    hiddenSessionIds,
    localAgentTurnsByRequestId,
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
