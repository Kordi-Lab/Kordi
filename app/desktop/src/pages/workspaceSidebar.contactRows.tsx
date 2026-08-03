import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Split } from 'lucide-react';

import { isBlankParticipantSpaceSession } from '@/features/chat/participantSpaces';
import { cn } from '@/lib/utils';
import type { ChatSidebarRow } from '@/pages/sidebar/VirtualChatList';
import {
  participantSpaceCanRenameSessions,
  participantSpaceDetailText,
  participantSpaceKindText,
  participantSpaceSessionIdLabel,
  participantSpaceSessionMessageCount,
  participantSpaceSessionPreviewLine,
  participantSpaceSessionPreviewText,
  participantSpaceSessionRowTitle,
  sessionContextMenuTargetForConversation,
} from '@/pages/workspaceSidebar.chatHelpers';
import type { WorkspaceChatSidebarModel } from '@/pages/workspaceSidebar.chatModel';
import { ParticipantSpaceAvatarStack } from '@/pages/workspaceSidebar.chatPrimitives';
import { SidebarSessionMetaColumn } from '@/pages/workspaceSidebar.shared';
import type { WorkspaceSidebarParticipantSpace as ParticipantSpaceItem } from '@/pages/workspaceSidebar.types';
import type { SessionContextMenuTarget } from '@/pages/SessionActionOverlays';
import type { GroupManagementPopoverAnchor } from '@/pages/GroupDetailsDialog';

export type ContactSidebarRowActions = {
  onPrefetchChatSession?: (sessionId: string) => void;
  onSelectChatSession: (sessionId: string) => void;
  onOpenSessionContextMenu: (target: SessionContextMenuTarget) => void;
  onOpenGroupDetails: (
    space: ParticipantSpaceItem,
    anchor: GroupManagementPopoverAnchor,
  ) => void;
  onCreateChatSessionInParticipantSpace: (
    space: ParticipantSpaceItem,
  ) => Promise<void> | void;
};

function ParticipantSpaceSessionRow({
  session,
  space,
  depth,
  model,
  actions,
  activeConvId,
}: {
  session: ParticipantSpaceItem['sessions'][number];
  space: ParticipantSpaceItem;
  depth: number;
  model: WorkspaceChatSidebarModel;
  actions: ContactSidebarRowActions;
  activeConvId: string;
}) {
  const conversation = session.conversation;
  const isActive =
    activeConvId === session.id || activeConvId === session.canonicalSessionId;
  const sessionRowTimeLabel =
    session.updatedAtLabel ?? conversation.updatedAtLabel ?? '--:--';
  const sessionPreview =
    participantSpaceSessionPreviewText(session.preview) || 'No messages yet';
  const sessionRowTitle = participantSpaceSessionRowTitle(session.title);
  const sessionMessageCount = participantSpaceSessionMessageCount(session);
  const sessionPreviewLine = participantSpaceSessionPreviewLine(
    sessionPreview,
    sessionMessageCount,
  );
  const sessionIdLabel = participantSpaceSessionIdLabel(session);
  const isFork = depth > 0;
  const childForks =
    model.globalForkLineage.forksByParentSessionId.get(session.id) ?? [];
  const hasForks = childForks.length > 0;
  const expanded = hasForks && model.isForkListExpanded(session.id);
  const ownSessionUnreadCount = model.sidebarSessionIsActive(session)
    ? 0
    : session.unread;
  const rowUnreadCount = expanded
    ? ownSessionUnreadCount
    : (model.unreadBySessionIdWithForkDescendants.get(session.id)
      ?? ownSessionUnreadCount);
  const visualDepth = Math.min(depth, 4);
  const indentPaddingLeft =
    visualDepth > 0 ? `${0.625 + visualDepth * 0.875}rem` : undefined;

  return (
    <button
      type="button"
      data-testid="participant-space-session-row"
      data-agent-session-row={session.id}
      data-session-preview={sessionPreview}
      data-session-preview-line={sessionPreviewLine}
      data-session-id-label={sessionIdLabel}
      data-session-message-count={sessionMessageCount}
      data-session-updated-at={sessionRowTimeLabel}
      data-session-fork-depth={visualDepth || undefined}
      onPointerEnter={() => actions.onPrefetchChatSession?.(session.id)}
      onFocus={() => actions.onPrefetchChatSession?.(session.id)}
      onClick={() => actions.onSelectChatSession(session.id)}
      onContextMenu={(event) => {
        const target = sessionContextMenuTargetForConversation(
          conversation,
          event.clientX,
          event.clientY,
          { canRename: participantSpaceCanRenameSessions(space) },
        );
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        actions.onOpenSessionContextMenu(target);
      }}
      style={indentPaddingLeft ? { paddingLeft: indentPaddingLeft } : undefined}
      className={cn(
        'app-session-row app-participant-space-session-row w-full px-2.5 py-1 text-left text-white',
        isActive && 'app-session-row-active',
        isFork && 'app-session-row-fork',
      )}
    >
      <div className="app-participant-space-session-main min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="app-session-row-title app-participant-space-session-title min-w-0 flex-1 truncate text-[12px] font-medium">
            {sessionRowTitle}
          </span>
        </div>
        <div
          className={cn(
            'app-participant-space-session-preview mt-px truncate text-[10.5px] leading-[1.05rem]',
            isActive ? 'text-slate-300' : 'text-slate-500',
            session.statusIndicator?.live
              && 'app-participant-space-session-preview-live',
          )}
        >
          {sessionPreviewLine}
        </div>
      </div>
      <div className="app-participant-space-session-side">
        <SidebarSessionMetaColumn
          timeLabel={sessionRowTimeLabel}
          unreadCount={rowUnreadCount}
          unreadScope="participant-session"
          indicator={session.statusIndicator}
          active={isActive}
        />
        {hasForks ? (
          <>
            <span
              className="app-participant-space-session-fork-count inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-white/[0.06] px-1.5 text-[9.5px] font-medium tabular-nums text-slate-300"
              title={`${childForks.length} fork${childForks.length === 1 ? '' : 's'} of this session`}
              aria-label={`${childForks.length} forks`}
            >
              <Split className="h-2.5 w-2.5" />
              <span>{childForks.length}</span>
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
              className="app-participant-space-session-fork-toggle inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-100"
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
            className="app-participant-space-session-fork-marker inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500"
            aria-hidden="true"
            title="Forked session"
          >
            <Split className="h-3 w-3" />
          </span>
        ) : null}
      </div>
    </button>
  );
}

