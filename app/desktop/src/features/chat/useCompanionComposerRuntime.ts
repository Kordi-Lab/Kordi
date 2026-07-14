import { useCallback, useEffect, useMemo, useState } from 'react';

import { normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import type { ComposerAuthOption, ComposerModelOption } from '@/kordi-app/components';
import type { DesktopChatSessionDetail } from '@/kordi-app/types';
import { fetchDesktopChatSessionDetail } from '@/lib/desktop';

import type { ComposerConfigTargetOverride, ComposerSelection } from './composerController.types';

type CompanionSessionDetail = Pick<DesktopChatSessionDetail, 'id' | 'provider' | 'model' | 'thinking'>;
type CompanionSessionDetailLoader = (sessionId: string) => Promise<CompanionSessionDetail | null>;

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
) {
  if (!selection) {
    return { label: 'Loading auth', options: [] as ComposerAuthOption[] };
  }

  const providerId = composerProviderIdForSelection(selection, modelOptions);
  const orderedOptions = [...authOptions].sort((left, right) => {
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
  loadSessionDetail?: CompanionSessionDetailLoader;
};

export function useCompanionComposerRuntime({
  enabled,
  isNativeShell,
  sessionId,
  fallbackMode,
  modelOptions,
  authOptions,
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
  const selection = localSelection?.sessionId === normalizedSessionId
    ? localSelection.selection
    : hydratedSelection;

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
    () => companionComposerAuthPresentation(selection, modelOptions, authOptions),
    [authOptions, modelOptions, selection],
  );
  const retry = useCallback(() => {
    setLoadAttempt((current) => current + 1);
  }, []);

  return {
    selection,
    configTarget,
    authLabel: authPresentation.label,
    authOptions: authPresentation.options,
    isLoading: Boolean(enabled && isNativeShell && normalizedSessionId && !selection && !loadError),
    loadError,
    retry,
  };
}
