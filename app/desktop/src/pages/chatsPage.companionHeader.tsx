import type { DragEventHandler } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  Ellipsis,
  SquarePen,
  X,
} from 'lucide-react';

import type { Conversation } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import type { ChatDestination } from '@/pages/chatsPage.destinationModel';
import { SessionDestinationTabs } from '@/pages/chatsPage.destinations';
import {
  companionLabel,
  type CompanionSide,
} from '@/pages/chatsPage.model';

type CompanionHeaderMenu = {
  actionsOpen: boolean;
  sessionListOpen: boolean;
  canCreateSession: boolean;
};

type CompanionHeaderActions = {
  onDragStart: DragEventHandler<HTMLElement>;
  onDragEnd: DragEventHandler<HTMLElement>;
  onToggleActions: () => void;
  onCloseSessionList: () => void;
  onOpenSessionList: () => void;
  onSwitchConversation: (conversationId: string) => void;
  onCreateSession: () => void;
  onClose: () => void;
  onSelectDestination: (destination: ChatDestination) => void;
};

export type CompanionHeaderProps = {
  conversation: Conversation;
  candidates: Conversation[];
  side: CompanionSide;
  destination: ChatDestination;
  menu: CompanionHeaderMenu;
  actions: CompanionHeaderActions;
};

export function CompanionHeader({
  conversation,
  candidates,
  side,
  destination,
  menu,
  actions,
}: CompanionHeaderProps) {
  return (
    <div
      className="app-page-header relative z-40 flex min-h-[84px] shrink-0 cursor-grab items-start justify-between gap-3 border-b border-white/[0.06] px-4 pb-8 pt-2.5 active:cursor-grabbing"
      draggable
      onDragStart={actions.onDragStart}
      onDragEnd={actions.onDragEnd}
      title={`Drag to move ${companionLabel(conversation)} left or right`}
      data-companion-side={side}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-col text-white">
            <span className="min-w-0 max-w-[18rem] truncate text-[17px] font-semibold leading-6">Ask Agent · {conversation.name}</span>
            <span data-chat-session-subtitle="true" className="text-[11px] leading-5 text-slate-400">Agent session</span>
          </div>
        </div>
      </div>
      <div
        className="relative flex shrink-0 items-center gap-0.5"
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label="Side chat controls"
        data-side-chat-controls="true"
      >
        <button
          type="button"
          className="app-button-quiet grid h-7 w-7 shrink-0 place-items-center rounded-full p-0 opacity-70 hover:opacity-100"
          title="Side chat options"
          aria-label="Side chat options"
          onClick={actions.onToggleActions}
        >
          <Ellipsis className="h-3.5 w-3.5" />
        </button>
        {menu.actionsOpen ? (
          <div
            data-side-chat-options-menu="true"
            data-side-chat-root-menu="true"
            className="app-transient-surface absolute right-8 top-full z-50 mt-2 w-44 rounded-[18px] border p-1.5 text-[13px] font-medium"
          >
            {menu.sessionListOpen ? (
              <div data-side-chat-session-list="true">
                <button
                  type="button"
                  className="app-transient-row mb-1 flex w-full items-center gap-2 rounded-[12px] px-2 py-1.5 text-left text-[13px] transition"
                  onClick={actions.onCloseSessionList}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  <span>Back</span>
                </button>
                <div className="mb-1 h-px bg-[color:var(--app-divider)]" aria-hidden="true" />
                {candidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={cn(
                      'app-transient-row flex w-full items-center justify-between gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-[13px] transition',
                      candidate.id === conversation.id && 'app-transient-row-selected',
                    )}
                    title={`Switch to ${candidate.name}`}
                    onClick={() => actions.onSwitchConversation(candidate.id)}
                  >
                    <span className="truncate">{candidate.name}</span>
                    {candidate.id === conversation.id ? (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-pink-300" aria-hidden="true" />
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                {menu.canCreateSession ? (
                  <button
                    type="button"
                    className="app-transient-row flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition"
                    title="New chat"
                    aria-label="New chat"
                    onClick={actions.onCreateSession}
                  >
                    <SquarePen className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">New chat</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="app-transient-row flex w-full items-center justify-between gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition"
                  onClick={actions.onOpenSessionList}
                >
                  <span>Switch Chat</span>
                  <ChevronDown className="h-4 w-4 -rotate-90" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        ) : null}
        <button
          type="button"
          onClick={actions.onClose}
          className="app-button-quiet grid h-7 w-7 shrink-0 place-items-center rounded-full p-0 opacity-70 hover:opacity-100"
          title="Close side chat"
          aria-label="Close side chat"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <SessionDestinationTabs
        scope="companion"
        activeDestination={destination}
        onSelect={actions.onSelectDestination}
      />
    </div>
  );
}
