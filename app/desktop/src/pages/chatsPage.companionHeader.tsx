import { useEffect, useRef, type DragEventHandler } from 'react';
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
  type ChatCompanionSessionOption,
  type CompanionSide,
} from '@/pages/chatsPage.model';
import { participantSpaceSessionRowTitle } from '@/pages/workspaceSidebar.chatHelpers';

type CompanionHeaderMenu = {
  actionsOpen: boolean;
  sessionListOpen: boolean;
  canCreateSession: boolean;
};

type CompanionHeaderActions = {
  onDragStart: DragEventHandler<HTMLElement>;
  onDragEnd: DragEventHandler<HTMLElement>;
  onToggleActions: () => void;
  onCloseActions: () => void;
  onCloseSessionList: () => void;
  onOpenSessionList: () => void;
  onSwitchConversation: (conversationId: string) => void;
  onCreateSession: () => void;
  onClose: () => void;
  onSelectDestination: (destination: ChatDestination) => void;
};

export type CompanionHeaderProps = {
  conversation: Conversation;
  sessionOptions: ChatCompanionSessionOption[];
  side: CompanionSide;
  destination: ChatDestination;
  menu: CompanionHeaderMenu;
  actions: CompanionHeaderActions;
};

export function CompanionHeader({
  conversation,
  sessionOptions,
  side,
  destination,
  menu,
  actions,
}: CompanionHeaderProps) {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const { onCloseActions } = actions;

  useEffect(() => {
    if (!menu.actionsOpen || typeof document === 'undefined') return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && controlsRef.current?.contains(target)) return;
      onCloseActions();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseActions();
      queueMicrotask(() => actionsTriggerRef.current?.focus());
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [menu.actionsOpen, onCloseActions]);

  useEffect(() => {
    if (!menu.actionsOpen || !menu.sessionListOpen) return;
    queueMicrotask(() => {
      const currentSession = sessionListRef.current?.querySelector<HTMLButtonElement>(
        '[data-side-chat-current-session="true"]',
      );
      const firstSession = sessionListRef.current?.querySelector<HTMLButtonElement>(
        '[data-side-chat-session-option="true"]',
      );
      (currentSession ?? firstSession)?.focus();
    });
  }, [menu.actionsOpen, menu.sessionListOpen]);

  return (
    <div
      className="app-page-header app-chat-pane-header relative z-40 flex shrink-0 cursor-grab items-start justify-between gap-3 active:cursor-grabbing"
      draggable
      onDragStart={actions.onDragStart}
      onDragEnd={actions.onDragEnd}
      title={`Drag to move ${companionLabel(conversation)} left or right`}
      data-companion-side={side}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 w-full flex-col text-white">
            <span
              className="app-chat-pane-title-row min-w-0 w-full truncate text-[17px] font-semibold leading-6"
              title={`Ask Agent · ${conversation.name}`}
            >
              Ask Agent · {conversation.name}
            </span>
            <span data-chat-session-subtitle="true" className="app-chat-pane-metadata-row text-[11px] leading-5 text-slate-400">Agent session</span>
          </div>
        </div>
      </div>
      <div
        ref={controlsRef}
        className="relative flex shrink-0 items-center gap-0.5"
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label="Side chat controls"
        data-side-chat-controls="true"
      >
        <button
          ref={actionsTriggerRef}
          type="button"
          className="app-button-quiet grid h-7 w-7 shrink-0 place-items-center rounded-full p-0 opacity-70 hover:opacity-100"
          title="Side chat options"
          aria-label="Side chat options"
          aria-expanded={menu.actionsOpen}
          onClick={actions.onToggleActions}
        >
          <Ellipsis className="h-3.5 w-3.5" />
        </button>
        {menu.actionsOpen ? (
          <div
            data-side-chat-options-menu="true"
            data-side-chat-root-menu="true"
            className="app-transient-surface absolute right-8 top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-[18px] border p-1.5"
          >
            {menu.sessionListOpen ? (
              <div
                ref={sessionListRef}
                data-side-chat-session-list="true"
                className="flex max-h-[min(24rem,55vh)] min-h-0 flex-col"
              >
                <button
                  type="button"
                  className="app-transient-row app-transient-flat-action app-transient-action-row mb-1 flex w-full shrink-0 items-center gap-2 rounded-[12px] px-2 py-1.5 text-left transition"
                  onClick={actions.onCloseSessionList}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  <span>Back</span>
                </button>
                <div className="mb-1 h-px shrink-0 bg-[color:var(--app-divider)]" aria-hidden="true" />
                <div className="app-transient-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5">
                  {sessionOptions.map((option) => {
                    const candidate = option.conversation;
                    const isCurrent = candidate.id === conversation.id;
                    const isFork = option.depth > 0;
                    const visualDepth = Math.min(option.depth, 4);
                    const rowTitle = participantSpaceSessionRowTitle(candidate.name);
                    const stateLabel = option.openInMain
                      ? 'Open in main panel'
                      : isCurrent
                        ? 'Current side chat'
                        : 'Switch side chat';
                    return (
                      <div
                        key={candidate.id}
                        className={cn(
                          isFork
                            && 'mt-px ml-2 border-l border-[color:var(--app-divider)] pl-1',
                        )}
                        data-session-fork-depth={isFork ? option.depth : undefined}
                      >
                        <button
                          type="button"
                          aria-current={isCurrent ? 'page' : undefined}
                          aria-disabled={option.openInMain || undefined}
                          aria-label={`${rowTitle}, ${stateLabel}`}
                          data-side-chat-session-option="true"
                          data-side-chat-current-session={isCurrent ? 'true' : undefined}
                          data-side-chat-open-in-main={option.openInMain ? 'true' : undefined}
                          className={cn(
                            'app-transient-row app-transient-action-row flex w-full items-center justify-between gap-2 rounded-[12px] px-2.5 py-1.5 text-left transition',
                            isCurrent && 'app-transient-row-selected',
                            !isCurrent && 'app-transient-flat-action',
                            option.openInMain && 'cursor-default opacity-60',
                          )}
                          style={isFork ? {
                            paddingInlineStart: `${0.625 + visualDepth * 0.875}rem`,
                          } : undefined}
                          title={`${rowTitle} — ${stateLabel}`}
                          onClick={() => {
                            if (!option.selectable) return;
                            actions.onSwitchConversation(candidate.id);
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{rowTitle}</span>
                          {option.openInMain ? (
                            <span className="shrink-0 text-[10px] font-medium text-[color:var(--app-transient-subtle-text)]">
                              Main
                            </span>
                          ) : isCurrent ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-[color:var(--app-transient-subtle-text)]">
                              <span className="h-1.5 w-1.5 rounded-full bg-pink-300" aria-hidden="true" />
                              Current
                            </span>
                          ) : null}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {menu.canCreateSession ? (
                  <button
                    type="button"
                    className="app-transient-row flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition"
                    title="New chat"
                    aria-label="New chat"
                    onClick={() => {
                      actions.onCloseActions();
                      actions.onCreateSession();
                    }}
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
