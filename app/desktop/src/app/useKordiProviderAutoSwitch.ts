import { useEffect, useRef } from 'react';

import {
  buildAuthDisplayProviders,
  normalizeSelectedProviderId,
} from '@/kordi-app/auth/model';
import type { ComposerSelectionOptions } from '@/features/chat/composerSelectionOrigin';
import { hasHostedOnlyPrefix } from '@/features/cloud/routeAccountChoice';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type {
  ComposerScope,
  DesktopAuthState,
  DesktopChatState,
} from '@/kordi-app/types';

type UseKordiProviderAutoSwitchArgs = {
  activeLoginProviderId: string | null;
  activeProjectSessionId: string;
  /** The chat conversation's session, whose route the chat composer runs with. */
  activeConversationSessionId?: string | null;
  desktopAuthState: DesktopAuthState | null;
  desktopChatState: DesktopChatState | null;
  isNativeShell: boolean;
  preferredModelValueForProvider: (providerId: string) => string | null;
  selectComposerValue: (
    scope: ComposerScope,
    type: 'provider',
    value: string,
    configTargetOverride: undefined,
    options: ComposerSelectionOptions,
  ) => unknown;
  /** The route a session runs with: its stored route, else the default route. */
  resolveSessionRoute?: (sessionId?: string | null) => DesktopChatMessageRoute | null;
};

function routeProviderId(route: DesktopChatMessageRoute) {
  const model = route.model?.trim() ?? '';
  return route.authProvider?.trim()
    || (model.includes('/') ? model.slice(0, model.indexOf('/')).trim() : '')
    || null;
}

export function providerAutoSwitchTarget({
  activeLoginProviderId,
  currentProviderId,
  desktopAuthState,
  sessionRoutes = [],
}: {
  activeLoginProviderId: string | null;
  currentProviderId: string | null | undefined;
  desktopAuthState: DesktopAuthState | null;
  /** Routes the session runs with; any usable one keeps the session as it is. */
  sessionRoutes?: ReadonlyArray<DesktopChatMessageRoute | null | undefined>;
}): string | null {
  if (!desktopAuthState) return null;
  const configuredProviders = buildAuthDisplayProviders(desktopAuthState)
    .filter((provider) => provider.configured);
  if (configuredProviders.length === 0) return null;

  // A hosted account runs on Kordi Cloud, so this Mac's providers do not matter.
  const routes = sessionRoutes.filter((route): route is DesktopChatMessageRoute => Boolean(route));
  if (routes.some((route) => hasHostedOnlyPrefix(route.authChoice))) return null;
  const providerIsConfigured = (providerId: string | null | undefined) => {
    const normalized = normalizeSelectedProviderId(providerId?.trim() || null);
    return Boolean(normalized) && configuredProviders.some(
      (provider) => (normalizeSelectedProviderId(provider.id) ?? provider.id) === normalized,
    );
  };
  if (
    providerIsConfigured(currentProviderId)
    || routes.some((route) => providerIsConfigured(routeProviderId(route)))
  ) {
    return null;
  }

  const normalizedActiveLoginProviderId = normalizeSelectedProviderId(
    activeLoginProviderId,
  );
  return (
    configuredProviders.find(
      (provider) => provider.id === normalizedActiveLoginProviderId,
    )
    ?? configuredProviders.find((provider) => (
      provider.methods.some((method) => (
        method.options.some((option) => option.active)
      ))
    ))
    ?? configuredProviders[0]
  )?.id ?? null;
}

export function useKordiProviderAutoSwitch({
  activeLoginProviderId,
  activeProjectSessionId,
  activeConversationSessionId,
  desktopAuthState,
  desktopChatState,
  isNativeShell,
  preferredModelValueForProvider,
  resolveSessionRoute,
  selectComposerValue,
}: UseKordiProviderAutoSwitchArgs) {
  const lastSwitchRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !isNativeShell
      || !desktopAuthState
      || !desktopChatState?.activeSessionId
    ) {
      return;
    }

    const scope =
      desktopChatState.activeSessionId === activeProjectSessionId
        ? 'project'
        : 'chat';
    const routeSessionIds = scope === 'chat' && activeConversationSessionId
      ? [desktopChatState.activeSessionId, activeConversationSessionId]
      : [desktopChatState.activeSessionId];
    const preferredConfiguredProviderId = providerAutoSwitchTarget({
      activeLoginProviderId,
      currentProviderId: desktopChatState.activeSession.provider,
      desktopAuthState,
      sessionRoutes: resolveSessionRoute
        ? routeSessionIds.map((sessionId) => resolveSessionRoute(sessionId))
        : [],
    });
    if (!preferredConfiguredProviderId) {
      lastSwitchRef.current = null;
      return;
    }

    const normalizedCurrentProvider =
      normalizeSelectedProviderId(desktopChatState.activeSession.provider)
      ?? desktopChatState.activeSession.provider;

    const nextModelValue = preferredModelValueForProvider(
      preferredConfiguredProviderId,
    );
    if (!nextModelValue) return;

    const signature = [
      desktopChatState.activeSessionId,
      normalizedCurrentProvider,
      preferredConfiguredProviderId,
      nextModelValue,
    ].join(':');

    if (lastSwitchRef.current === signature) return;
    lastSwitchRef.current = signature;

    // The person did not choose this provider, so the switch adds no notice.
    void selectComposerValue(
      scope,
      'provider',
      preferredConfiguredProviderId,
      undefined,
      { origin: 'automatic' },
    );
  }, [
    activeConversationSessionId,
    activeLoginProviderId,
    activeProjectSessionId,
    desktopAuthState,
    desktopChatState,
    isNativeShell,
    preferredModelValueForProvider,
    resolveSessionRoute,
    selectComposerValue,
  ]);
}
