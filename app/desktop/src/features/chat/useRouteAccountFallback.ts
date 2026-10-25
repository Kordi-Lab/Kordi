import { useEffect, useRef } from 'react';
import {
  unavailableAccountReplacement,
  type ComposerModelOption,
  type ComposerModelSelection,
  type ComposerRoute,
} from '@/kordi-app/components/composerModelSelection';
import { composerSendGate, useAccountListsLoaded, type ComposerSendGate, type ComposerSendGateInput } from './composerSendGate';

export type RouteAccountFallbackInput = ComposerSendGateInput & {
  selection: ComposerModelSelection & { thinking?: string | null };
  modelOptions: ComposerModelOption[];
};

/**
 * The route that replaces an account this device no longer has, under the
 * same conditions that block sending: a usable account with a model and
 * thinking level it offers. Null when the account is present, the lists have
 * not arrived, or no single usable account is clear; then the owner picks.
 */
export function routeAccountFallbackDecision(input: RouteAccountFallbackInput): ComposerRoute | null {
  if (!composerSendGate(input).blocked) return null;
  const route = unavailableAccountReplacement({
    selection: { ...input.selection, thinking: input.selection.thinking || 'default' },
    providerOptions: input.providerOptions,
    modelOptions: input.modelOptions,
  });
  return route?.providerOption ? route : null;
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

/** Saves a complete route, as a pick in the route menu does. */
export type ApplyFallbackRoute = (route: ComposerRoute) => unknown;

/** Moves a route off an unavailable account onto the clear replacement, once per session and account. */
export function useRouteAccountFallback({
  sessionId,
  enabled,
  applyRoute,
  ...input
}: RouteAccountFallbackInput & {
  sessionId: string | null | undefined;
  enabled: boolean;
  applyRoute: ApplyFallbackRoute;
}) {
  const appliedRef = useRef(new Set<string>());
  const route = enabled && sessionId ? routeAccountFallbackDecision(input) : null;
  const key = sessionId ? routeAccountFallbackKey(sessionId, input.selection) : '';
  // The applied keys keep a re-run, for example on a new callback, from applying twice.
  useEffect(() => {
    if (!route || !shouldApplyRouteAccountFallback(key, appliedRef.current)) return;
    void applyRoute(route);
  }, [applyRoute, key, route]);
}

/**
 * The live composer's send gate plus the automatic fallback: the gate still
 * blocks while no replacement account exists.
 */
export function useComposerRouteAccountGuard(
  input: Omit<RouteAccountFallbackInput, 'accountListsLoaded'> & {
    sessionId: string | null | undefined;
    enabled: boolean;
    applyRoute: ApplyFallbackRoute;
  },
): ComposerSendGate {
  const accountListsLoaded = useAccountListsLoaded();
  useRouteAccountFallback({ ...input, accountListsLoaded });
  return composerSendGate({ ...input, accountListsLoaded });
}
