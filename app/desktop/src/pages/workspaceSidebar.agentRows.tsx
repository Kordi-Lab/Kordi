import { ChevronRight, Split } from 'lucide-react';

import { primaryAgentForConversation } from '@/features/chat/participantSpaces';
import { cn } from '@/lib/utils';
import type { ChatSidebarRow } from '@/pages/sidebar/VirtualChatList';
import {
  participantSpaceSessionMessageCount,
  participantSpaceSessionPreviewLine,
  participantSpaceSessionPreviewText,
  participantSpaceSessionRowTitle,
  sessionContextMenuTargetForConversation,
} from '@/pages/workspaceSidebar.chatHelpers';
import type { WorkspaceChatSidebarModel } from '@/pages/workspaceSidebar.chatModel';
import { SidebarSessionMetaColumn } from '@/pages/workspaceSidebar.shared';
import type { SessionContextMenuTarget } from '@/pages/SessionActionOverlays';

export function AgentSidebarRow({
  descriptor,
  model,
  activeConvId,
  onSelectChatSession,
  onOpenSessionContextMenu,
}: {
  descriptor: ChatSidebarRow;
  model: WorkspaceChatSidebarModel;
  activeConvId: string;
  onSelectChatSession: (sessionId: string) => void;
  onOpenSessionContextMenu: (target: SessionContextMenuTarget) => void;
}) {
  if (descriptor.kind !== 'session') return null;
  const row = model.agentSessionRowsById.get(descriptor.sessionId);
  if (!row) return null;
  const { session, space } = row;
  const conversation = session.conversation;
  const isActive =
    activeConvId === session.id || activeConvId === session.canonicalSessionId;
  const rowTimeLabel =
    session.updatedAtLabel ?? conversation.updatedAtLabel ?? '--:--';
  const sessionPreview =
    participantSpaceSessionPreviewText(session.preview) || 'No messages yet';
  const sessionRowTitle = participantSpaceSessionRowTitle(session.title);
  const sessionMessageCount = participantSpaceSessionMessageCount(session);
  const sessionPreviewLine = participantSpaceSessionPreviewLine(
    sessionPreview,
    sessionMessageCount,
  );
  const agentIdentity = primaryAgentForConversation(conversation);
  const agentName = agentIdentity?.name ?? space.title;
  const subtitleLine = agentName
    ? `${agentName} · ${sessionPreviewLine}`
    : sessionPreviewLine;
  const forks =
    model.agentForkLineage.forksByParentSessionId.get(session.id) ?? [];
  const hasForks = forks.length > 0;
  const expanded = hasForks && model.isForkListExpanded(session.id);
  const isFork = descriptor.depth > 0;
  const depth = Math.min(descriptor.depth, 4);
  const indentPaddingLeft =
    depth > 0 ? `${0.625 + depth * 0.875}rem` : undefined;

  return (
    <div
      className={cn(
        isFork
          && 'app-session-fork-children mt-px ml-3 border-l border-white/[0.08] pl-2',
        isFork
          && descriptor.activePath
          && 'app-session-fork-children-active',
      )}
      data-session-fork-depth={isFork ? descriptor.depth : undefined}
      data-session-fork-path-active={
        isFork && descriptor.activePath ? true : undefined
      }
    >
      <button
        type="button"
        data-testid="agent-session-row"
        data-agent-session-row={session.id}
        data-session-preview={sessionPreview}
        data-session-preview-line={sessionPreviewLine}
        data-session-message-count={sessionMessageCount}
        data-session-updated-at={rowTimeLabel}
        data-session-fork-of={
          isFork ? (session.forkedFromSessionId ?? '') : undefined
        }
        data-session-fork-depth={depth || undefined}
        style={indentPaddingLeft ? { paddingLeft: indentPaddingLeft } : undefined}
        onClick={() => onSelectChatSession(session.id)}
        onContextMenu={(event) => {
          const target = sessionContextMenuTargetForConversation(
            conversation,
            event.clientX,
            event.clientY,
          );
          if (!target) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenSessionContextMenu(target);
        }}
        className={cn(
          'app-session-row app-agent-session-row w-full px-2.5 py-1 text-left text-white',
          isActive && 'app-session-row-active',
          isFork && 'app-session-row-fork',
        )}
      >
        <div className="app-agent-session-main min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="app-session-row-title min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100"
              title={sessionRowTitle}
            >
              {sessionRowTitle}
            </span>
          </div>
          <div
            className={cn(
              'mt-0.5 truncate text-[10.5px] leading-[1rem]',
              isActive ? 'text-slate-300' : 'text-slate-500',
              session.statusIndicator?.live
                && 'app-participant-space-session-preview-live',
            )}
          >
            {subtitleLine}
          </div>
        </div>
        <div className="app-agent-session-side">
          <SidebarSessionMetaColumn
            timeLabel={rowTimeLabel}
            unreadCount={session.unread}
            unreadScope="agent-session"
            indicator={session.statusIndicator}
            active={isActive}
          />
          {hasForks ? (
            <>
              <span
                className="app-agent-session-fork-count inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-white/[0.06] px-1.5 text-[9.5px] font-medium tabular-nums text-slate-300"
                title={`${forks.length} fork${forks.length === 1 ? '' : 's'} of this session`}
                aria-label={`${forks.length} forks`}
              >
                <Split className="h-2.5 w-2.5" />
                <span>{forks.length}</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  model.toggleForkParent(session.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  model.toggleForkParent(session.id);
                }}
                className="app-agent-session-fork-toggle inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-100"
                aria-label={expanded ? 'Hide forks' : 'Show forks'}
                title={expanded ? 'Hide forks' : 'Show forks'}
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
              </span>
            </>
          ) : isFork ? (
            <span
              className="app-agent-session-fork-marker inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500"
              aria-hidden="true"
              title="Forked session"
            >
              <Split className="h-3 w-3" />
            </span>
          ) : null}
        </div>
      </button>
    </div>
  );
}
