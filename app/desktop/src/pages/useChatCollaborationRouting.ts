import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  collaborationAgentRoutingChangeNotice,
  collaborationAgentWithSessionRoute,
  collaborationChatRoutingControlVisibility,
  localOwnedCollaborationAgentsForModelRouting,
  resolveCollaborationAgentRoutingUpdate,
  routingSelectionForCollaborationAgent,
  type LocalCollaborationAgentRoutingOption,
} from '@/features/collaboration/agentModelRouting';
import { isCloudCollaborationHostId } from '@/features/cloud/cloudCollaborationState';
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextarea,
} from '@/features/chat/composerController.shared';
import {
  fallbackComposerThinkingValue,
  type ComposerModelOption,
  type ComposerProviderOption,
  type CompactComposerModelMenuSaveInput,
} from '@/kordi-app/components';
import type {
  Conversation,
  DesktopChatState,
  DesktopCollaborationAgentRouting,
  DesktopCollaborationHost,
} from '@/kordi-app/types';
import {
  authChoiceFromProviderOption,
  collaborationRouteDisplayName,
  collaborationThinkingDisplayName,
} from '@/pages/chatsPage.model';
import {
  COLLABORATION_ROUTING_NOTICE_AUTO_DISMISS_MS,
} from '@/pages/chatsPage.constants';

type ComposerSelector = {
  scope: 'chat' | 'project';
  type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking';
};

type RoutingPatch = DesktopCollaborationAgentRouting & {
  selectorType?: 'provider' | 'model' | 'thinking';
};

type RoutingTargetInput = {
  conversation: Conversation | null;
  host: DesktopCollaborationHost | null;
  enabled: boolean;
  isBusy: boolean;
};

type UseChatCollaborationRoutingInput = {
  shared: {
    desktopChatState: DesktopChatState | null;
    modelOptions?: ComposerModelOption[];
    providerOptions: ComposerProviderOption[];
    updateRouting: (
      hostId: string,
      agentId: string,
      defaultModel?: string | null,
      fallbackModel?: string | null,
      thinking?: string | null,
      defaultAuthProvider?: string | null,
      defaultAuthChoice?: string | null,
      fallbackAuthProvider?: string | null,
      fallbackAuthChoice?: string | null,
      targetSessionIdOverride?: string | null,
    ) => Promise<void>;
  };
  main: RoutingTargetInput & {
    openSelector: ComposerSelector | null;
    toggleSelector: (scope: 'chat', type: ComposerSelector['type']) => void;
    composerSelection: { model: string; thinking: string };
    selectComposerProviderChoice: (
      scope: 'chat',
      option: ComposerProviderOption,
    ) => void | Promise<void>;
    selectComposerValue: (
      scope: 'chat',
      type: 'model' | 'thinking',
      value: string,
    ) => void | Promise<void>;
  };
  companion: RoutingTargetInput & {
    openSelector: ComposerSelector | null;
    setOpenSelector: Dispatch<SetStateAction<ComposerSelector | null>>;
  };
};

function routingKey(
  agent: LocalCollaborationAgentRoutingOption | null,
  conversation: Conversation | null,
) {
  if (!agent || !conversation) return null;
  if (isCloudCollaborationHostId(agent.hostId)) {
    return `${agent.hostId}:${conversation.canonicalSessionId ?? conversation.id}:${agent.id}`;
  }
  return `${agent.hostId}:${agent.id}`;
}

function selectedRoutingAgent(
  agents: LocalCollaborationAgentRoutingOption[],
  selectedAgentId: string | null,
  key: string | null,
  optimisticRouting: Record<string, DesktopCollaborationAgentRouting>,
) {
  const agent = agents.find((candidate) => candidate.id === selectedAgentId)
    ?? agents.find((candidate) => candidate.isActive)
    ?? agents.find((candidate) => candidate.isDefault)
    ?? agents[0]
    ?? null;
  if (!agent) return null;
  const optimistic = key && !isCloudCollaborationHostId(agent.hostId)
    ? optimisticRouting[key]
    : null;
  return {
    ...agent,
    ...optimistic,
  };
}

