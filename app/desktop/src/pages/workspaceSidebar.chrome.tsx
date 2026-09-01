import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import { Plus, Search } from 'lucide-react';

import type { ChatChannel } from '@/kordi-app/types';
import type { CollaborationSyncStatus } from '@/pages/workspaceSidebar.chatModel';
import { SidebarUnreadBadge } from '@/pages/workspaceSidebar.shared';

function CollaborationSyncIndicator({ status, ariaLabel }: {
  status: CollaborationSyncStatus;
  ariaLabel: string | null;
}) {
  if (status === 'idle' || !ariaLabel) return null;
  const tooltip = status === 'syncing' ? 'Syncing messages' : 'Sync unavailable';
  return (
    <span
      className="app-collaboration-sync-status"
      data-collaboration-sync-status={status}
      data-tooltip={tooltip}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      tabIndex={0}
    >
      <svg
        className="app-collaboration-sync-icon"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        {status === 'syncing' ? (
          <>
            <circle className="app-collaboration-sync-track" cx="8" cy="8" r="5.5" />
            <circle
              className="app-collaboration-sync-arc"
              cx="8"
              cy="8"
              r="5.5"
              strokeDasharray="13 22"
            />
          </>
        ) : (
          <>
            <path d="M5.2 3.3a5.4 5.4 0 0 1 7.5 2.3" />
            <path d="M10.8 12.7a5.4 5.4 0 0 1-7.5-2.3" />
            <path d="M6.2 8h3.6" />
          </>
        )}
      </svg>
    </span>
  );
}

export function ChatSidebarChrome({
  agentUnread,
  chatChannel,
  chatSearch,
  collaborationSyncAriaLabel,
  collaborationSyncStatus,
  contactUnread,
  onOpenCreate,
  setChatChannel,
  setChatSearch,
}: {
  agentUnread: number;
  chatChannel: ChatChannel;
  chatSearch: string;
  collaborationSyncAriaLabel: string | null;
  collaborationSyncStatus: CollaborationSyncStatus;
  contactUnread: number;
  onOpenCreate: (event: ReactMouseEvent<HTMLElement>) => void;
  setChatChannel: (channel: ChatChannel) => void;
  setChatSearch: Dispatch<SetStateAction<string>>;
}) {
  return (
    <>
      <div className="app-chat-sidebar-header mb-2 flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <div className="shrink-0 text-[15px] font-semibold text-white">Chats</div>
          <CollaborationSyncIndicator
            status={collaborationSyncStatus}
            ariaLabel={collaborationSyncAriaLabel}
          />
        </div>
        <div className="app-chat-sidebar-actions flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenCreate}
            className="app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] p-0 transition"
            title="Start a chat"
            aria-label="Start a chat"
          >
            <Plus className="h-4 w-4 stroke-[2.2]" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="app-input-shell app-workspace-search mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 text-slate-400" />
        <input
          value={chatSearch}
          onChange={(event) => setChatSearch(event.target.value)}
          placeholder={chatChannel === 'contact'
            ? 'Search contacts, groups, sessions'
            : 'Search agent conversations'}
          className="w-full bg-transparent text-[13px] text-white outline-none placeholder:text-slate-400"
        />
      </div>

      <div className="mb-2 space-y-1.5">
        <div className="app-filter-tabs w-full">
          {([
            { id: 'contact', label: 'Contact', unread: contactUnread },
            { id: 'agent', label: 'Agent', unread: agentUnread },
          ] as Array<{ id: ChatChannel; label: string; unread: number }>).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setChatChannel(tab.id)}
              className={chatChannel === tab.id
                ? 'app-filter-tab app-filter-tab-active'
                : 'app-filter-tab'}
            >
              <span>{tab.label}</span>
              {tab.unread > 0 ? (
                <span className="ml-1.5 inline-flex">
                  <SidebarUnreadBadge count={tab.unread} scope="channel-tab" />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
