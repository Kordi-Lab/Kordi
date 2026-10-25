import { useEffect, useRef } from 'react';
import {
  unavailableAccountReplacement,
  type ComposerModelOption,
  type ComposerModelSelection,
  type ComposerProviderOption,
} from '@/kordi-app/components/composerModelSelection';
import { composerSendGate, useAccountListsLoaded, type ComposerSendGate, type ComposerSendGateInput } from './composerSendGate';

export type RouteAccountFallbackInput = ComposerSendGateInput & {
  selection: ComposerModelSelection & { thinking?: string | null };
  modelOptions: ComposerModelOption[];
};

/**
 * The account that replaces one this device no longer has, under the same
 * conditions that block sending. Null when the account is present, the lists
 * have not arrived, or no single usable account is clear; then the owner picks.
 */
export function routeAccountFallbackDecision(input: RouteAccountFallbackInput): ComposerProviderOption | null {
  if (!composerSendGate(input).blocked) return null;
  return unavailableAccountReplacement({
    selection: { ...input.selection, thinking: input.selection.thinking || 'default' },
    providerOptions: input.providerOptions,
    modelOptions: input.modelOptions,
  })?.providerOption ?? null;
}

/** The key one automatic fallback is applied under, at most once. */
export function routeAccountFallbackKey(sessionId: string, selection: ComposerModelSelection) {
  return `${sessionId}|${selection.authProvider ?? ''}|${selection.authChoice ?? ''}`;
}

/** Records the key and returns true the first time it is seen. */
export function shouldApplyRouteAccountFallback(key: string, appliedKeys: Set<string>) {
  if (appliedKeys.has(key)) return false;
  appliedKeys.add(key);
  return true;
}

export type ApplyProviderChoice = (scope: 'chat', option: ComposerProviderOption) => unknown;

/** Moves a route off an unavailable account onto the clear replacement, once per session and account. */
export function useRouteAccountFallback({
  sessionId,
  scope = 'chat',
  enabled,
  applyProviderChoice,
  ...input
}: RouteAccountFallbackInput & {
  sessionId: string | null | undefined;
  scope?: 'chat';
  enabled: boolean;
  applyProviderChoice: ApplyProviderChoice;
}) {
  const appliedRef = useRef(new Set<string>());
  const option = enabled && sessionId ? routeAccountFallbackDecision(input) : null;
  const key = sessionId ? routeAccountFallbackKey(sessionId, input.selection) : '';
  // The applied keys keep a re-run, for example on a new callback, from applying twice.
  useEffect(() => {
    if (!option || !shouldApplyRouteAccountFallback(key, appliedRef.current)) return;
    void applyProviderChoice(scope, option);
  }, [applyProviderChoice, key, option, scope]);
}

/**
 * The live composer's send gate plus the automatic fallback: the gate still
 * blocks while no replacement account exists.
 */
export function useComposerRouteAccountGuard(
  input: Omit<RouteAccountFallbackInput, 'accountListsLoaded'> & {
    sessionId: string | null | undefined;
    enabled: boolean;
    applyProviderChoice: ApplyProviderChoice;
  },
): ComposerSendGate {
  const accountListsLoaded = useAccountListsLoaded();
  useRouteAccountFallback({ ...input, accountListsLoaded });
  return composerSendGate({ ...input, accountListsLoaded });
}
