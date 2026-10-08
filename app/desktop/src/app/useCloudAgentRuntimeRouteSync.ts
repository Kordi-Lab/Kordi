import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { cloudAgentRuntimeRouteMessageTarget } from '@/app/cloudAgentRuntimeRouteMessageTarget';
import { resolveDefaultCloudAgentRuntimeRoute } from '@/app/useKordiDefaultCloudAgentRuntimeRoute';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import {
  completeKordiCloudChatRequest,
  setActiveChatRoute,
  useKordiCloudChatRequest,
} from '@/features/chat/kordiCloudChatRoute';
import {
  applySynchronizedCloudAgentRuntimeRoutes,
  CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND,
  cloudAgentRuntimeSessionId,
  compactCloudAgentRuntimeRoute,
  encodeCloudAgentRuntimeRouteChange,
  type CloudAgentRuntimeRouteChangeInput,
} from '@/features/cloud/cloudAgentRuntime';
import { resolveCloudAgentRuntimeRouteChange } from '@/features/cloud/cloudAgentRuntimeRouteChange';
import { cloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { routeRunsOnKordiCloud, runtimeRoutesMatch } from '@/features/cloud/cloudAgentRuntimeRoute';
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

/** Show the route a new chat will actually use, while explicit session routes keep priority. */
export function chatComposerSelectionForRoute(
  current: ComposerUi['composerSelections'],
  activeRoute: DesktopChatMessageRoute | null,
  defaultRoute: DesktopChatMessageRoute | null,
) {
  const route = activeRoute?.model?.trim()
    ? activeRoute
    : routeRunsOnKordiCloud(defaultRoute) ? defaultRoute : null;
  const model = route?.model?.trim();
  if (!model) return current;
  const thinking = route?.thinking?.trim() || current.chat.thinking;
  if (current.chat.model === model && current.chat.thinking === thinking) return current;
  return { ...current, chat: { ...current.chat, model, thinking } };
}

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

  // The same history the effect above applies, read synchronously, so a send
  // or the composer right after startup never falls back to another route
  // while the restored session route is still one frame away.
  const recoveredRoutesBySessionId = useMemo(() => (
    accountId
      ? applySynchronizedCloudAgentRuntimeRoutes(
        {},
        accountId,
        canonicalSessionState?.messages,
        cloudAgentRuntimeRouteMessages,
        defaultCloudAgentRuntimeRoute,
      )
      : {}
  ), [accountId, canonicalSessionState?.messages, cloudAgentRuntimeRouteMessages, defaultCloudAgentRuntimeRoute]);
  const storedSessionRoute = useCallback((runtimeSessionId: string | null) => (
    runtimeSessionId
      ? compactCloudAgentRuntimeRoute(routesBySessionId[runtimeSessionId])
        ?? compactCloudAgentRuntimeRoute(recoveredRoutesBySessionId[runtimeSessionId])
      : null
  ), [recoveredRoutesBySessionId, routesBySessionId]);

  const activeRuntimeSessionId = cloudAgentRuntimeSessionId(
    accountId,
    activeConversationId,
  );
  const activeRuntimeRoute = storedSessionRoute(activeRuntimeSessionId);
  const activeRuntimeRouteKey = JSON.stringify(activeRuntimeRoute);
  const resolveChatRuntimeRoute = useCallback((sessionId?: string | null) => (
    storedSessionRoute(cloudAgentRuntimeSessionId(accountId, sessionId))
      ?? compactCloudAgentRuntimeRoute(defaultCloudAgentRuntimeRoute)
  ), [accountId, defaultCloudAgentRuntimeRoute, storedSessionRoute]);

  const sendRuntimeRouteChangeMessage = useCallback(async ({
    sessionId,
    route,
    previousRoute,
    synchronizationOnly,
    sharedTitle,
  }: {
    sessionId: string;
    route: DesktopChatMessageRoute;
    previousRoute?: DesktopChatMessageRoute | null;
    synchronizationOnly: boolean;
    sharedTitle?: string | null;
  }) => {
    const normalizedAccountId = accountId?.trim() ?? '';
    if (!normalizedAccountId) throw new Error('The Cloud session is still loading. Try again.');
    const target = cloudAgentRuntimeRouteMessageTarget(canonicalSessionState, sessionId);
    await sendCloudCollaborationMessage(
      cloudCollaborationConversationId(normalizedAccountId, 'agent', sessionId),
      encodeCloudAgentRuntimeRouteChange(route, previousRoute, synchronizationOnly),
      [],
      {
        clientMessageId:
          `${CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND}:${sessionId}:${crypto.randomUUID()}`,
        messageKind: CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND,
        sharedTitle,
        conversationKind: target.conversationKind,
        memberAccountIds: target.memberAccountIds,
      },
    );
  }, [accountId, canonicalSessionState, sendCloudCollaborationMessage]);

  // An inherited route lives only in memory until it is recorded, so a new
  // session records it once, silently, as soon as its real id is known.
  const recordedInheritedRouteSessionIdsRef = useRef(new Set<string>());
  const inheritCloudAgentRuntimeRoute = useCallback((
    sourceSessionId?: string | null,
    targetSessionId?: string | null,
  ) => {
    const targetRuntimeSessionId = cloudAgentRuntimeSessionId(
      accountId,
      targetSessionId,
    );
    if (!targetRuntimeSessionId) return;
    const inheritedRoute = storedSessionRoute(
      cloudAgentRuntimeSessionId(accountId, sourceSessionId),
    ) ?? compactCloudAgentRuntimeRoute(defaultCloudAgentRuntimeRoute);
    if (!inheritedRoute) return;
    setRoutesBySessionId((current) => ({ ...current, [targetRuntimeSessionId]: inheritedRoute }));
    const sessionId = targetSessionId?.trim() ?? '';
    const recorded = recordedInheritedRouteSessionIdsRef.current;
    if (
      !sessionId
      || isLocalDraftChatConversationId(sessionId)
      || !inheritedRoute.model
      || recorded.has(targetRuntimeSessionId)
      || recoveredRoutesBySessionId[targetRuntimeSessionId]
    ) return;
    recorded.add(targetRuntimeSessionId);
    void sendRuntimeRouteChangeMessage({
      sessionId,
      route: inheritedRoute,
      synchronizationOnly: true,
    }).catch(() => {
      // A later inheritance may retry; a hosted request still records its route.
      recorded.delete(targetRuntimeSessionId);
    });
  }, [
    accountId,
    defaultCloudAgentRuntimeRoute,
    recoveredRoutesBySessionId,
    sendRuntimeRouteChangeMessage,
    setRoutesBySessionId,
    storedSessionRoute,
  ]);

  const setComposerSelections = composerUi.setComposerSelections;
  useEffect(() => {
    const route = JSON.parse(activeRuntimeRouteKey) as DesktopChatMessageRoute | null;
    if (!route?.model?.trim() && !routeRunsOnKordiCloud(defaultCloudAgentRuntimeRoute)) return;
    setComposerSelections((current) => chatComposerSelectionForRoute(
      current,
      route,
      defaultCloudAgentRuntimeRoute,
    ));
  }, [
    activeRuntimeRouteKey,
    defaultCloudAgentRuntimeRoute,
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
    const nextRoute = resolveCloudAgentRuntimeRouteChange({
      authOptions: composerAuthByScope.optionsByScope.chat,
      input,
      resolvedLocalRoute,
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
    const previousRoute = storedSessionRoute(runtimeSessionId);
    const initializingSession = Boolean(input.initialSessionTitle?.trim());
    if (!initializingSession && runtimeRoutesMatch(previousRoute, nextRoute)) return;
    setRoutesBySessionId((current) => ({
      ...current,
      [runtimeSessionId]: nextRoute,
    }));
    if (isLocalDraftChatConversationId(sessionId)) return;

    try {
      await sendRuntimeRouteChangeMessage({
        sessionId,
        route: nextRoute,
        previousRoute,
        synchronizationOnly: initializingSession || Boolean(input.synchronizationOnly),
        sharedTitle: input.initialSessionTitle,
      });
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
    chatModelOptions,
    composerAuthByScope.optionsByScope.chat,
    desktopAuthState,
    isNativeShell,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    sendRuntimeRouteChangeMessage,
    setRoutesBySessionId,
    storedSessionRoute,
    updateCloudCollaborationSessionTitle,
  ]);

  // The composer marks the active chat's hosted account and shows when it runs on Kordi Cloud.
  const activeChatRoute = resolveChatRuntimeRoute(activeConversationId);
  const activeChatRouteKey = JSON.stringify(activeChatRoute);
  useEffect(() => { setActiveChatRoute(JSON.parse(activeChatRouteKey) as DesktopChatMessageRoute | null); }, [activeChatRouteKey]);

  // A chat opened from a provider page with a hosted-only account starts with
  // that account's route. The request stays until the route is applied, so a
  // session still loading never falls back to another account.
  const kordiCloudRequest = useKordiCloudChatRequest();
  const attemptedKordiCloudRequestRef = useRef<{ request: object; key: string } | null>(null);
  useEffect(() => {
    const sessionId = kordiCloudRequest?.sessionId ?? activeConversationId;
    const model = kordiCloudRequest?.route.model?.trim();
    if (!kordiCloudRequest || !sessionId || !model) return;
    // One attempt per session; a failed publish waits for the chat or account to change.
    const attemptKey = `${accountId ?? ''}\u0000${sessionId}`;
    const attempted = attemptedKordiCloudRequestRef.current;
    if (attempted?.request === kordiCloudRequest && attempted.key === attemptKey) return;
    attemptedKordiCloudRequestRef.current = { request: kordiCloudRequest, key: attemptKey };
    void publishCloudAgentRuntimeRouteChange({
      sessionId,
      model,
      authProvider: kordiCloudRequest.route.authProvider,
      authChoice: kordiCloudRequest.route.authChoice,
      thinking: kordiCloudRequest.route.thinking,
    }).then(() => completeKordiCloudChatRequest(kordiCloudRequest), () => undefined);
  }, [accountId, activeConversationId, kordiCloudRequest, publishCloudAgentRuntimeRouteChange]);

  return {
    inheritCloudAgentRuntimeRoute,
    publishCloudAgentRuntimeRouteChange,
    resolveChatRuntimeRoute,
  };
}
