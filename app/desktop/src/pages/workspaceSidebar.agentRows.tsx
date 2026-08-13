import { Bookmark, ChevronRight, Paperclip, Pin, Split } from 'lucide-react';

import { attachmentPreviewUrl } from '@/features/chat/attachmentMediaGallery';
import { attachmentOnlyMessagePreview } from '@/features/chat/participantConversationState';
import { primaryAgentForConversation } from '@/features/chat/participantSpaces';
import { cn } from '@/lib/utils';
import type { ChatSidebarRow } from '@/pages/sidebar/chatSidebarRows';
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
  onPrefetchChatSession,
  onSelectChatSession,
  onOpenSessionContextMenu,
}: {
  descriptor: ChatSidebarRow;
  model: WorkspaceChatSidebarModel;
  activeConvId: string;
  onPrefetchChatSession?: (sessionId: string) => void;
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
  const isSavedMessages = space.kind === 'self' && !agentIdentity;
  const latestMessage = conversation.messages[conversation.messages.length - 1];
  const savedMessageAttachmentPreview = isSavedMessages
    ? attachmentOnlyMessagePreview(latestMessage)
    : null;
  const savedMessagePreviewAttachment = savedMessageAttachmentPreview?.kind === 'image'
    ? latestMessage?.attachments?.find((candidate) => (
      candidate.kind === 'image'
      || candidate.mimeType?.toLowerCase().startsWith('image/')
    ))
    : latestMessage?.attachments?.[0];
  const savedMessageThumbnailUrl = savedMessageAttachmentPreview?.kind === 'image'
    && savedMessagePreviewAttachment
    ? attachmentPreviewUrl(savedMessagePreviewAttachment)
    : null;
  const rowTitle = isSavedMessages ? space.title : sessionRowTitle;
  const subtitleLine = isSavedMessages
    ? sessionPreview
    : agentIdentity?.name
      ? `${agentIdentity.name} · ${sessionPreviewLine}`
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
        data-saved-messages-row={isSavedMessages ? 'true' : undefined}
        data-session-fork-of={
          isFork ? (session.forkedFromSessionId ?? '') : undefined
        }
        data-session-fork-depth={depth || undefined}
        style={indentPaddingLeft ? { paddingLeft: indentPaddingLeft } : undefined}
        onPointerEnter={() => onPrefetchChatSession?.(session.id)}
        onFocus={() => onPrefetchChatSession?.(session.id)}
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
          isSavedMessages && 'app-agent-session-row-saved',
        )}
      >
        {isSavedMessages ? (
          <span
            className="app-saved-messages-avatar grid h-9 w-9 shrink-0 place-items-center rounded-full"
            aria-hidden="true"
          >
            <Bookmark className="h-[1.15rem] w-[1.15rem]" strokeWidth={2} />
          </span>
        ) : null}
        <div className="app-agent-session-main min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="app-session-row-title min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100"
              title={rowTitle}
            >
              {rowTitle}
            </span>
          </div>
          <div
            className={cn(
              'app-agent-session-preview mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px] leading-[1rem]',
              isActive ? 'text-slate-300' : 'text-slate-500',
              session.statusIndicator?.live
                && 'app-participant-space-session-preview-live',
            )}
            data-agent-session-preview-kind={savedMessageAttachmentPreview?.kind}
          >
            {savedMessageThumbnailUrl ? (
              <img
                src={savedMessageThumbnailUrl}
                alt=""
                aria-hidden="true"
                data-sidebar-image-thumbnail="true"
                className="h-3.5 w-3.5 shrink-0 rounded-[2px] object-cover"
              />
            ) : savedMessageAttachmentPreview?.kind === 'file' ? (
              <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : null}
            <span className="min-w-0 truncate">{subtitleLine}</span>
          </div>
        </div>
        <div className="app-agent-session-side">
          <SidebarSessionMetaColumn
            timeLabel={rowTimeLabel}
            unreadCount={session.unread}
            unreadScope="agent-session"
            indicator={session.statusIndicator}
            active={isActive}
            reserveStatusSpace={!isSavedMessages}
          />
          {isSavedMessages ? (
            <Pin className="app-saved-messages-pin h-3 w-3" aria-label="Pinned" />
          ) : null}
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
