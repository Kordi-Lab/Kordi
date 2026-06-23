import { useState } from 'react';
import { AgentContentPane } from './AgentContentPane';
import { AgentCreateDialog } from './AgentCreateDialog';
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
  chatModelOptions,
  composerProviderOptions,
  onUpdateAgentModelRouting,
  onMessageAgent,
  onOpenAgentReachoutSession,
  onCreateCloudAgent,
  onUpdateCloudAgent,
  onArchiveCloudAgent,
}: AgentsPageProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const creatorAgent = agents.find((agent) => agent.id === 'desktop:local-agent')
    ?? agents.find((agent) => agent.name.trim().toLowerCase() === 'kordi' && !agent.cloudAgentId)
    ?? agents.find((agent) => agent.isOwned && !agent.cloudAgentId)
    ?? null;
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
    <div className="app-agents-page flex h-full min-h-0 min-w-0 flex-1 p-0">
      <div className="app-agent-shell grid h-full min-h-0 w-full gap-px overflow-hidden rounded-none border-0">
        <AgentsSidebar
          agents={agents}
          activeAgentId={activeAgentId}
          agentConfigs={agentConfigs}
          getStatusBadgeClass={getStatusBadgeClass}
          onOpenAgent={onOpenAgent}
          onCreateAgentClick={onCreateCloudAgent ? () => setCreateDialogOpen(true) : undefined}
        />
        <AgentDetailPane
          activeAgent={activeAgent}
          activeAgentConfig={activeAgentConfig}
          activePersistedConfig={activePersistedConfig}
          activeDetail={activeDetail}
          activeSaveFeedback={activeSaveFeedback}
          activeEditingSection={activeEditingSection}
          availableSkills={availableSkills}
          chatModelOptions={chatModelOptions}
          composerProviderOptions={composerProviderOptions}
          onUpdateModelRouting={onUpdateAgentModelRouting}
          onReset={resetAgentDraft}
          onMessage={
            onMessageAgent && activeAgent && activeAgentConfig
              ? () => onMessageAgent({ ...activeAgent, ...activeAgentConfig, loadedSkills: activeAgentConfig.loadedSkills })
              : undefined
          }
          onOpenReachoutSession={onOpenAgentReachoutSession}
          onUpdateCloudAgent={onUpdateCloudAgent}
          onArchiveCloudAgent={onArchiveCloudAgent}
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
      <AgentCreateDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        creatorAgent={creatorAgent}
        onCreateCloudAgent={onCreateCloudAgent}
        onCreated={(agent) => onOpenAgent(agent.id)}
      />
    </div>
  );
}
