import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import { Plus } from 'lucide-react';

import { SidebarListAction, SidebarListHeader, SidebarSearchField } from '@/components/SidebarListChrome';

import type { ChatChannel } from '@/kordi-app/types';
import type { CollaborationSyncStatus } from '@/pages/workspaceSidebar.chatModel';

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
  chatChannel,
  chatSearch,
  collaborationSyncAriaLabel,
  collaborationSyncStatus,
  onOpenCreate,
  setChatSearch,
}: {
  chatChannel: ChatChannel;
  chatSearch: string;
  collaborationSyncAriaLabel: string | null;
  collaborationSyncStatus: CollaborationSyncStatus;
  onOpenCreate: (event: ReactMouseEvent<HTMLElement>) => void;
  setChatSearch: Dispatch<SetStateAction<string>>;
}) {
  return (
    <>
      <SidebarListHeader
        title={chatChannel === 'agent' ? 'Agent Chats' : 'Chats'}
        after={(
          <CollaborationSyncIndicator
            status={collaborationSyncStatus}
            ariaLabel={collaborationSyncAriaLabel}
          />
        )}
      >
        <SidebarListAction icon={Plus} label="Start a chat" onClick={onOpenCreate} />
      </SidebarListHeader>
      <SidebarSearchField
        value={chatSearch}
        onChange={setChatSearch}
        placeholder={chatChannel === 'contact'
          ? 'Search contacts, groups, sessions'
          : 'Search agent conversations'}
      />
    </>
  );
}
