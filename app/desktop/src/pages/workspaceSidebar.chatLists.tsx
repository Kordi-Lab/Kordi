import { Plus } from 'lucide-react';

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
  if (model.chatChannel === 'contact') {
    return (
      <VirtualChatList
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
            No conversations yet. Start a chat to see it here.
          </SidebarEmptyState>
        }
      />
    );
  }

  return (
    <>
      <div className="mb-1 flex shrink-0 justify-center px-1">
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
      </div>
      <VirtualChatList
        rows={model.agentSidebarRows}
        activeSessionId={model.activeSidebarRowSessionId}
        scrollClassName="app-workspace-session-scroll min-h-0 flex-1"
        dataMode="agent-sessions-flat"
        renderRow={(descriptor) => (
          <AgentSidebarRow
            descriptor={descriptor}
            model={model}
            activeConvId={activeConvId}
            onPrefetchChatSession={contactActions.onPrefetchChatSession}
            onSelectChatSession={contactActions.onSelectChatSession}
            onOpenSessionContextMenu={contactActions.onOpenSessionContextMenu}
          />
        )}
        emptyState={
          <SidebarEmptyState>
            No agent conversations yet. Start one to see it here.
          </SidebarEmptyState>
        }
      />
    </>
  );
}
