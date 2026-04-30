import type { DesktopBridgeAgent, DesktopBridgeHost, DesktopBridgeState, DesktopChatState } from '@/kordi-app/types';

export type LocalBridgeAgentRoutingOption = DesktopBridgeAgent & {
  hostId: string;
  hostLabel: string;
};

function compactModelValue(value?: string | null) {
  return value?.trim() || null;
}

function defaultRuntimeModelValue(desktopChatState?: DesktopChatState | null) {
  const provider = desktopChatState?.localAgent?.defaultProvider?.trim();
  const model = desktopChatState?.localAgent?.defaultModel?.trim();
  if (provider && model) return `${provider}/${model}`;
  return model || null;
}

export function localOwnedBridgeAgentsForModelRouting(
  hosts: DesktopBridgeHost[] | null | undefined,
  desktopChatState?: DesktopChatState | null,
): LocalBridgeAgentRoutingOption[] {
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

export function routingSelectionForBridgeAgent(agent: LocalBridgeAgentRoutingOption | DesktopBridgeAgent | null | undefined) {
  return {
    mode: 'My agent',
    model: compactModelValue(agent?.defaultModel) ?? '',
    authProvider: compactModelValue(agent?.defaultAuthProvider),
    authChoice: compactModelValue(agent?.defaultAuthChoice),
    fallbackModel: compactModelValue(agent?.fallbackModel),
    thinking: compactModelValue(agent?.thinking) ?? 'default',
  };
}

export function activeLocalBridgeAgent(bridgeState: Pick<DesktopBridgeState, 'activeHostId' | 'hosts'> | null | undefined) {
  const activeHost = bridgeState?.hosts.find((host) => host.id === bridgeState.activeHostId)
    ?? bridgeState?.hosts[0]
    ?? null;
  return activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
}

export function localAgentRuntimeRouteForBridgeState(
  bridgeState: Pick<DesktopBridgeState, 'activeHostId' | 'hosts'> | null | undefined,
  desktopChatState?: DesktopChatState | null,
) {
  const agent = activeLocalBridgeAgent(bridgeState);
  if (!agent) return null;
  return {
    model: compactModelValue(agent.defaultModel) ?? defaultRuntimeModelValue(desktopChatState),
    authProvider: compactModelValue(agent.defaultAuthProvider),
    authChoice: compactModelValue(agent.defaultAuthChoice),
    thinking: compactModelValue(agent.thinking),
  };
}

export function bridgeChatRoutingControlVisibility(agentCount: number) {
  return {
    showAgentSelector: agentCount > 1,
    showFallback: false,
  };
}

export function bridgeAgentRoutingChangeNotice({
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
    return bridgeAgentRoutingNotice({ agentLabel, modelLabel });
  }
  if (nextThinking !== undefined && compactModelValue(nextThinking) !== compactModelValue(currentThinking)) {
    return `${agentLabel} thinking set to ${thinkingLabel}. Only you can see this.`;
  }
  return null;
}

export function bridgeAgentRoutingNotice({
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
