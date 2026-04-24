import { AgentContentPane } from './AgentContentPane';
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
    activeDetail,
    activeSaveFeedback,
    activeEditingSection,
    activeFilePreview,
    activeFileDraft,
    activeFileCanEdit,
    activeFileIsEditing,
    activeFileSaveFeedback,
    availableSkills,
    resetAgentDraft,
    saveAgentConfig,
    saveActiveFile,
    selectIdentityFile,
    openPromptDetail,
    startEditing,
    startFileEditing,
    cancelFileEditing,
    toggleSkill,
    updatePrompt,
    updateActiveFileDraft,
  } = useAgentsPageModel(agents, activeAgent);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 p-4">
      <div className="grid h-full min-h-0 w-full gap-px overflow-hidden rounded-[22px] border border-white/8 bg-white/[0.04] xl:grid-cols-[296px_minmax(360px,0.94fr)_minmax(340px,1.06fr)]">
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
          activeDetail={activeDetail}
          activeSaveFeedback={activeSaveFeedback}
          activeEditingSection={activeEditingSection}
          availableSkills={availableSkills}
          onReset={resetAgentDraft}
          onMessage={
            onMessageAgent && activeAgent && activeAgentConfig
              ? () => onMessageAgent({ ...activeAgent, ...activeAgentConfig, loadedSkills: activeAgentConfig.loadedSkills })
              : undefined
          }
          onOpenPromptDetail={openPromptDetail}
          onStartEditing={startEditing}
          onSave={(agent, section) => void saveAgentConfig(agent, section)}
          onCancelEditing={resetAgentDraft}
          onToggleSkill={toggleSkill}
          onSelectIdentityFile={selectIdentityFile}
        />
        <AgentContentPane
          activeAgent={activeAgent}
          activeDetail={activeDetail}
          activeAgentConfig={activeAgentConfig}
          activeEditingSection={activeEditingSection}
          activeSaveFeedback={activeSaveFeedback}
          activeFilePreview={activeFilePreview}
          activeFileDraft={activeFileDraft}
          activeFileCanEdit={activeFileCanEdit}
          activeFileIsEditing={activeFileIsEditing}
          activeFileSaveFeedback={activeFileSaveFeedback}
          onStartPromptEditing={(agentId) => startEditing(agentId, 'prompt')}
          onSavePrompt={(agent) => void saveAgentConfig(agent, 'prompt')}
          onCancelPromptEditing={resetAgentDraft}
          onPromptChange={updatePrompt}
          onStartFileEditing={startFileEditing}
          onCancelFileEditing={cancelFileEditing}
          onSaveFile={() => void saveActiveFile()}
          onFileDraftChange={updateActiveFileDraft}
        />
      </div>
    </div>
  );
}
