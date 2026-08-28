import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  portableCloudAgentAuthChoice,
  resolveDefaultCloudAgentRuntimeRoute,
} from '@/app/useKordiDefaultCloudAgentRuntimeRoute';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import {
  applySynchronizedCloudAgentRuntimeRoutes,
  CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND,
  cloudAgentRuntimeSessionId,
  compactCloudAgentRuntimeRoute,
  encodeCloudAgentRuntimeRouteChange,
  type CloudAgentRuntimeRouteChangeInput,
} from '@/features/cloud/cloudAgentRuntime';
import { cloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { canonicalCloudProviderId } from '@/features/cloud/providerAuthSnapshot';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

type CanonicalStore = ReturnType<
  typeof import('@/app/useKordiCanonicalSessionStore').useKordiCanonicalSessionStore
>;
type ComposerViewModel = ReturnType<
  typeof import('@/features/chat/useComposerViewModel').useComposerViewModel
>;
type DesktopAuthViewModel = ReturnType<
  typeof import('@/features/auth/useDesktopAuthState').useDesktopAuthState
>;
type CloudCollaborationViewModel = ReturnType<
  typeof import('@/features/cloud/useCloudCollaborationState').useCloudCollaborationState
>;
type ComposerUi = ReturnType<
  typeof import('@/app/useKordiLocalUiState').useKordiLocalUiState
>['composerUi'];

export function useCloudAgentRuntimeRouteSync({
  accountId,
  activeConversationId,
  activeLoginProviderId,
  canonicalSessionState,
  chatModelOptions,
  cloudAgentRuntimeRouteMessages,
  composerAuthByScope,
  composerUi,
  defaultCloudAgentRuntimeRoute,
  desktopAuthState,
  isNativeShell,
  preferredModelValueForProvider,
  resolveComposerProviderId,
  routesBySessionId,
  sendCloudCollaborationMessage,
  setRoutesBySessionId,
  updateCloudCollaborationSessionTitle,
}: {
  accountId?: string | null;
  activeConversationId: string;
  activeLoginProviderId: string | null;
  canonicalSessionState: CanonicalStore['state'];
  chatModelOptions: ComposerViewModel['chatModelOptions'];
  cloudAgentRuntimeRouteMessages:
    CloudCollaborationViewModel['cloudAgentRuntimeRouteMessages'];
  composerAuthByScope: ComposerViewModel['composerAuthByScope'];
  composerUi: ComposerUi;
  defaultCloudAgentRuntimeRoute: DesktopChatMessageRoute | null;
  desktopAuthState: DesktopAuthViewModel['desktopAuthState'];
  isNativeShell: boolean;
  preferredModelValueForProvider:
    ComposerViewModel['preferredModelValueForProvider'];
  resolveComposerProviderId: ComposerViewModel['resolveComposerProviderId'];
  routesBySessionId: Record<string, DesktopChatMessageRoute>;
  sendCloudCollaborationMessage:
    CloudCollaborationViewModel['sendCloudCollaborationMessage'];
  setRoutesBySessionId: Dispatch<
    SetStateAction<Record<string, DesktopChatMessageRoute>>
  >;
  updateCloudCollaborationSessionTitle:
    CloudCollaborationViewModel['updateCloudCollaborationSessionTitle'];
}) {
  useEffect(() => {
    if (
      !accountId
      || (
        cloudAgentRuntimeRouteMessages.length === 0
        && !canonicalSessionState?.messages.length
      )
    ) return;
    const animationFrame = window.requestAnimationFrame(() => {
      setRoutesBySessionId((current) => (
        applySynchronizedCloudAgentRuntimeRoutes(
          current,
          accountId,
          canonicalSessionState?.messages,
          cloudAgentRuntimeRouteMessages,
          defaultCloudAgentRuntimeRoute,
        )
      ));
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    accountId,
    canonicalSessionState?.messages,
    cloudAgentRuntimeRouteMessages,
    defaultCloudAgentRuntimeRoute,
    setRoutesBySessionId,
  ]);

  const activeRuntimeSessionId = cloudAgentRuntimeSessionId(
    accountId,
    activeConversationId,
  );
  const activeRuntimeRoute = activeRuntimeSessionId
    ? routesBySessionId[activeRuntimeSessionId]
    : null;
  const resolveChatRuntimeRoute = useCallback((sessionId?: string | null) => {
    const runtimeSessionId = cloudAgentRuntimeSessionId(accountId, sessionId);
    return compactCloudAgentRuntimeRoute(
      runtimeSessionId ? routesBySessionId[runtimeSessionId] : null,
    ) ?? compactCloudAgentRuntimeRoute(defaultCloudAgentRuntimeRoute);
  }, [accountId, defaultCloudAgentRuntimeRoute, routesBySessionId]);
  const inheritCloudAgentRuntimeRoute = useCallback((
    sourceSessionId?: string | null,
    targetSessionId?: string | null,
  ) => {
    const sourceRuntimeSessionId = cloudAgentRuntimeSessionId(
      accountId,
      sourceSessionId,
    );
    const targetRuntimeSessionId = cloudAgentRuntimeSessionId(
      accountId,
      targetSessionId,
    );
    if (!targetRuntimeSessionId) return;
    setRoutesBySessionId((current) => {
      const sourceRoute = compactCloudAgentRuntimeRoute(
        sourceRuntimeSessionId ? current[sourceRuntimeSessionId] : null,
      ) ?? compactCloudAgentRuntimeRoute(defaultCloudAgentRuntimeRoute);
      if (!sourceRoute) return current;
      return { ...current, [targetRuntimeSessionId]: sourceRoute };
    });
  }, [accountId, defaultCloudAgentRuntimeRoute, setRoutesBySessionId]);

  const setComposerSelections = composerUi.setComposerSelections;
  useEffect(() => {
    const model = activeRuntimeRoute?.model?.trim();
    if (!model) return;
    setComposerSelections((current) => {
      const thinking = activeRuntimeRoute?.thinking?.trim()
        || current.chat.thinking;
      if (
        current.chat.model === model
        && current.chat.thinking === thinking
      ) return current;
      return {
        ...current,
        chat: { ...current.chat, model, thinking },
      };
    });
  }, [
    activeRuntimeRoute?.model,
    activeRuntimeRoute?.thinking,
    setComposerSelections,
  ]);

  const publishCloudAgentRuntimeRouteChange = useCallback(async (
    input: CloudAgentRuntimeRouteChangeInput,
  ) => {
    const normalizedAccountId = accountId?.trim() ?? '';
    const sessionId = input.sessionId.trim();
    const model = input.model.trim();
    if (!normalizedAccountId || !sessionId || !model) {
      throw new Error('The Cloud session is still loading. Try again.');
    }
    const resolvedLocalRoute = resolveDefaultCloudAgentRuntimeRoute({
      activeLoginProviderId,
      authOptions: composerAuthByScope.optionsByScope.chat,
      chatModelOptions,
      desktopAuthState,
      isNativeShell,
      preferredModelValueForProvider,
      resolveComposerProviderId,
      selectedModel: model,
      selectedThinking: input.thinking,
    });
    const modelProvider = model.includes('/')
      ? model.slice(0, model.indexOf('/')).trim()
      : null;
    const requestedProvider = input.authProvider?.trim()
      || modelProvider
      || resolvedLocalRoute?.authProvider
      || null;
    const resolvedProvider = resolvedLocalRoute?.authProvider?.trim() ?? null;
    const providersMatch = Boolean(
      requestedProvider
      && resolvedProvider
      && canonicalCloudProviderId(requestedProvider)
        === canonicalCloudProviderId(resolvedProvider),
    );
    const requestedAuthOption = composerAuthByScope.optionsByScope.chat.find(
      (option) => option.value === input.authChoice
        && canonicalCloudProviderId(option.providerId)
          === canonicalCloudProviderId(requestedProvider),
    );
    const requestedAuthChoice = portableCloudAgentAuthChoice(
      input.authChoice,
      requestedAuthOption?.methodLabel,
    );
    const nextRoute = compactCloudAgentRuntimeRoute({
      model: requestedProvider && !model.includes('/')
        ? `${requestedProvider}/${model}`
        : model,
      thinking: input.thinking ?? resolvedLocalRoute?.thinking ?? null,
      authProvider: requestedProvider,
      authChoice: requestedAuthChoice
        ?? (providersMatch ? resolvedLocalRoute?.authChoice : null),
    });
    const runtimeSessionId = cloudAgentRuntimeSessionId(
      normalizedAccountId,
      sessionId,
    );
    if (!nextRoute || !runtimeSessionId) {
      throw new Error('Unable to resolve this session model route.');
    }
    if (!nextRoute.authProvider || !nextRoute.authChoice) {
      throw new Error(
        'Connect this model provider on the executing Mac before switching the session.',
      );
    }
    const previousRoute = routesBySessionId[runtimeSessionId];
    setRoutesBySessionId((current) => ({
      ...current,
      [runtimeSessionId]: nextRoute,
    }));
    if (isLocalDraftChatConversationId(sessionId)) return;

    const canonicalRouteSession = canonicalSessionState?.sessions.find(
      (session) => session.id === sessionId,
    );
    const routeConversationKind = canonicalRouteSession?.kind === 'group'
      ? 'group'
      : canonicalRouteSession?.kind === 'direct-person'
        || canonicalRouteSession?.kind === 'relationship'
        ? 'direct'
        : 'ai';
    const routeMemberAccountIds = canonicalSessionState
      ? canonicalSessionState.participants
        .filter((participant) => (
          participant.sessionId === sessionId
          && participant.state === 'active'
        ))
        .flatMap((participant) => {
          const identity = canonicalSessionState.identities.find(
            (candidate) => candidate.id === participant.identityId,
          );
          if (!identity || identity.kind !== 'human') return [];
          const memberAccountId = identity.humanId?.trim()
            || identity.sourceIdentityId?.trim()
            || '';
          return memberAccountId ? [memberAccountId] : [];
        })
      : [];
    try {
      await sendCloudCollaborationMessage(
        cloudCollaborationConversationId(
          normalizedAccountId,
          'agent',
          sessionId,
        ),
        encodeCloudAgentRuntimeRouteChange(nextRoute, previousRoute),
        [],
        {
          clientMessageId:
            `${CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND}:${sessionId}:${crypto.randomUUID()}`,
          messageKind: CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND,
          sharedTitle: input.initialSessionTitle,
          conversationKind: routeConversationKind,
          memberAccountIds: routeMemberAccountIds,
        },
      );
      if (input.initialSessionTitle?.trim()) {
        await updateCloudCollaborationSessionTitle(
          sessionId,
          input.initialSessionTitle,
        );
      }
    } catch (error) {
      setRoutesBySessionId((current) => {
        if (current[runtimeSessionId] !== nextRoute) return current;
        const next = { ...current };
        if (previousRoute) next[runtimeSessionId] = previousRoute;
        else delete next[runtimeSessionId];
        return next;
      });
      throw error;
    }
  }, [
    accountId,
    activeLoginProviderId,
    canonicalSessionState,
    chatModelOptions,
    composerAuthByScope.optionsByScope.chat,
    desktopAuthState,
    isNativeShell,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    routesBySessionId,
    sendCloudCollaborationMessage,
    setRoutesBySessionId,
    updateCloudCollaborationSessionTitle,
  ]);

  return {
    inheritCloudAgentRuntimeRoute,
    publishCloudAgentRuntimeRouteChange,
    resolveChatRuntimeRoute,
  };
}
