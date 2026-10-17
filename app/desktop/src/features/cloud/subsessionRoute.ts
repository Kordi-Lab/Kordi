import { useState } from 'react';

import { hostedRouteAccounts } from '@/features/chat/hostedComposerOptions';
import { composerRouteDecision } from '@/features/chat/useHostedComposerRouting';
import type { CompactComposerModelMenuSaveInput } from '@/kordi-app/components/composer';
import {
  normalizeComposerProviderId,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '@/kordi-app/components/composerModelSelection';
import { fallbackComposerThinkingValue } from '@/kordi-app/components/composerThinking';
import type { MessageMention } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

import type { CloudAgentSubsession } from './agentSubsessionTypes';
import { runtimeRoute } from './cloudGroupDecoding';
import { registeredAccountChoices } from './hostedAccountRegistry';
import { hostedAccountsState } from './hostedAccounts';

/**
 * Whether a message runs the thread's Agent, as the server decides: an
 * explicit mention of it, or a message with no mentions from its owner, who is
 * talking to their own Agent. Other members' plain messages are context.
 */
export function subsessionMessageRunsAgent(
  record: Pick<CloudAgentSubsession, 'agentId' | 'ownerAccountId'>,
  accountId: string,
  mentions: MessageMention[],
) {
  return mentions.some((mention) => mention.targetKind === 'agent' && mention.agentId === record.agentId)
    || (record.ownerAccountId === accountId && mentions.length === 0);
}

/** The route a save in the route menu chooses; a saved hosted account applies its own route. */
export function subsessionRouteAfterSave(
  current: DesktopChatMessageRoute | null,
  input: CompactComposerModelMenuSaveInput,
): DesktopChatMessageRoute {
  const option = input.providerOption;
  const authChoice = option?.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
  const { accounts, catalog } = hostedAccountsState();
  const registry = registeredAccountChoices();
  const decision = composerRouteDecision({
    model: input.model,
    thinking: input.thinking,
    choice: option ? { providerId: option.providerId, authChoice } : null,
  }, {
    accounts: hostedRouteAccounts(accounts, catalog, registry.localChoices),
    currentRoute: current,
    localProviderIds: registry.localProviderIds,
    catalog,
    pinLocalAccount: true,
  });
  // A model from another provider leaves the current provider's account behind.
  const keepsAccount = !option && Boolean(current?.authProvider) && providerOf(input.model)
    === normalizeComposerProviderId(current?.authProvider ?? '');
  return decision?.route ?? {
    model: input.model,
    thinking: input.thinking,
    authProvider: option ? option.providerId : keepsAccount ? current?.authProvider ?? null : null,
    authChoice: option ? authChoice : keepsAccount ? current?.authChoice ?? null : null,
  };
}

function providerOf(model: string) {
  return normalizeComposerProviderId(model.split('/')[0] ?? '');
}

export type SubsessionRouteChange =
  | { type: 'model' | 'thinking'; value: string }
  | { type: 'provider'; option: ComposerProviderOption };

/** One change in the provider, model, or thinking menu as a route save. */
export function subsessionRouteInput(
  selection: { model: string; thinking: string },
  change: SubsessionRouteChange,
  modelOptions: ComposerModelOption[] = [],
): CompactComposerModelMenuSaveInput {
  if (change.type !== 'provider') {
    if (change.type === 'thinking') return { providerOption: null, model: selection.model, thinking: change.value };
    const levels = modelOptions.find((option) => option.value === change.value)?.thinkingLevels ?? [];
    return { providerOption: null, model: change.value, thinking: fallbackComposerThinkingValue(levels, selection.thinking) };
  }
  const provider = normalizeComposerProviderId(change.option.providerId);
  const model = providerOf(selection.model) === provider
    ? selection.model
    : modelOptions.find((option) => providerOf(option.provider ?? option.value) === provider)?.value ?? selection.model;
  return { providerOption: change.option, model, thinking: selection.thinking };
}

/** The route menu's selection for a thread route, filled from the main composer where unset. */
export function subsessionRouteSelection(
  route: DesktopChatMessageRoute | null,
  fallback: { model: string; thinking: string },
) {
  return {
    mode: 'agent',
    model: route?.model?.trim() || fallback.model,
    thinking: route?.thinking?.trim() || fallback.thinking,
    authProvider: route?.authProvider ?? null,
    authChoice: route?.authChoice ?? null,
  };
}

/** The server's run route shape for a thread message. */
export function subsessionRuntimeRouteBody(route: DesktopChatMessageRoute | null | undefined) {
  if (!route?.model?.trim()) return undefined;
  return {
    defaultModel: route.model,
    ...(route.authProvider ? { defaultAuthProvider: route.authProvider } : {}),
    ...(route.authChoice ? { defaultAuthChoice: route.authChoice } : {}),
    ...(route.thinking ? { thinking: route.thinking } : {}),
  };
}

/**
 * The owner's route for the thread's next run: the one chosen here, else the
 * one the thread's latest run used. Only a chosen route is sent; otherwise the
 * server keeps the thread's current route.
 */
export function useSubsessionRoute(record: CloudAgentSubsession | null, accountId: string) {
  const [chosen, setChosen] = useState<{ id: string; route: DesktopChatMessageRoute } | null>(null);
  const owner = Boolean(record && accountId && record.ownerAccountId === accountId);
  const chosenRoute = owner && chosen && chosen.id === record?.sessionId ? chosen.route : null;
  return {
    owner,
    chosen: chosenRoute,
    route: chosenRoute ?? (owner ? runtimeRoute(record?.runtimeRoute) : null),
    choose: (input: CompactComposerModelMenuSaveInput, current: DesktopChatMessageRoute | null) => {
      if (record && owner) setChosen({ id: record.sessionId, route: subsessionRouteAfterSave(current, input) });
    },
  };
}
