import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { CloudAgentRuntimeRouteChangeInput } from '@/features/cloud/cloudAgentRuntime';
import { routeRunsOnKordiCloud, runtimeRoutesMatch } from '@/features/cloud/cloudAgentRuntimeRoute';
import { registeredAccountChoices } from '@/features/cloud/hostedAccountRegistry';
import { hostedAccountsState } from '@/features/cloud/hostedAccounts';
import type { OmpCatalogEntry } from '@/kordi-app/auth/ompCatalog';
import type { ComposerScope } from '@/kordi-app/types';
import { updateDesktopChatSessionConfig, type DesktopChatMessageRoute } from '@/lib/desktop';
import type { ComposerSelectionState } from './composerController.types';
import { hostedRouteAccounts, hostedRouteForChoice, hostedRouteForModel, type HostedRouteAccount } from './hostedComposerOptions';

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
    return onCloud && change.model
      ? { route: { model: change.model, authProvider: choice.providerId, authChoice: choice.authChoice, thinking: change.thinking }, leavesCloud: true }
      : null;
  }
  if (!change.model) {
    return onCloud && context.currentRoute && change.thinking
      ? { route: { ...context.currentRoute, thinking: change.thinking }, leavesCloud: false }
      : null;
  }
  const hosted = hostedRouteForModel({
    accounts: context.accounts, model: change.model, thinking: change.thinking,
    currentRoute: context.currentRoute, localProviderIds: context.localProviderIds,
  });
  if (hosted) return { route: hosted, leavesCloud: false };
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
  const appliedRef = useRef<{ sessionId: string; route: DesktopChatMessageRoute; atMs: number } | null>(null);

  return useCallback(async (scope: ComposerScope, sessionId: string | null | undefined, change: ComposerRouteChange) => {
    if (!isNativeShell || scope !== 'chat' || !sessionId || !publishCloudAgentRuntimeRouteChange) return false;
    const stored = resolveChatRuntimeRoute?.(sessionId) ?? null;
    const applied = appliedRef.current;
    const currentRoute = applied?.sessionId === sessionId && Date.now() - applied.atMs < APPLIED_ROUTE_FRESH_MS
      && !runtimeRoutesMatch(stored ?? undefined, applied.route) ? applied.route : stored;
    const { accounts, catalog } = hostedAccountsState();
    const registry = registeredAccountChoices();
    const decision = composerRouteDecision(change, {
      accounts: hostedRouteAccounts(accounts, catalog, registry.localChoices),
      currentRoute,
      localProviderIds: registry.localProviderIds,
      catalog,
    });
    const model = decision?.route.model?.trim();
    if (!decision || !model) return false;
    let previous: ComposerSelectionState | null = null;
    setComposerSelections((current) => {
      previous = current;
      return { ...current, chat: { ...current.chat, model, ...(decision.route.thinking ? { thinking: decision.route.thinking } : {}) } };
    });
    appliedRef.current = { sessionId, route: decision.route, atMs: Date.now() };
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
      appliedRef.current = null;
      if (previous) {
        const restored: ComposerSelectionState = previous;
        setComposerSelections(() => restored);
      }
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to update session');
    }
    return true;
  }, [isNativeShell, publishCloudAgentRuntimeRouteChange, resolveChatRuntimeRoute, setComposerSelections, setDesktopChatError]);
}