function ParticipantSpaceRow({
  space,
  model,
  actions,
  activeConvId,
}: {
  space: ParticipantSpaceItem;
  model: WorkspaceChatSidebarModel;
  actions: ContactSidebarRowActions;
  activeConvId: string;
}) {
  const latestSession = space.sessions[0];
  const isDirectHuman = space.kind === 'direct-human';
  const hasBlankSession = space.sessions.some(isBlankParticipantSpaceSession);
  const isActiveSpace = model.activeParticipantSpaceId === space.id;
  const isPrimarySessionActive = Boolean(
    latestSession
      && (activeConvId === latestSession.id
        || activeConvId === latestSession.canonicalSessionId),
  );
  const isSelectedSpace =
    !isDirectHuman && model.selectedParticipantSpaceId === space.id;
  const isExpanded = !isDirectHuman && (isSelectedSpace || isActiveSpace);
  const isAutoExpanded = isExpanded && isActiveSpace && !isSelectedSpace;
  const rowTimeLabel =
    space.updatedAtLabel ?? latestSession?.updatedAtLabel ?? '--:--';
  const spaceUnreadCount =
    model.unreadByParticipantSpaceIdWithForkDescendants.get(space.id)
    ?? space.unread;
  const participantSpaceDetail = participantSpaceDetailText(space);
  const selectPrimarySession = () => {
    const primarySession = space.sessions[0];
    if (!primarySession) return;
    if (!isDirectHuman) model.setSelectedParticipantSpaceId(space.id);
    actions.onSelectChatSession(primarySession.id);
  };
  const toggleSpace = () => {
    if (isDirectHuman) return;
    model.setSelectedParticipantSpaceId((current) =>
      current === space.id ? null : space.id,
    );
  };

  return (
    <div
      className={cn(
        'app-participant-space-inline-group',
        isExpanded && 'app-participant-space-inline-group-expanded',
      )}
      data-participant-space-auto-expanded={isAutoExpanded ? 'true' : undefined}
    >
      <div
        className={cn(
          'app-participant-space-row-shell',
          isExpanded && 'app-participant-space-row-shell-expanded',
          isDirectHuman
            && isPrimarySessionActive
            && 'app-session-row-active app-participant-space-row-shell-selected',
        )}
        data-participant-space-row-shell="true"
      >
        <button
          type="button"
          data-testid="participant-space-row"
          data-participant-space-toggle={isDirectHuman ? undefined : 'true'}
          aria-expanded={isDirectHuman ? undefined : isExpanded}
          onPointerEnter={() => {
            const primarySession = space.sessions[0];
            if (primarySession) actions.onPrefetchChatSession?.(primarySession.id);
          }}
          onFocus={() => {
            const primarySession = space.sessions[0];
            if (primarySession) actions.onPrefetchChatSession?.(primarySession.id);
          }}
          onClick={selectPrimarySession}
          className="app-session-row app-participant-space-row-button w-full min-w-0 text-left text-white"
        >
          <ParticipantSpaceAvatarStack space={space} />
          <div className="min-w-0">
            <div
              className="app-participant-space-row-title truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100"
              title={space.title}
            >
              {space.title}
            </div>
            <div
              className={cn(
                'app-participant-space-row-preview mt-px truncate text-[10.5px] leading-[0.98rem]',
                (isExpanded || (isDirectHuman && isPrimarySessionActive))
                  && 'app-participant-space-row-preview-active',
              )}
            >
              {space.preview || `${participantSpaceKindText(space)} space`}
            </div>
            {participantSpaceDetail ? (
              <div className="app-participant-space-row-detail mt-px truncate text-[10px] leading-[0.88rem]">
                {participantSpaceDetail}
              </div>
            ) : null}
          </div>
        </button>
        <div className="app-participant-space-row-side">
          {!isDirectHuman ? (
            <div
              className="app-participant-space-row-actions"
              data-participant-space-row-actions="true"
            >
              {space.kind === 'group' ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    model.setSelectedParticipantSpaceId(space.id);
                    const rect = event.currentTarget.getBoundingClientRect();
                    actions.onOpenGroupDetails(space, {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                    });
                  }}
                  className="app-participant-space-action app-participant-space-menu-action grid h-6 w-6 shrink-0 place-items-center rounded-[8px]"
                  title="Group management"
                  aria-label="Open group management"
                  aria-haspopup="dialog"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              ) : (
                <span
                  className="app-participant-space-action-spacer h-6 w-6"
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                data-participant-space-context-create="true"
                data-disabled-reason={hasBlankSession ? 'blank-session' : undefined}
                disabled={hasBlankSession}
                className="app-participant-space-action app-participant-space-context-create grid h-6 w-6 place-items-center rounded-[8px] transition"
                aria-label={
                  hasBlankSession
                    ? `New session unavailable in ${space.title}: a blank chat already exists`
                    : `Create session in ${space.title}`
                }
                title={
                  hasBlankSession
                    ? 'Send a message in the blank chat before creating another session'
                    : `Create session in ${space.title}`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  model.setSelectedParticipantSpaceId(space.id);
                  void actions.onCreateChatSessionInParticipantSpace(space);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-participant-space-toggle-button="true"
                className="app-participant-space-action app-participant-space-enter-action grid h-6 w-6 place-items-center rounded-[8px]"
                title={isSelectedSpace ? 'Collapse sessions' : 'Expand sessions'}
                aria-label={`${isSelectedSpace ? 'Collapse' : 'Expand'} ${space.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSpace();
                }}
              >
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 transition',
                    isSelectedSpace ? 'rotate-180' : '',
                  )}
                />
              </button>
            </div>
          ) : null}
          <div className="app-participant-space-row-meta">
            <SidebarSessionMetaColumn
              timeLabel={rowTimeLabel}
              unreadCount={isExpanded ? 0 : spaceUnreadCount}
              unreadScope="participant-space"
              indicator={isExpanded ? undefined : latestSession?.statusIndicator}
              active={isDirectHuman && isPrimarySessionActive}
              reserveStatusSpace={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ContactSidebarRow({
  descriptor,
  model,
  actions,
  activeConvId,
}: {
  descriptor: ChatSidebarRow;
  model: WorkspaceChatSidebarModel;
  actions: ContactSidebarRowActions;
  activeConvId: string;
}) {
  if (descriptor.kind === 'space') {
    const space = model.contactSpaceById.get(descriptor.spaceId);
    return space ? (
      <ParticipantSpaceRow
        space={space}
        model={model}
        actions={actions}
        activeConvId={activeConvId}
      />
    ) : null;
  }
  const row = model.allSidebarSessionRowsById.get(descriptor.sessionId);
  return row ? (
    <ParticipantSpaceSessionRow
      session={row.session}
      space={row.space}
      depth={descriptor.depth}
      model={model}
      actions={actions}
      activeConvId={activeConvId}
    />
  ) : null;
}
