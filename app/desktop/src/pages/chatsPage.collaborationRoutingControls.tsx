import { ChevronDown } from 'lucide-react';

import {
  collaborationChatRoutingControlVisibility,
  type LocalCollaborationAgentRoutingOption,
  routingSelectionForCollaborationAgent,
} from '@/features/collaboration/agentModelRouting';
import {
  ComposerModelControls,
  type ComposerAuthOption,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '@/kordi-app/components';
import type { DesktopCollaborationAgentRouting } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import {
  authChoiceFromProviderOption,
  firstModelForProvider,
} from '@/pages/chatsPage.model';
import type { ChatsPageRuntime } from '@/pages/chatsPage.types';

type ComposerSelector = ChatsPageRuntime['openComposerSelector'];

export type CollaborationRoutingPatch =
  DesktopCollaborationAgentRouting & {
    selectorType?: 'provider' | 'model' | 'thinking';
  };

export type CollaborationRoutingControlsModel = {
  agents: LocalCollaborationAgentRoutingOption[];
  selectedAgent: LocalCollaborationAgentRoutingOption;
  selection: ReturnType<typeof routingSelectionForCollaborationAgent>;
  visibility: ReturnType<typeof collaborationChatRoutingControlVisibility>;
};

type CollaborationRoutingControlsProps = {
  model: CollaborationRoutingControlsModel;
  menu: {
    openSelector: ComposerSelector;
    agentSelectorOpen: boolean;
    compact: boolean;
  };
  options: {
    authLabel: string;
    authOptions: ComposerAuthOption[];
    providerOptions: ComposerProviderOption[];
    modelOptions?: ComposerModelOption[];
  };
  actions: {
    toggleSelector: ChatsPageRuntime['toggleComposerSelector'];
    onSelectAgent: (agentId: string) => void;
    onUpdate: (patch: CollaborationRoutingPatch) => void;
    defaultThinkingForModel: (
      modelValue: string | null | undefined,
      currentThinking: string | null | undefined,
    ) => string;
  };
};

export function CollaborationRoutingControls({
  model,
  menu,
  options,
  actions,
}: CollaborationRoutingControlsProps) {
  const { agents, selectedAgent, selection, visibility } = model;
  const { openSelector, agentSelectorOpen, compact } = menu;
  const { authLabel, authOptions, providerOptions, modelOptions } = options;

  return (
    <div
      className="relative flex min-w-0 items-center gap-2 overflow-visible"
      data-collaboration-routing-controls="true"
    >
      {visibility.showAgentSelector ? (
        <button
          type="button"
          onClick={() => actions.toggleSelector('chat', 'mode')}
          className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
          title="Choose which owned agent these session settings apply to"
        >
          <span className="truncate">{selectedAgent.label}</span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform',
              agentSelectorOpen ? 'rotate-180 text-slate-300' : '',
            )}
          />
        </button>
      ) : null}
      {agentSelectorOpen ? (
        <div className="app-transient-surface app-transient-scroll absolute bottom-full right-0 z-30 mb-2 max-h-[min(22rem,50vh)] w-[260px] overflow-y-auto rounded-[16px] border px-3 py-3 text-[12px]">
          <div className="pb-2 text-[12px] font-medium text-[color:var(--utility-foreground)]">
            My agent
          </div>
          <div className="space-y-1">
            {agents.map((agent) => (
              <button
                key={`${agent.hostId}:${agent.id}`}
                type="button"
                onClick={() => actions.onSelectAgent(agent.id)}
                className={cn(
                  'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                  selectedAgent.id === agent.id ? 'app-composer-popover-item-active' : '',
                )}
              >
                <span className="truncate">{agent.label}</span>
                <span className="shrink-0 text-[11px] text-[color:var(--utility-muted-text)]">
                  {agent.isDefault ? 'Default' : 'Owned'}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <ComposerModelControls
        scope="chat"
        selection={selection}
        openSelector={openSelector}
        onToggleSelector={actions.toggleSelector}
        onSelectValue={(_scope, type, value) => {
          if (type === 'model') {
            actions.onUpdate({
              defaultModel: value,
              defaultAuthProvider: selectedAgent.defaultAuthProvider ?? null,
              defaultAuthChoice: selectedAgent.defaultAuthChoice ?? null,
              fallbackModel: selectedAgent.fallbackModel ?? null,
              fallbackAuthProvider: selectedAgent.fallbackAuthProvider ?? null,
              fallbackAuthChoice: selectedAgent.fallbackAuthChoice ?? null,
              thinking: actions.defaultThinkingForModel(value, selectedAgent.thinking),
              selectorType: 'model',
            });
          } else if (type === 'thinking') {
            actions.onUpdate({
              defaultModel: selectedAgent.defaultModel ?? null,
              defaultAuthProvider: selectedAgent.defaultAuthProvider ?? null,
              defaultAuthChoice: selectedAgent.defaultAuthChoice ?? null,
              fallbackModel: selectedAgent.fallbackModel ?? null,
              fallbackAuthProvider: selectedAgent.fallbackAuthProvider ?? null,
              fallbackAuthChoice: selectedAgent.fallbackAuthChoice ?? null,
              thinking: value,
              selectorType: 'thinking',
            });
          }
        }}
        authLabel={authLabel}
        authOptions={authOptions}
        onSelectAuthChoice={() => {}}
        onSelectProviderChoice={(_scope, option) => {
          const nextModel = firstModelForProvider(option.providerId, modelOptions);
          if (!nextModel) return;
          actions.onUpdate({
            defaultModel: nextModel,
            defaultAuthProvider: option.providerId,
            defaultAuthChoice: authChoiceFromProviderOption(option),
            fallbackModel: selectedAgent.fallbackModel ?? null,
            fallbackAuthProvider: selectedAgent.fallbackAuthProvider ?? null,
            fallbackAuthChoice: selectedAgent.fallbackAuthChoice ?? null,
            thinking: actions.defaultThinkingForModel(nextModel, selectedAgent.thinking),
            selectorType: 'provider',
          });
        }}
        providerOptions={providerOptions}
        modelOptions={modelOptions && modelOptions.length > 0 ? modelOptions : undefined}
        compact={compact}
      />
    </div>
  );
}
