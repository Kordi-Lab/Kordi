import { useEffect, useRef } from 'react';

import {
  buildAuthDisplayProviders,
  normalizeSelectedProviderId,
} from '@/kordi-app/auth/model';
import type {
  ComposerScope,
  DesktopAuthState,
  DesktopChatState,
} from '@/kordi-app/types';

type UseKordiProviderAutoSwitchArgs = {
  activeLoginProviderId: string | null;
  activeProjectSessionId: string;
  desktopAuthState: DesktopAuthState | null;
  desktopChatState: DesktopChatState | null;
  isNativeShell: boolean;
  preferredModelValueForProvider: (providerId: string) => string | null;
  selectComposerValue: (
    scope: ComposerScope,
    type: 'provider',
    value: string,
  ) => unknown;
};

export function providerAutoSwitchTarget({
  activeLoginProviderId,
  currentProviderId,
  desktopAuthState,
}: {
  activeLoginProviderId: string | null;
  currentProviderId: string | null | undefined;
  desktopAuthState: DesktopAuthState | null;
}): string | null {
  if (!desktopAuthState) return null;
  const configuredProviders = buildAuthDisplayProviders(desktopAuthState)
    .filter((provider) => provider.configured);
  if (configuredProviders.length === 0) return null;

  const normalizedCurrentProvider =
    normalizeSelectedProviderId(currentProviderId ?? null)
    ?? currentProviderId
    ?? null;
  if (configuredProviders.some(
    (provider) => provider.id === normalizedCurrentProvider,
  )) {
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
  desktopAuthState,
  desktopChatState,
  isNativeShell,
  preferredModelValueForProvider,
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

    const preferredConfiguredProviderId = providerAutoSwitchTarget({
      activeLoginProviderId,
      currentProviderId: desktopChatState.activeSession.provider,
      desktopAuthState,
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

    const scope =
      desktopChatState.activeSessionId === activeProjectSessionId
        ? 'project'
        : 'chat';
    void selectComposerValue(
      scope,
      'provider',
      preferredConfiguredProviderId,
    );
  }, [
    activeLoginProviderId,
    activeProjectSessionId,
    desktopAuthState,
    desktopChatState,
    isNativeShell,
    preferredModelValueForProvider,
    selectComposerValue,
  ]);
}
