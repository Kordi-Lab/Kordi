import { useMemo, useState } from 'react';
import { useChatProjects } from '@/features/projects/chatProjects';
import { projectChatGroups } from '@/features/projects/projectChatGroups';
import { ChevronRight, Folder, Plus } from 'lucide-react';

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
  const grouped = useMemo(() => projectChatGroups(
    model.agentSidebarRows, projects?.projects ?? [], collapsed, !model.chatSearch && !model.showArchived,
  ), [model.agentSidebarRows, projects?.projects, collapsed, model.chatSearch, model.showArchived]);
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
      {!model.showArchived ? <div className="mb-1 flex shrink-0 justify-center px-1">
        <button
          type="button"
          onClick={onOpenAgentCreate}
          className="app-participant-space-action app-participant-space-context-create inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[9px] px-2 text-[11px] font-medium transition"
          title="New My agent session"
          aria-label="New My agent session"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New session</span>
        </button>
      </div> : null}
      {projects?.enabled && projects.projects.length > 0 ? <div className="chat-project-section-label">
        <span>Projects</span>
      </div> : null}
      <VirtualChatList
        rows={grouped.rows}
        activeSessionId={model.activeSidebarRowSessionId}
        scrollClassName="app-workspace-session-scroll chat-project-session-list min-h-0 flex-1"
        dataMode="agent-sessions-flat"
        renderRow={(descriptor) => descriptor.kind === 'space' ? (
          <div className="chat-project-group-row"><button type="button" className={descriptor.spaceId === 'unassigned' ? 'chat-recents-heading' : 'chat-project-group'} aria-expanded={!collapsed.has(descriptor.spaceId)}
            onClick={() => setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(descriptor.spaceId)) next.delete(descriptor.spaceId); else next.add(descriptor.spaceId);
              return next;
            })}>
            {descriptor.spaceId === 'unassigned' ? <>
              <span>Recents</span>
              <ChevronRight size={12} className={!collapsed.has(descriptor.spaceId) ? 'rotate-90' : ''} aria-hidden="true" />
            </> : <>
              <ChevronRight size={12} className={!collapsed.has(descriptor.spaceId) ? 'rotate-90' : ''} />
              <Folder size={13} /><span>{grouped.groups.get(descriptor.spaceId)?.name}</span>
            </>}
          </button>
          </div>
        ) : (
          <AgentSidebarRow
            descriptor={descriptor}
            projectGrouped={grouped.projectBySession.has(descriptor.sessionId)}
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
