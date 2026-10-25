import { registeredAccountChoices } from '@/features/cloud/hostedAccountRegistry';
import { useHostedAccountsSnapshot } from '@/features/cloud/hostedAccounts';
import { ACCOUNT_UNAVAILABLE_LABEL } from '@/features/cloud/routeAccountChoice';
import {
  isRouteAccountUnavailable,
  type ComposerModelSelection,
  type ComposerProviderOption,
} from '@/kordi-app/components/composerModelSelection';

export const ROUTE_ACCOUNT_UNAVAILABLE_NOTICE = `${ACCOUNT_UNAVAILABLE_LABEL}. Choose another account to continue.`;

export type ComposerSendGateInput = {
  paneKind: 'human' | 'agent' | null;
  canConfigureModelRoute: boolean;
  selection: ComposerModelSelection;
  providerOptions: ComposerProviderOption[];
  /** True once both this Mac's and Kordi Cloud's account lists have arrived. */
  accountListsLoaded: boolean;
};

export type ComposerSendGate = { blocked: boolean; notice: string | null };

/**
 * Whether the composer may send. Two rules:
 * - People and group chats always send; a broken agent route only affects the
 *   agent's turn, never a message for people.
 * - An agent chat blocks only once both account lists have arrived, so a slow
 *   or failed load never blocks a send.
 */
export function composerSendGate(input: ComposerSendGateInput): ComposerSendGate {
  const blocked = input.paneKind === 'agent'
    && input.canConfigureModelRoute
    && input.accountListsLoaded
    && isRouteAccountUnavailable(input.selection, input.providerOptions);
  return { blocked, notice: blocked ? ROUTE_ACCOUNT_UNAVAILABLE_NOTICE : null };
}

/** True once both this Mac's and Kordi Cloud's account lists have arrived; re-renders when the hosted list does. */
export function useAccountListsLoaded(): boolean {
  const hostedListed = Boolean(useHostedAccountsSnapshot().listed);
  return hostedListed && registeredAccountChoices().localChoices !== null;
}

/** The send gate for the live composer, re-evaluated when the hosted account list arrives. */
export function useComposerSendGate(input: Omit<ComposerSendGateInput, 'accountListsLoaded'>): ComposerSendGate {
  const accountListsLoaded = useAccountListsLoaded();
  return composerSendGate({ ...input, accountListsLoaded });
}
