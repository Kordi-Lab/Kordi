import { useMemo, useState } from 'react';
import { useChatProjects } from '@/features/projects/chatProjects';
import { projectChatGroups } from '@/features/projects/projectChatGroups';
import { ChevronRight, Folder, FolderOpen, Plus } from 'lucide-react';
import { ProjectSidebarHeading } from '@/features/projects/ProjectSidebarHeading';
import { participantSpaceSessionPreferenceId } from '@/pages/workspaceSidebar.chatHelpers';
import { primaryAgentForConversation } from '@/features/chat/participantSpaces';

import { AgentSidebarRow } from '@/pages/workspaceSidebar.agentRows';
import type { ContactSidebarRowActions } from '@/pages/workspaceSidebar.contactRows';
import { ContactSidebarRow } from '@/pages/workspaceSidebar.contactRows';
import type { WorkspaceChatSidebarModel } from '@/pages/workspaceSidebar.chatModel';
import { VirtualChatList } from '@/pages/sidebar/VirtualChatList';

function SidebarEmptyState({ children }: { children: string }) {
  return (
    <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-3 text-[11px] text-slate-400">
      {children}
    </div>
  );
}

export function WorkspaceChatLists({
  model,
  activeConvId,
  contactActions,
  onOpenAgentCreate,
}: {
  model: WorkspaceChatSidebarModel;
  activeConvId: string;
  contactActions: ContactSidebarRowActions;
  onOpenAgentCreate: () => void;
}) {
  const projects = useChatProjects();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(new Set());
  const pinnedSessionIds = useMemo(() => new Set(
    [...model.agentSessionRowsById.values()]
      .filter(({ session, space }) => model.pinnedSessionIds.has(participantSpaceSessionPreferenceId(session))
        || (space.kind === 'self' && !primaryAgentForConversation(session.conversation)))
      .map(({ session }) => session.id),
  ), [model.agentSessionRowsById, model.pinnedSessionIds]);
  const grouped = useMemo(() => projectChatGroups(
    model.agentSidebarRows, model.showArchived ? [] : projects?.projects ?? [], collapsed,
    Boolean(projects?.enabled && !model.chatSearch && !model.showArchived),
    { pinnedSessionIds, expandedProjectIds, previewLimit: model.chatSearch ? Infinity : 5 },
  ), [model.agentSidebarRows, projects?.projects, projects?.enabled, collapsed, model.chatSearch, model.showArchived, pinnedSessionIds, expandedProjectIds]);
  const animatedRows = useMemo(() => grouped.rows.map((row) => {
    if (row.kind !== 'session') return row;
    const session = model.agentSessionRowsById.get(row.sessionId);
    return session?.space.kind === 'self' && !primaryAgentForConversation(session.session.conversation)
      ? { ...row, estimatedHeight: 50 } : row;
  }), [grouped.rows, model.agentSessionRowsById]);
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  if (model.chatChannel === 'contact') {
    return (
      <VirtualChatList
        groupChannels
        rows={model.contactSidebarRows}
        activeSessionId={model.activeSidebarRowSessionId}
        scrollClassName="app-workspace-session-scroll min-h-0 flex-1"
        dataMode="participant-spaces-inline"
        renderRow={(descriptor) => (
          <ContactSidebarRow
            descriptor={descriptor}
            model={model}
            actions={contactActions}
            activeConvId={activeConvId}
          />
        )}
        emptyState={
          <SidebarEmptyState>
            {model.showArchived
              ? 'No archived contact chats.'
              : 'No conversations yet. Start a chat to see it here.'}
          </SidebarEmptyState>
        }
      />
    );
  }

  return (
    <>
      {!model.showArchived ? <div className="flex shrink-0 justify-start px-1">
        <button
          type="button"
          onClick={onOpenAgentCreate}
          className="app-participant-space-action app-participant-space-context-create inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[9px] px-2 text-[11px] font-medium transition"
          title="New My agent session"
          aria-label="New My agent session"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New session</span>
        </button>
      </div> : null}
      <VirtualChatList
        groupChannels={Boolean(projects?.enabled)}
        compactChannels
        rows={animatedRows}
        activeSessionId={model.activeSidebarRowSessionId}
        scrollClassName="app-workspace-session-scroll chat-project-session-list min-h-0 flex-1"
        dataMode="agent-sessions-flat"
        renderRow={(descriptor) => descriptor.kind === 'space' ? (
          descriptor.spaceId.startsWith('section:') ? (
            <ProjectSidebarHeading
              section={descriptor.spaceId.slice(8) as 'pinned' | 'projects' | 'recents'}
              first={grouped.rows[0]?.key === descriptor.key}
              expanded={!collapsed.has(descriptor.spaceId)}
              onToggle={() => toggle(descriptor.spaceId)}
              onCreateProject={projects?.enabled ? projects.openImporter : undefined}
              onSetProjectsExpanded={(expanded) => setCollapsed((current) => {
                const next = new Set(current);
                for (const id of grouped.groups.keys()) {
                  if (expanded) next.delete(id); else next.add(id);
                }
                return next;
              })}
            />
          ) : descriptor.key.startsWith('project-more:') ? (
            <button type="button" className="chat-project-show-more"
              aria-label={`${expandedProjectIds.has(descriptor.spaceId) ? 'Show less' : 'Show more'} in ${grouped.groups.get(descriptor.spaceId)?.name}`}
              aria-expanded={expandedProjectIds.has(descriptor.spaceId)}
              onClick={() => setExpandedProjectIds((current) => {
                const next = new Set(current);
                if (next.has(descriptor.spaceId)) next.delete(descriptor.spaceId); else next.add(descriptor.spaceId);
                return next;
              })}>
              {expandedProjectIds.has(descriptor.spaceId) ? 'Show less' : 'Show more'}
            </button>
          ) : (
            <button type="button" className="chat-project-group" aria-expanded={!collapsed.has(descriptor.spaceId)}
              onClick={() => toggle(descriptor.spaceId)}>
              {collapsed.has(descriptor.spaceId) ? <Folder size={17} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}
              <span>{grouped.groups.get(descriptor.spaceId)?.name}</span>
              <ChevronRight size={13} className="chat-project-collapse-indicator app-participant-space-disclosure-icon" aria-hidden="true" />
            </button>
          )
        ) : (
          <AgentSidebarRow
            descriptor={descriptor}
            projectGrouped={descriptor.key.startsWith('project:')}
            model={model}
            activeConvId={activeConvId}
            onSelectChatSession={contactActions.onSelectChatSession}
            onOpenSessionContextMenu={contactActions.onOpenSessionContextMenu}
          />
        )}
        emptyState={
          <SidebarEmptyState>
            {model.showArchived
              ? 'No archived agent chats.'
              : 'No agent conversations yet. Start one to see it here.'}
          </SidebarEmptyState>
        }
      />
    </>
  );
}