export function useChatCollaborationRouting({
  shared,
  main,
  companion,
}: UseChatCollaborationRoutingInput) {
  const [selectedMainAgentId, setSelectedMainAgentId] = useState<string | null>(null);
  const [selectedCompanionAgentId, setSelectedCompanionAgentId] = useState<string | null>(null);
  const [mainNotice, setMainNotice] = useState<string | null>(null);
  const [companionNotice, setCompanionNotice] = useState<string | null>(null);
  const [optimisticRouting, setOptimisticRouting] = useState<
    Record<string, DesktopCollaborationAgentRouting>
  >({});

  const mainAgents = useMemo(
    () => localOwnedCollaborationAgentsForModelRouting(
      main.host ? [main.host] : [],
      shared.desktopChatState,
    ),
    [main.host, shared.desktopChatState],
  );
  const companionAgents = useMemo(
    () => localOwnedCollaborationAgentsForModelRouting(
      companion.host ? [companion.host] : [],
      shared.desktopChatState,
    ),
    [companion.host, shared.desktopChatState],
  );

  const mainBase = mainAgents.find((agent) => agent.id === selectedMainAgentId)
    ?? mainAgents.find((agent) => agent.isActive)
    ?? mainAgents.find((agent) => agent.isDefault)
    ?? mainAgents[0]
    ?? null;
  const companionBase = companionAgents.find((agent) => agent.id === selectedCompanionAgentId)
    ?? companionAgents.find((agent) => agent.isActive)
    ?? companionAgents.find((agent) => agent.isDefault)
    ?? companionAgents[0]
    ?? null;
  const mainKey = routingKey(mainBase, main.conversation);
  const companionKey = routingKey(companionBase, companion.conversation);
  const selectedMainAgent = selectedRoutingAgent(
    mainAgents,
    selectedMainAgentId,
    mainKey,
    optimisticRouting,
  );
  const mainAgent = selectedMainAgent && isCloudCollaborationHostId(selectedMainAgent.hostId)
    ? collaborationAgentWithSessionRoute(selectedMainAgent, main.composerSelection)
    : selectedMainAgent;
  const companionAgent = selectedRoutingAgent(
    companionAgents,
    selectedCompanionAgentId,
    companionKey,
    optimisticRouting,
  );

  useEffect(() => {
    if (!mainNotice) return;
    const timeoutId = window.setTimeout(
      () => setMainNotice(null),
      COLLABORATION_ROUTING_NOTICE_AUTO_DISMISS_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [mainNotice]);

  const defaultThinkingForModel = (
    modelValue: string | null | undefined,
    currentThinking: string | null | undefined,
  ) => {
    const thinkingLevels = shared.modelOptions
      ?.find((option) => option.value === modelValue)?.thinkingLevels ?? [];
    return fallbackComposerThinkingValue(thinkingLevels, currentThinking ?? 'default');
  };

  const applyUpdate = ({
    agent,
    key,
    patch,
    isBusy,
    setNotice,
    targetSessionId,
  }: {
    agent: LocalCollaborationAgentRoutingOption | null;
    key: string | null;
    patch: DesktopCollaborationAgentRouting;
    isBusy: boolean;
    setNotice: Dispatch<SetStateAction<string | null>>;
    targetSessionId?: string | null;
  }) => {
    if (!agent || !key) return;
    if (isBusy) {
      setNotice("Stop the running task before changing this session's model or thinking level.");
      return;
    }

    const { routing, defaultAuthChanged, fallbackAuthChanged } =
      resolveCollaborationAgentRoutingUpdate(agent, patch);
    const routeLabel = collaborationRouteDisplayName(
      routing.defaultModel,
      routing.defaultAuthProvider,
      routing.defaultAuthChoice,
      shared.modelOptions,
      shared.providerOptions,
    );
    const notice = collaborationAgentRoutingChangeNotice({
      agentLabel: agent.label,
      currentModel: agent.defaultModel,
      nextModel: patch.defaultModel,
      currentThinking: agent.thinking,
      nextThinking: patch.thinking,
      modelLabel: routeLabel,
      thinkingLabel: collaborationThinkingDisplayName(routing.thinking),
    }) ?? ((defaultAuthChanged || fallbackAuthChanged)
      ? `${agent.label} model route changed to ${routeLabel}. Only you can see this.`
      : null);
    if (!notice) return;

    if (!isCloudCollaborationHostId(agent.hostId)) {
      setOptimisticRouting((current) => ({ ...current, [key]: routing }));
    }
    setNotice(notice);
    void shared.updateRouting(
      agent.hostId,
      agent.id,
      routing.defaultModel,
      routing.fallbackModel,
      routing.thinking,
      routing.defaultAuthProvider,
      routing.defaultAuthChoice,
      routing.fallbackAuthProvider,
      routing.fallbackAuthChoice,
      targetSessionId,
    ).catch((error) => {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Unable to update collaboration agent model routing',
      );
    });
  };

  const updateMain = ({ selectorType, ...patch }: RoutingPatch) => {
    if (selectorType && main.openSelector?.scope === 'chat'
      && main.openSelector.type === selectorType) {
      main.toggleSelector('chat', selectorType);
    }
    focusComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
    applyUpdate({
      agent: mainAgent,
      key: mainKey,
      patch,
      isBusy: main.isBusy,
      setNotice: setMainNotice,
      targetSessionId: main.conversation?.canonicalSessionId
        ?? main.conversation?.id
        ?? null,
    });
  };

  const updateCompanion = ({ selectorType, ...patch }: RoutingPatch) => {
    if (selectorType && companion.openSelector?.scope === 'chat'
      && companion.openSelector.type === selectorType) {
      companion.setOpenSelector(null);
    }
    applyUpdate({
      agent: companionAgent,
      key: companionKey,
      patch,
      isBusy: companion.isBusy,
      setNotice: setCompanionNotice,
      targetSessionId: companion.conversation?.canonicalSessionId
        ?? companion.conversation?.id
        ?? null,
    });
  };

  const saveCompactMainRoute = (input: CompactComposerModelMenuSaveInput) => {
    if (main.enabled && mainAgent) {
      updateMain({
        defaultModel: input.model,
        defaultAuthProvider:
          input.providerOption?.providerId ?? mainAgent.defaultAuthProvider ?? null,
        defaultAuthChoice: input.providerOption
          ? authChoiceFromProviderOption(input.providerOption)
          : mainAgent.defaultAuthChoice ?? null,
        fallbackModel: mainAgent.fallbackModel ?? null,
        fallbackAuthProvider: mainAgent.fallbackAuthProvider ?? null,
        fallbackAuthChoice: mainAgent.fallbackAuthChoice ?? null,
        thinking: input.thinking,
      });
      return;
    }

    void (async () => {
      if (input.providerOption) {
        await main.selectComposerProviderChoice('chat', input.providerOption);
      }
      if (input.model !== main.composerSelection.model) {
        await main.selectComposerValue('chat', 'model', input.model);
      }
      if (input.thinking !== main.composerSelection.thinking) {
        await main.selectComposerValue('chat', 'thinking', input.thinking);
      }
    })();
  };

  return {
    main: {
      enabled: main.enabled && Boolean(mainAgent),
      notice: mainNotice,
      agents: mainAgents,
      selectedAgent: mainAgent,
      selection: routingSelectionForCollaborationAgent(mainAgent),
      visibility: collaborationChatRoutingControlVisibility(mainAgents.length),
      selectorOpen: main.openSelector?.scope === 'chat'
        && main.openSelector.type === 'mode',
      setSelectedAgentId: setSelectedMainAgentId,
      update: updateMain,
      saveCompactRoute: saveCompactMainRoute,
      defaultThinkingForModel,
    },
    companion: {
      notice: companionNotice,
      agents: companionAgents,
      selectedAgent: companionAgent,
      selection: routingSelectionForCollaborationAgent(companionAgent),
      visibility: collaborationChatRoutingControlVisibility(companionAgents.length),
      selectorOpen: companion.openSelector?.scope === 'chat'
        && companion.openSelector.type === 'mode',
      setSelectedAgentId: setSelectedCompanionAgentId,
      update: updateCompanion,
      defaultThinkingForModel,
    },
  };
}
