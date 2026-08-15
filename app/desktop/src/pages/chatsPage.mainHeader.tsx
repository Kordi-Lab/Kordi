import { Columns2, PanelLeftClose, PanelLeftOpen, Phone, Split, Video } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { Conversation } from '@/kordi-app/types';
import { SessionDestinationTabs } from '@/pages/chatsPage.destinations';
import type { ChatDestination } from '@/pages/chatsPage.destinationModel';
import { SupportReportAction } from '@/features/support/SupportReportDialog';
import type {
  CloudSupportTicketInput,
  CloudSupportTicketResult,
} from '@/features/cloud/supportClient';
import { useCloudCallContext } from '@/features/cloud/useCloudCallContext';

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
  supportReport?: {
    sessionId: string;
    onSubmit: (input: CloudSupportTicketInput) => Promise<CloudSupportTicketResult>;
  };
};

export function MainChatHeader({
  conversation,
  layout,
  metadata,
  rename,
  companion,
  supportReport,
}: MainHeaderProps) {
  const calls = useCloudCallContext();
  const callTarget = calls?.targetForConversation(conversation) ?? null;
  const activeCall = calls?.callForConversation(conversation) ?? null;
  const callIsCurrent = Boolean(activeCall && calls?.currentCall?.call.id === activeCall.id);
  const callBusyElsewhere = Boolean(calls?.currentCall && !callIsCurrent);
  const openActiveCall = () => {
    if (!calls || !activeCall) return;
    if (callIsCurrent) calls.show();
    else void calls.join(activeCall, callTarget?.sessionId);
  };
  const startCall = (kind: 'voice' | 'video') => {
    if (!calls) return;
    void calls.start(conversation, kind);
  };
  return (
    <div className="app-page-header app-chat-pane-header relative flex shrink-0 items-start justify-between gap-3">
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
          <div className="app-page-header-title-row app-chat-pane-title-row flex min-w-0 items-center text-white">
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
                  className="min-w-0 w-full rounded-lg bg-transparent px-1 py-0.5 text-left text-[17px] font-semibold text-white outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-white/20"
                  placeholder="Session name"
                />
              ) : (
                <h2 className="min-w-0 w-full text-[17px] font-semibold leading-6">
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
                className="min-w-0 w-full truncate text-[17px] font-semibold leading-6"
                data-kordi-window-drag="false"
                title={conversation.name}
              >
                {conversation.name}
              </h2>
            )}
          </div>
          {metadata.subtitle || metadata.forkSourceSessionId ? (
            <div
              className="app-chat-pane-metadata-row flex min-w-0 items-center gap-1 text-[11px] leading-5 text-slate-400"
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
        {calls && callTarget ? (
          <div className="app-chat-call-actions mt-0.5 flex items-center gap-1" aria-label="Call actions">
            {activeCall ? (
              <button
                type="button"
                className="app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] transition"
                onClick={openActiveCall}
                disabled={callBusyElsewhere}
                aria-label={callIsCurrent ? 'Return to call' : activeCall.kind === 'meeting' ? 'Join meeting' : 'Join call'}
                title={callBusyElsewhere
                  ? 'Finish your current call first'
                  : callIsCurrent ? 'Return to call' : activeCall.kind === 'meeting' ? 'Join meeting' : 'Join call'}
              >
                {activeCall.kind === 'voice' ? <Phone className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
              </button>
            ) : callTarget.kind === 'group' ? (
              <button
                type="button"
                className="app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] transition"
                onClick={() => startCall('video')}
                disabled={callBusyElsewhere}
                aria-label="Start group meeting"
                title={callBusyElsewhere ? 'Finish your current call first' : 'Start group meeting'}
              >
                <Video className="h-3.5 w-3.5" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] transition"
                  onClick={() => startCall('voice')}
                  disabled={callBusyElsewhere}
                  aria-label="Start voice call"
                  title={callBusyElsewhere ? 'Finish your current call first' : 'Start voice call'}
                >
                  <Phone className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] transition"
                  onClick={() => startCall('video')}
                  disabled={callBusyElsewhere}
                  aria-label="Start video call"
                  title={callBusyElsewhere ? 'Finish your current call first' : 'Start video call'}
                >
                  <Video className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        ) : null}
        {supportReport ? (
          <SupportReportAction
            sessionId={supportReport.sessionId}
            onSubmit={supportReport.onSubmit}
          />
        ) : null}
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
