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

    const configuredProviders = buildAuthDisplayProviders(desktopAuthState)
      .filter((provider) => provider.configured);

    if (configuredProviders.length === 0) {
      lastSwitchRef.current = null;
      return;
    }

    const normalizedCurrentProvider =
      normalizeSelectedProviderId(desktopChatState.activeSession.provider)
      ?? desktopChatState.activeSession.provider;
    const currentProviderIsConfigured = configuredProviders.some(
      (provider) => provider.id === normalizedCurrentProvider,
    );
    const currentProviderHasRuntimeModels = desktopChatState.modelOptions.some(
      (option) => (
        (
          normalizeSelectedProviderId(option.provider)
          ?? option.provider
        ) === normalizedCurrentProvider
      ),
    );

    if (currentProviderIsConfigured || currentProviderHasRuntimeModels) {
      lastSwitchRef.current = null;
      return;
    }

    const normalizedActiveLoginProviderId = normalizeSelectedProviderId(
      activeLoginProviderId,
    );
    const preferredConfiguredProvider =
      configuredProviders.find(
        (provider) => provider.id === normalizedActiveLoginProviderId,
      )
      ?? configuredProviders.find((provider) => (
        provider.methods.some((method) => (
          method.options.some((option) => option.active)
        ))
      ))
      ?? configuredProviders[0];

    if (!preferredConfiguredProvider) return;

    const nextModelValue = preferredModelValueForProvider(
      preferredConfiguredProvider.id,
    );
    if (!nextModelValue) return;

    const signature = [
      desktopChatState.activeSessionId,
      normalizedCurrentProvider,
      preferredConfiguredProvider.id,
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
      preferredConfiguredProvider.id,
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
