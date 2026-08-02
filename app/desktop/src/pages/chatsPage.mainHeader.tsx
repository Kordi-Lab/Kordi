import { Columns2, PanelLeftClose, PanelLeftOpen, Split } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { Conversation } from '@/kordi-app/types';
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
      <div className="flex min-w-0 flex-1 items-center gap-2">
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
          <div className="app-page-header-title-row flex min-w-0 items-center text-white">
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
                  className="min-w-0 w-full max-w-[32rem] rounded-lg bg-transparent px-1 py-0.5 text-left text-[17px] font-semibold text-white outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-white/20"
                  placeholder="Session name"
                />
              ) : (
                <h2 className="min-w-0 w-full max-w-[32rem] text-[17px] font-semibold leading-6">
                  <button
                    type="button"
                    onDoubleClick={rename.begin}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      rename.begin();
                    }}
                    className="app-button-quiet -ml-1 inline-block max-w-full truncate rounded-lg px-1 py-0.5 text-left font-semibold"
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
                className="min-w-0 w-full max-w-[32rem] truncate text-[17px] font-semibold leading-6"
                data-kordi-window-drag="false"
                title={conversation.name}
              >
                {conversation.name}
              </h2>
            )}
          </div>
          {metadata.subtitle || metadata.forkSourceSessionId ? (
            <div
              className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-5 text-slate-400"
              data-chat-session-metadata="true"
            >
              {metadata.subtitle ? (
                <span
                  data-chat-session-subtitle="true"
                  className="min-w-0 truncate"
                  title={metadata.subtitle}
                >
                  {metadata.subtitle}
                </span>
              ) : null}
              {metadata.subtitle && metadata.forkSourceSessionId ? (
                <span className="shrink-0 opacity-50" aria-hidden="true">·</span>
              ) : null}
              {metadata.forkSourceSessionId ? (
                <button
                  type="button"
                  onClick={() => metadata.onOpenForkSource?.(metadata.forkSourceSessionId!)}
                  disabled={!metadata.onOpenForkSource}
                  className="app-button-quiet app-fork-source-link inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium"
                  title={`Forked from "${metadata.forkSourceTitle}" — open the source session`}
                  aria-label={`Open source session ${metadata.forkSourceTitle}`}
                  data-kordi-window-drag="false"
                >
                  <Split className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="max-w-[18rem] truncate">
                    Forked from {metadata.forkSourceTitle}
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-start">
        {companion.canOpen && !companion.isOpen ? (
          <Button
            type="button"
            variant="quiet"
            onClick={companion.onOpen}
            className="app-utility-button mt-0.5 h-8 rounded-[10px] px-2.5 text-[12px] font-medium"
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
