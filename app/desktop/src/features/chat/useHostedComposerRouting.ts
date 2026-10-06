import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { CloudAgentRuntimeRouteChangeInput } from '@/features/cloud/cloudAgentRuntime';
import { routeRunsOnKordiCloud, runtimeRoutesMatch } from '@/features/cloud/cloudAgentRuntimeRoute';
import { registeredAccountChoices } from '@/features/cloud/hostedAccountRegistry';
import { hostedAccountsState } from '@/features/cloud/hostedAccounts';
import type { OmpCatalogEntry } from '@/kordi-app/auth/ompCatalog';
import type { ComposerScope } from '@/kordi-app/types';
import { updateDesktopChatSessionConfig, type DesktopChatMessageRoute } from '@/lib/desktop';
import type { ComposerConfigTargetOverride, ComposerSelectionState } from './composerController.types';
import { hostedRouteAccounts, hostedRouteForChoice, hostedRouteForModel, type HostedRouteAccount } from './hostedComposerOptions';
import { normalizeComposerProviderId } from '@/kordi-app/components/composerModelSelection';

/** The route a composer change applies; `leavesCloud` moves the session back to this Mac's runtime. */
export type ComposerRouteDecision = { route: DesktopChatMessageRoute; leavesCloud: boolean };

export type ComposerRouteChange = {
  /** A model the change selects; null when only the account or thinking changes. */
  model: string | null;
  thinking: string | null;
  /** An explicit account choice from the provider or account menu. */
  choice?: { providerId: string; authChoice: string | null } | null;
};

/**
 * Decides whether a composer change runs on Kordi Cloud. Choosing a hosted
 * account applies its route, as Start chat does; choosing a local account or a
 * model this Mac serves returns to the local runtime; any other change that
 * stays on the local path returns null.
 */
export function composerRouteDecision(
  change: ComposerRouteChange,
  context: {
    accounts: HostedRouteAccount[];
    currentRoute: DesktopChatMessageRoute | null;
    localProviderIds?: ReadonlySet<string>;
    catalog?: OmpCatalogEntry[];
    pinLocalAccount?: boolean;
  },
): ComposerRouteDecision | null {
  const onCloud = routeRunsOnKordiCloud(context.currentRoute);
  const choice = change.choice;
  if (choice?.authChoice) {
    const hosted = context.accounts.find((account) => account.authChoice === choice.authChoice);
    if (hosted) {
      const route = hostedRouteForChoice(hosted, { model: change.model, thinking: change.thinking, catalog: context.catalog });
      return route ? { route, leavesCloud: false } : null;
    }
    return (onCloud || context.pinLocalAccount) && change.model
      ? { route: { model: change.model, authProvider: choice.providerId, authChoice: choice.authChoice, thinking: change.thinking }, leavesCloud: onCloud }
      : null;
  }
  if (!change.model) {
    return (onCloud || context.pinLocalAccount) && context.currentRoute && change.thinking
      ? { route: { ...context.currentRoute, thinking: change.thinking }, leavesCloud: false }
      : null;
  }
  const hosted = hostedRouteForModel({
    accounts: context.accounts, model: change.model, thinking: change.thinking,
    currentRoute: context.currentRoute, localProviderIds: context.localProviderIds,
  });
  if (hosted) return { route: hosted, leavesCloud: false };
  if (context.pinLocalAccount && context.currentRoute?.authChoice
    && normalizeComposerProviderId(change.model.split('/')[0])
      === normalizeComposerProviderId(context.currentRoute.authProvider ?? context.currentRoute.model?.split('/')[0] ?? '')) {
    return { route: { ...context.currentRoute, model: change.model, thinking: change.thinking }, leavesCloud: false };
  }
  return onCloud ? { route: { model: change.model, thinking: change.thinking }, leavesCloud: true } : null;
}

const APPLIED_ROUTE_FRESH_MS = 5_000;

/** Applies Kordi Cloud routes for composer changes through the session route machinery. */
export function useHostedComposerRouting({
  isNativeShell,
  setComposerSelections,
  setDesktopChatError,
  publishCloudAgentRuntimeRouteChange,
  resolveChatRuntimeRoute,
}: {
  isNativeShell: boolean;
  setComposerSelections: Dispatch<SetStateAction<ComposerSelectionState>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  publishCloudAgentRuntimeRouteChange?: (input: CloudAgentRuntimeRouteChangeInput) => Promise<void>;
  resolveChatRuntimeRoute?: (sessionId?: string | null) => DesktopChatMessageRoute | null;
}) {
  // A route applied moments ago wins until the session state catches up, so
  // an account choice followed by a model choice keeps the chosen account.
  const appliedRef = useRef(new Map<string, { route: DesktopChatMessageRoute; atMs: number }>());

  return useCallback(async (
    scope: ComposerScope,
    sessionId: string | null | undefined,
    change: ComposerRouteChange,
    isolatedTarget?: Exclude<ComposerConfigTargetOverride, string | null> | null,
  ) => {
    if (!isNativeShell || scope !== 'chat' || !sessionId || !publishCloudAgentRuntimeRouteChange) return false;
    const stored = resolveChatRuntimeRoute?.(sessionId) ?? null;
    const applied = appliedRef.current.get(sessionId);
    const currentRoute = applied && Date.now() - applied.atMs < APPLIED_ROUTE_FRESH_MS
      && !runtimeRoutesMatch(stored ?? undefined, applied.route) ? applied.route : stored;
    const { accounts, catalog } = hostedAccountsState();
    const registry = registeredAccountChoices();
    const decision = composerRouteDecision(change, {
      accounts: hostedRouteAccounts(accounts, catalog, registry.localChoices),
      currentRoute,
      localProviderIds: registry.localProviderIds,
      catalog,
      pinLocalAccount: Boolean(isolatedTarget),
    });
    const model = decision?.route.model?.trim();
    if (!decision || !model) return false;
    let previous: ComposerSelectionState | null = null;
    if (isolatedTarget) isolatedTarget.onSelectionChange({
      ...isolatedTarget.selection, model,
      ...(decision.route.thinking ? { thinking: decision.route.thinking } : {}),
    });
    else setComposerSelections((current) => {
      previous = current;
      return { ...current, chat: { ...current.chat, model, ...(decision.route.thinking ? { thinking: decision.route.thinking } : {}) } };
    });
    const pending = { route: decision.route, atMs: Date.now() };
    appliedRef.current.set(sessionId, pending);
    try {
      setDesktopChatError(null);
      if (decision.leavesCloud) await updateDesktopChatSessionConfig(sessionId, model, decision.route.thinking ?? undefined);
      await publishCloudAgentRuntimeRouteChange({
        sessionId,
        model,
        authProvider: decision.route.authProvider,
        authChoice: decision.route.authChoice,
        thinking: decision.route.thinking,
      });
    } catch (error) {
      if (appliedRef.current.get(sessionId) !== pending) return true;
      appliedRef.current.delete(sessionId);
      if (isolatedTarget) isolatedTarget.onSelectionChange(isolatedTarget.selection);
      else if (previous) {
        const restored: ComposerSelectionState = previous;
        setComposerSelections((current) => current.chat.model === model
          && current.chat.thinking === (decision.route.thinking ?? restored.chat.thinking)
          ? { ...current, chat: restored.chat }
          : current);
      }
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to update session');
    }
    return true;
  }, [isNativeShell, publishCloudAgentRuntimeRouteChange, resolveChatRuntimeRoute, setComposerSelections, setDesktopChatError]);
}
