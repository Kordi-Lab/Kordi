import { useCallback, useEffect, useMemo, useState } from 'react';

import { normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import type { ComposerAuthOption, ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type { DesktopChatSessionDetail } from '@/kordi-app/types';
import { fetchDesktopChatSessionDetail, type DesktopChatMessageRoute } from '@/lib/desktop';

import type { ComposerConfigTargetOverride, ComposerSelection } from './composerController.types';
import { ACCOUNT_UNAVAILABLE_LABEL, isAccountAuthChoice } from '@/features/cloud/routeAccountChoice';

type CompanionSessionDetail = Pick<DesktopChatSessionDetail, 'id' | 'provider' | 'model' | 'thinking'>;
type CompanionSessionDetailLoader = (sessionId: string) => Promise<CompanionSessionDetail | null>;

export function companionComposerProviderOptions(
  options: ComposerProviderOption[],
  route?: DesktopChatMessageRoute | null,
): ComposerProviderOption[] {
  if (!route?.authChoice || !isAccountAuthChoice(route.authChoice)) return options;
  const provider = route.authProvider ?? route.model?.split('/')[0] ?? '';
  const value = `${provider}::${route.authChoice}`;
  const presented = options.map((option) => ({
    ...option,
    active: normalizedProviderId(option.providerId) === normalizedProviderId(provider)
      && option.value.slice(option.value.indexOf('::') + 2) === route.authChoice,
  }));
  if (presented.some(option => option.active)) return presented;
  return [...presented, { value, providerId: provider, label: ACCOUNT_UNAVAILABLE_LABEL,
    selectionLabel: ACCOUNT_UNAVAILABLE_LABEL, active: true, disabled: true,
    disabledReason: 'Reconnect this account in Authentication or choose another account.' }];
}

function normalizedProviderId(value: string) {
  const trimmed = value.trim();
  return normalizeSelectedProviderId(trimmed) ?? trimmed;
}

function optionProviderId(option: ComposerModelOption) {
  const explicitProvider = option.provider?.trim() || option.value.split('/')[0]?.trim() || '';
  return normalizedProviderId(explicitProvider);
}

function optionModelId(option: ComposerModelOption, providerId: string) {
  const normalizedValue = option.value.trim();
  const [valueProvider, ...modelParts] = normalizedValue.split('/');
  if (modelParts.length > 0 && normalizedProviderId(valueProvider) === providerId) {
    return modelParts.join('/');
  }
  return option.label.trim() || normalizedValue;
}

export function companionComposerSelectionFromSessionDetail(
  detail: CompanionSessionDetail,
  modelOptions: ComposerModelOption[],
  fallbackMode: string,
): ComposerSelection {
  const providerId = normalizedProviderId(detail.provider);
  const modelId = detail.model.trim();
  const exactOption = modelOptions.find((option) => (
    optionProviderId(option) === providerId
    && optionModelId(option, providerId).toLowerCase() === modelId.toLowerCase()
  ));

  return {
    mode: fallbackMode,
    model: exactOption?.value ?? `${providerId}/${modelId}`,
    thinking: detail.thinking,
  };
}

function composerProviderIdForSelection(
  selection: ComposerSelection,
  modelOptions: ComposerModelOption[],
) {
  const exactOption = modelOptions.find((option) => option.value === selection.model);
  if (exactOption) return optionProviderId(exactOption);
  const explicitProvider = selection.model.split('/')[0]?.trim() || '';
  return normalizedProviderId(explicitProvider);
}

export function companionComposerAuthPresentation(
  selection: ComposerSelection | null,
  modelOptions: ComposerModelOption[],
  authOptions: ComposerAuthOption[],
  runtimeRoute?: DesktopChatMessageRoute | null,
) {
  if (!selection) {
    return { label: 'Loading auth', options: [] as ComposerAuthOption[] };
  }

  const providerId = composerProviderIdForSelection(selection, modelOptions);
  const presentedOptions = runtimeRoute?.authChoice
    ? authOptions.map((option) => ({ ...option, active: option.value === runtimeRoute.authChoice }))
    : authOptions;
  const orderedOptions = [...presentedOptions].sort((left, right) => {
    const leftIsCurrent = normalizedProviderId(left.providerId) === providerId;
    const rightIsCurrent = normalizedProviderId(right.providerId) === providerId;
    return Number(rightIsCurrent) - Number(leftIsCurrent);
  });
  const active = orderedOptions.find((option) => (
    normalizedProviderId(option.providerId) === providerId && option.active
  ));

  return {
    label: active
      ? [active.providerLabel, active.label].filter(Boolean).join(' · ')
      : (orderedOptions.length > 0 ? 'Select auth' : 'No auth'),
    options: orderedOptions,
  };
}

type UseCompanionComposerRuntimeArgs = {
  enabled: boolean;
  isNativeShell: boolean;
  sessionId: string | null;
  fallbackMode: string;
  modelOptions: ComposerModelOption[];
  authOptions: ComposerAuthOption[];
  providerOptions?: ComposerProviderOption[];
  runtimeRoute?: DesktopChatMessageRoute | null;
  loadSessionDetail?: CompanionSessionDetailLoader;
};

export function useCompanionComposerRuntime({
  enabled,
  isNativeShell,
  sessionId,
  fallbackMode,
  modelOptions,
  authOptions,
  providerOptions = [],
  runtimeRoute,
  loadSessionDetail = fetchDesktopChatSessionDetail,
}: UseCompanionComposerRuntimeArgs) {
  const normalizedSessionId = sessionId?.trim() || null;
  const [loadedDetail, setLoadedDetail] = useState<{
    sessionId: string;
    detail: CompanionSessionDetail;
  } | null>(null);
  const [localSelection, setLocalSelection] = useState<{
    sessionId: string;
    selection: ComposerSelection;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadedDetail(null);
    setLocalSelection(null);
    setLoadError(null);
    if (!enabled || !isNativeShell || !normalizedSessionId) return () => {};

    void loadSessionDetail(normalizedSessionId)
      .then((detail) => {
        if (cancelled) return;
        if (!detail || detail.id !== normalizedSessionId) {
          setLoadError('Unable to load model settings');
          return;
        }
        setLoadedDetail({ sessionId: normalizedSessionId, detail });
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadedDetail(null);
        setLoadError(error instanceof Error ? error.message : 'Unable to load model settings');
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, isNativeShell, loadAttempt, loadSessionDetail, normalizedSessionId]);

  const hydratedSelection = useMemo(() => (
    enabled
      && normalizedSessionId
      && loadedDetail?.sessionId === normalizedSessionId
      ? companionComposerSelectionFromSessionDetail(loadedDetail.detail, modelOptions, fallbackMode)
      : null
  ), [enabled, fallbackMode, loadedDetail, modelOptions, normalizedSessionId]);
  const routeSelection = enabled && normalizedSessionId && runtimeRoute?.model
    ? { mode: fallbackMode, model: runtimeRoute.model, thinking: runtimeRoute.thinking ?? hydratedSelection?.thinking ?? 'off' }
    : null;
  const selection = localSelection?.sessionId === normalizedSessionId
    ? localSelection.selection
    : routeSelection ?? hydratedSelection;

  const onSelectionChange = useCallback((nextSelection: ComposerSelection) => {
    if (!normalizedSessionId) return;
    setLocalSelection({ sessionId: normalizedSessionId, selection: nextSelection });
  }, [normalizedSessionId]);

  const configTarget = useMemo<Exclude<ComposerConfigTargetOverride, string | null> | null>(() => (
    normalizedSessionId && selection
      ? {
          sessionId: normalizedSessionId,
          selection,
          onSelectionChange,
        }
      : null
  ), [normalizedSessionId, onSelectionChange, selection]);
  const authPresentation = useMemo(
    () => companionComposerAuthPresentation(selection, modelOptions, authOptions, runtimeRoute),
    [authOptions, modelOptions, selection, runtimeRoute],
  );
  const presentedProviderOptions = useMemo(
    () => companionComposerProviderOptions(providerOptions, runtimeRoute),
    [providerOptions, runtimeRoute],
  );
  const retry = useCallback(() => {
    setLoadAttempt((current) => current + 1);
  }, []);

  return {
    selection,
    configTarget,
    authLabel: authPresentation.label,
    authOptions: authPresentation.options,
    providerOptions: presentedProviderOptions,
    isLoading: Boolean(enabled && isNativeShell && normalizedSessionId && !selection && !loadError),
    loadError,
    retry,
  };
}
