import { WorkspaceSidebar } from '@/pages/WorkspaceSidebar';

import type { SidebarShellArgs } from '@/app/kordiShellSlots.types';

export function assembleSidebarSlot(args: SidebarShellArgs) {
  return (
    <WorkspaceSidebar
      isNativeShell={args.isNativeShell}
      isSingleWorkspacePage={args.isSingleWorkspacePage}
      collapseChatSessions={args.collapseChatSessions}
      showSessionRail={args.showSessionRail}
      sessionRailWidth={args.sessionRailWidth}
      activeNav={args.activeNav}
      setActiveNav={args.setActiveNav}
      chatConversations={args.chatConversations}
      onCreateChatSession={() => {
        void args.handleCreateChatSession();
      }}
      chatSearch={args.chatSearch}
      setChatSearch={args.setChatSearch}
      isDesktopChatLoading={args.isDesktopChatLoading}
      desktopChatError={args.desktopChatError}
      participantSpaces={args.participantSpaces}
      contactParticipantSpaces={args.contactParticipantSpaces}
      agentParticipantSpaces={args.agentParticipantSpaces}
      activeConvId={args.activeConvId}
      onSelectChatSession={(sessionId) => {
        void args.handleSelectChatSession(sessionId);
      }}
      onStartChatWithPerson={args.handleStartChatWithPerson}
      onStartChatWithAgent={async (agent) => {
        if (agent.isOwned) {
          await args.handleCreateChatSession();
          return;
        }
        await args.handleStartChatWithAgent(agent);
      }}
      onCreateChatGroup={args.handleCreateChatGroup}
      onCreateChatSessionInParticipantSpace={args.handleCreateChatSessionInParticipantSpace}
      onRenameChatGroup={args.handleRenameChatGroup}
      onRenameChatSession={(sessionId, title) => {
        void args.handleRenameChatSession(sessionId, title);
      }}
      onAddChatGroupMembers={args.handleAddChatGroupMembers}
      onRemoveChatGroupMember={args.handleRemoveChatGroupMember}
      onSetChatGroupAdmin={args.handleSetChatGroupAdmin}
      onArchiveChatSession={(sessionId) => {
        void args.handleArchiveChatSession(sessionId);
      }}
      onDeleteChatSession={(sessionId) => {
        void args.handleDeleteChatSession(sessionId);
      }}
      onMoveChatSessionToProject={(sessionId, projectRoot) => {
        void args.handleMoveChatSessionToProject(sessionId, projectRoot);
      }}
      onCreateProjectFromFolder={args.handleCreateProjectFromFolder}
      onCreateProject={args.handleCreateProject}
      runtimeProjects={args.runtimeProjects}
      projectSearch={args.projectSearch}
      setProjectSearch={args.setProjectSearch}
      filteredProjects={args.filteredProjects}
      activeProjectId={args.activeProjectId}
      activeProjectSessionId={args.activeProjectSessionId}
      projectSelectedSessionIds={args.projectSelectedSessionIds}
      selectProject={args.selectProject}
      expandedProjectIds={args.expandedProjectIds}
      setExpandedProjectIds={args.setExpandedProjectIds}
      onSelectProjectSession={(projectId, sessionId) => {
        void args.handleSelectProjectSession(projectId, sessionId);
      }}
      groupedContacts={args.groupedContacts}
      displayedContacts={args.displayedContacts}
      setActiveContactGroup={args.setActiveContactGroup}
      setActiveContactId={args.setActiveContactId}
      displayedAgents={args.displayedAgents}
      activeBridgeHost={args.activeBridgeHost}
      localProfileAvatarSeed={args.localProfileAvatarSeed}
      onRefreshBridge={() => {
        void args.refreshDesktopBridge();
      }}
      onCopyBridgeHostUrl={() => {
        if (args.activeBridgeHost) {
          void args.handleCopyBridgeText(args.activeBridgeHost.serverUrl, 'Bridge host URL copied');
        }
      }}
      onCreateBridgeDraft={args.handleCreateBridgeDraft}
    />
  );
}
