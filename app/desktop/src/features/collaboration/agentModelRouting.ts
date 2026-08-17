import type {
  DesktopCollaborationAgent,
  DesktopCollaborationAgentRouting,
  DesktopCollaborationHost,
  DesktopCollaborationState,
  DesktopChatState,
} from '@/kordi-app/types';

export type LocalCollaborationAgentRoutingOption = DesktopCollaborationAgent & {
  hostId: string;
  hostLabel: string;
};

export type ResolvedCollaborationAgentRouting = {
  defaultModel: string | null;
  defaultAuthProvider: string | null;
  defaultAuthChoice: string | null;
  fallbackModel: string | null;
  fallbackAuthProvider: string | null;
  fallbackAuthChoice: string | null;
  thinking: string | null;
};

export type CollaborationAgentRoutingUpdate = {
  routing: ResolvedCollaborationAgentRouting;
  defaultAuthChanged: boolean;
  fallbackAuthChanged: boolean;
};

function compactModelValue(value?: string | null) {
  return value?.trim() || null;
}

function explicitRoutingValue(
  nextValue: string | null | undefined,
  currentValue: string | null | undefined,
) {
  return nextValue !== undefined ? nextValue : currentValue ?? null;
}

export function resolveCollaborationAgentRoutingUpdate(
  current: DesktopCollaborationAgentRouting,
  patch: DesktopCollaborationAgentRouting,
): CollaborationAgentRoutingUpdate {
  const routing = {
    defaultModel: explicitRoutingValue(patch.defaultModel, current.defaultModel),
    defaultAuthProvider: explicitRoutingValue(patch.defaultAuthProvider, current.defaultAuthProvider),
    defaultAuthChoice: explicitRoutingValue(patch.defaultAuthChoice, current.defaultAuthChoice),
    fallbackModel: explicitRoutingValue(patch.fallbackModel, current.fallbackModel),
    fallbackAuthProvider: explicitRoutingValue(patch.fallbackAuthProvider, current.fallbackAuthProvider),
    fallbackAuthChoice: explicitRoutingValue(patch.fallbackAuthChoice, current.fallbackAuthChoice),
    thinking: explicitRoutingValue(patch.thinking, current.thinking),
  };

  return {
    routing,
    defaultAuthChanged: (
      patch.defaultAuthProvider !== undefined
      && routing.defaultAuthProvider !== (current.defaultAuthProvider ?? null)
    ) || (
      patch.defaultAuthChoice !== undefined
      && routing.defaultAuthChoice !== (current.defaultAuthChoice ?? null)
    ),
    fallbackAuthChanged: (
      patch.fallbackAuthProvider !== undefined
      && routing.fallbackAuthProvider !== (current.fallbackAuthProvider ?? null)
    ) || (
      patch.fallbackAuthChoice !== undefined
      && routing.fallbackAuthChoice !== (current.fallbackAuthChoice ?? null)
    ),
  };
}

function defaultRuntimeModelValue(desktopChatState?: DesktopChatState | null) {
  const provider = desktopChatState?.localAgent?.defaultProvider?.trim();
  const model = desktopChatState?.localAgent?.defaultModel?.trim();
  if (provider && model) return `${provider}/${model}`;
  return model || null;
}

export function localOwnedCollaborationAgentsForModelRouting(
  hosts: DesktopCollaborationHost[] | null | undefined,
  desktopChatState?: DesktopChatState | null,
): LocalCollaborationAgentRoutingOption[] {
  const runtimeDefault = defaultRuntimeModelValue(desktopChatState);
  return (hosts ?? []).flatMap((host) => host.agents.map((agent) => ({
    ...agent,
    hostId: host.id,
    hostLabel: host.displayName || host.ownerName || host.serverUrl,
    defaultModel: compactModelValue(agent.defaultModel) ?? runtimeDefault ?? null,
    defaultAuthProvider: compactModelValue(agent.defaultAuthProvider),
    defaultAuthChoice: compactModelValue(agent.defaultAuthChoice),
    fallbackModel: compactModelValue(agent.fallbackModel),
    fallbackAuthProvider: compactModelValue(agent.fallbackAuthProvider),
    fallbackAuthChoice: compactModelValue(agent.fallbackAuthChoice),
    thinking: compactModelValue(agent.thinking) ?? 'default',
  })));
}

export function routingSelectionForCollaborationAgent(agent: LocalCollaborationAgentRoutingOption | DesktopCollaborationAgent | null | undefined) {
  return {
    mode: 'My agent',
    model: compactModelValue(agent?.defaultModel) ?? '',
    authProvider: compactModelValue(agent?.defaultAuthProvider),
    authChoice: compactModelValue(agent?.defaultAuthChoice),
    fallbackModel: compactModelValue(agent?.fallbackModel),
    thinking: compactModelValue(agent?.thinking) ?? 'default',
  };
}

export function collaborationAgentWithSessionRoute(
  agent: LocalCollaborationAgentRoutingOption | null,
  route: { model?: string | null; thinking?: string | null } | null | undefined,
) {
  if (!agent) return null;
  return {
    ...agent,
    defaultModel: compactModelValue(route?.model) ?? agent.defaultModel,
    thinking: compactModelValue(route?.thinking) ?? agent.thinking,
  };
}

export function activeLocalCollaborationAgent(collaborationState: Pick<DesktopCollaborationState, 'activeHostId' | 'hosts'> | null | undefined) {
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  return activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
}

export function localAgentRuntimeRouteForCollaborationState(
  collaborationState: Pick<DesktopCollaborationState, 'activeHostId' | 'hosts'> | null | undefined,
  desktopChatState?: DesktopChatState | null,
) {
  const agent = activeLocalCollaborationAgent(collaborationState);
  if (!agent) return null;
  return {
    model: compactModelValue(agent.defaultModel) ?? defaultRuntimeModelValue(desktopChatState),
    authProvider: compactModelValue(agent.defaultAuthProvider),
    authChoice: compactModelValue(agent.defaultAuthChoice),
    thinking: compactModelValue(agent.thinking),
  };
}

export function collaborationChatRoutingControlVisibility(agentCount: number) {
  return {
    showAgentSelector: agentCount > 1,
    showFallback: false,
  };
}

export function collaborationAgentRoutingChangeNotice({
  agentLabel,
  currentModel,
  nextModel,
  currentThinking,
  nextThinking,
  modelLabel,
  thinkingLabel,
}: {
  agentLabel: string;
  currentModel?: string | null;
  nextModel?: string | null;
  currentThinking?: string | null;
  nextThinking?: string | null;
  modelLabel: string;
  thinkingLabel: string;
}) {
  if (nextModel !== undefined && compactModelValue(nextModel) !== compactModelValue(currentModel)) {
    return collaborationAgentRoutingNotice({ agentLabel, modelLabel });
  }
  if (nextThinking !== undefined && compactModelValue(nextThinking) !== compactModelValue(currentThinking)) {
    return `${agentLabel} thinking set to ${thinkingLabel}. Only you can see this.`;
  }
  return null;
}

export function collaborationAgentRoutingNotice({
  agentLabel,
  modelLabel,
  fallbackLabel,
}: {
  agentLabel: string;
  modelLabel: string;
  fallbackLabel?: string | null;
}) {
  const fallback = fallbackLabel?.trim()
    ? ` Fallback: ${fallbackLabel.trim()}.`
    : '';
  return `${agentLabel} model changed to ${modelLabel}.${fallback} Only you can see this.`;
}
