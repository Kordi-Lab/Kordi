import { useEffect, useRef } from 'react';
import {
  unavailableAccountReplacement,
  type ComposerModelOption,
  type ComposerModelSelection,
  type ComposerRoute,
} from '@/kordi-app/components/composerModelSelection';
import { registeredAccountChoices } from '@/features/cloud/hostedAccountRegistry';
import { composerSendGate, useAccountListsLoaded, type ComposerSendGate, type ComposerSendGateInput } from './composerSendGate';

export type RouteAccountFallbackInput = ComposerSendGateInput & {
  selection: ComposerModelSelection & { thinking?: string | null };
  modelOptions: ComposerModelOption[];
  /** Account choices this Mac or Kordi Cloud lists, whatever their models; such an account is not gone. */
  knownAccountChoices?: ReadonlySet<string>;
};

/** How long a fallback decision must hold before it is applied, so a chat switch settles first. */
export const ROUTE_ACCOUNT_FALLBACK_SETTLE_MS = 600;

/**
 * The route that replaces an account this device no longer has, under the
 * same conditions that block sending: a usable account with a model and
 * thinking level it offers. Null when the account is present, the lists have
 * not arrived, or no single usable account is clear; then the owner picks.
 */
export function routeAccountFallbackDecision(input: RouteAccountFallbackInput): ComposerRoute | null {
  if (!composerSendGate(input).blocked || input.modelOptions.length === 0) return null;
  // The provider options leave out accounts whose models have not loaded; only a removed account falls back.
  const choice = input.selection.authChoice?.trim();
  if (choice && input.knownAccountChoices?.has(choice)) return null;
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

/**
 * Moves a route off an unavailable account onto the clear replacement, once
 * per session and account. The decision must hold for `settleMs`: right after
 * a chat switch the selection can still be the previous chat's for a render.
 */
export function useRouteAccountFallback({
  sessionId,
  enabled,
  applyRoute,
  settleMs = ROUTE_ACCOUNT_FALLBACK_SETTLE_MS,
  ...input
}: RouteAccountFallbackInput & {
  sessionId: string | null | undefined;
  enabled: boolean;
  applyRoute: ApplyFallbackRoute;
  settleMs?: number;
}) {
  const appliedRef = useRef(new Set<string>());
  const route = enabled && sessionId ? routeAccountFallbackDecision(input) : null;
  const key = sessionId ? routeAccountFallbackKey(sessionId, input.selection) : '';
  const decision = route ? JSON.stringify([key, route.providerOption?.value, route.model, route.thinking]) : '';
  const latest = useRef({ route, applyRoute });
  useEffect(() => { latest.current = { route, applyRoute }; });
  useEffect(() => {
    if (!decision) return;
    const timer = setTimeout(() => {
      const current = latest.current.route;
      if (!current || !shouldApplyRouteAccountFallback(key, appliedRef.current)) return;
      // A refused save, for example while a turn starts, may try again on the next decision.
      void Promise.resolve(latest.current.applyRoute(current)).then((applied) => {
        if (applied === false) appliedRef.current.delete(key);
      }, () => { appliedRef.current.delete(key); });
    }, settleMs);
    return () => clearTimeout(timer);
  }, [decision, key, settleMs]);
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
  const { hostedChoices, localChoices } = registeredAccountChoices();
  const knownAccountChoices = new Set([...hostedChoices, ...(localChoices ?? [])]);
  useRouteAccountFallback({ ...input, accountListsLoaded, knownAccountChoices });
  return composerSendGate({ ...input, accountListsLoaded });
}
