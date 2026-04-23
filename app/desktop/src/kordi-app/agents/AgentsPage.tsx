import { AgentDetailPane } from './AgentDetailPane';
import { AgentsSidebar } from './AgentsSidebar';
import type { AgentsPageProps } from './model';
import { useAgentsPageModel } from './useAgentsPageModel';

export function AgentsPage({
  agents,
  activeAgentId,
  activeAgent,
  onOpenAgent,
  getStatusBadgeClass,
  onMessageAgent,
}: AgentsPageProps) {
  const {
    agentConfigs,
    activeAgentConfig,
    activePersistedConfig,
    activeIdentityFile,
    activeSaveFeedback,
    activeEditingSection,
    activeFilePreview,
    availableSkills,
    resetAgentDraft,
    saveAgentConfig,
    selectIdentityFile,
    startEditing,
    toggleSkill,
    updatePrompt,
  } = useAgentsPageModel(agents, activeAgent);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 p-4">
      <div className="grid h-full min-h-0 w-full gap-px overflow-hidden rounded-[22px] border border-white/8 bg-white/[0.04] xl:grid-cols-[310px_minmax(0,1fr)]">
        <AgentsSidebar
          agents={agents}
          activeAgentId={activeAgentId}
          agentConfigs={agentConfigs}
          getStatusBadgeClass={getStatusBadgeClass}
          onOpenAgent={onOpenAgent}
        />
        <AgentDetailPane
          activeAgent={activeAgent}
          activeAgentConfig={activeAgentConfig}
          activePersistedConfig={activePersistedConfig}
          activeIdentityFile={activeIdentityFile}
          activeFilePreview={activeFilePreview}
          activeSaveFeedback={activeSaveFeedback}
          activeEditingSection={activeEditingSection}
          availableSkills={availableSkills}
          onReset={resetAgentDraft}
          onMessage={
            onMessageAgent && activeAgent && activeAgentConfig
              ? () => onMessageAgent({ ...activeAgent, ...activeAgentConfig, loadedSkills: activeAgentConfig.loadedSkills })
              : undefined
          }
          onStartEditing={startEditing}
          onSave={(agent, section) => void saveAgentConfig(agent, section)}
          onCancelEditing={resetAgentDraft}
          onPromptChange={updatePrompt}
          onToggleSkill={toggleSkill}
          onSelectIdentityFile={selectIdentityFile}
        />
      </div>
    </div>
  );
}
