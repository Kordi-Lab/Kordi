import { Cloud, Columns2, PanelLeftClose, PanelLeftOpen, Split } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { CloudSelfAgentSyncStatus } from '@/features/cloud/useCloudCollaborationState';
import type { Conversation } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { SessionDestinationTabs } from '@/pages/chatsPage.destinations';
import type { ChatDestination } from '@/pages/chatsPage.destinationModel';

type MainHeaderRename = {
  enabled: boolean;
  editing: boolean;
  draft: string;
  sessionId: string;
  setDraft: (value: string) => void;
  begin: () => void;
  cancel: () => void;
  commit: () => void;
};

type MainHeaderCompanion = {
  canOpen: boolean;
  isOpen: boolean;
  suggestedName?: string;
  onOpen: () => void;
};

type MainHeaderProps = {
  conversation: Conversation;
  layout: {
    showSessionToggle: boolean;
    sessionsCollapsed: boolean;
    onToggleSessions: () => void;
    showDestinations: boolean;
    destination: ChatDestination;
    onSelectDestination: (destination: ChatDestination) => void;
  };
  metadata: {
    subtitle: string | null;
    cloudSyncLabel: string | null;
    cloudSyncStatus: CloudSelfAgentSyncStatus | null | undefined;
    forkSourceSessionId: string | null;
    forkSourceTitle: string;
    onOpenForkSource?: (sessionId: string) => void;
  };
  rename: MainHeaderRename;
  companion: MainHeaderCompanion;
};

export function MainChatHeader({
  conversation,
  layout,
  metadata,
  rename,
  companion,
}: MainHeaderProps) {
  return (
    <div className="app-page-header relative flex min-h-[84px] shrink-0 items-start justify-between gap-3 border-b border-[color:var(--app-divider)] px-4 pb-8 pt-2.5 shadow-[0_1px_0_color-mix(in_srgb,var(--app-text)_8%,transparent)]">
      <div className="flex min-w-0 items-center gap-2">
        {layout.showSessionToggle ? (
          <button
            type="button"
            onClick={layout.onToggleSessions}
            className="app-icon-button app-utility-button grid h-7.5 w-7.5 shrink-0 place-items-center rounded-[12px] transition"
            aria-label={layout.sessionsCollapsed ? 'Open sessions' : 'Close sessions'}
            title={layout.sessionsCollapsed ? 'Open sessions' : 'Close sessions'}
          >
            {layout.sessionsCollapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="app-page-header-title-row mb-1 flex min-w-0 items-center gap-1.5 text-white">
            {rename.enabled ? (
              rename.editing ? (
                <input
                  value={rename.draft}
                  onChange={(event) => rename.setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      rename.cancel();
                    }
                  }}
                  onBlur={rename.commit}
                  autoFocus
                  data-kordi-window-drag="false"
                  className="min-w-[220px] max-w-full rounded-lg bg-transparent px-1 py-0.5 text-left text-[17px] font-semibold text-white outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-white/20"
                  placeholder="Session name"
                />
              ) : (
                <h2 className="min-w-0 max-w-[18rem] text-[17px] font-semibold leading-6">
                  <button
                    type="button"
                    onDoubleClick={rename.begin}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      rename.begin();
                    }}
                    className="block w-full truncate rounded-lg px-1 py-0.5 text-left text-white transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
                    data-chat-session-title-rename="true"
                    data-session-title-rename-trigger="double-click"
                    data-session-id={rename.sessionId}
                    data-kordi-window-drag="false"
                    aria-label={`Rename session ${conversation.name}`}
                    title="Double-click to rename session"
                  >
                    {conversation.name}
                  </button>
                </h2>
              )
            ) : (
              <h2
                className="min-w-0 max-w-[18rem] truncate text-[17px] font-semibold leading-6"
                data-kordi-window-drag="false"
              >
                {conversation.name}
              </h2>
            )}
            {metadata.cloudSyncLabel ? (
              <span
                className={cn(
                  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors',
                  metadata.cloudSyncStatus?.state === 'error'
                    ? 'text-rose-300'
                    : metadata.cloudSyncStatus?.state === 'syncing'
                      ? 'text-sky-200'
                      : 'text-emerald-200',
                )}
                title={metadata.cloudSyncStatus?.state === 'error'
                  ? metadata.cloudSyncStatus.message || 'Cloud sync needs attention'
                  : metadata.cloudSyncLabel}
                aria-label={metadata.cloudSyncStatus?.state === 'error'
                  ? 'Cloud sync issue'
                  : metadata.cloudSyncLabel}
                data-cloud-self-agent-sync-status={metadata.cloudSyncStatus?.state ?? 'idle'}
              >
                <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            ) : null}
            {metadata.subtitle ? (
              <span
                data-chat-session-subtitle-pill="true"
                className="inline-flex h-5 shrink-0 items-center rounded-full border border-white/10 bg-white/[0.045] px-2 text-[10.5px] font-medium leading-none text-slate-300"
                title={metadata.subtitle}
              >
                {metadata.subtitle}
              </span>
            ) : null}
            {metadata.forkSourceSessionId ? (
              <button
                type="button"
                onClick={() => metadata.onOpenForkSource?.(metadata.forkSourceSessionId!)}
                disabled={!metadata.onOpenForkSource}
                className="app-fork-source-pill inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[10.5px] font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                title={`Forked from "${metadata.forkSourceTitle}" — open the source session`}
                data-kordi-window-drag="false"
              >
                <Split className="h-2.5 w-2.5" />
                <span className="max-w-[12rem] truncate">
                  Forked from {metadata.forkSourceTitle}
                </span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-start">
        {companion.canOpen && !companion.isOpen ? (
          <Button
            type="button"
            variant="secondary"
            onClick={companion.onOpen}
            className="app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] font-medium transition"
            aria-label="Ask Agent"
            title={companion.suggestedName
              ? `Ask Agent with ${companion.suggestedName}`
              : 'Ask Agent in a new session'}
          >
            <Columns2 className="mr-1.5 h-3.5 w-3.5" />
            Ask Agent
          </Button>
        ) : null}
      </div>
      {layout.showDestinations ? (
        <SessionDestinationTabs
          scope="main"
          activeDestination={layout.destination}
          onSelect={layout.onSelectDestination}
        />
      ) : null}
    </div>
  );
}
