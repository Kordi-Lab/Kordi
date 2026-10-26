import { BellOff } from 'lucide-react';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import type { SessionContextMenuTarget } from '@/pages/SessionActionOverlays';
import { participantSpaceSessionPreferenceId, participantSpaceSessionPreviewText } from '@/pages/workspaceSidebar.chatHelpers';
import type { WorkspaceChatSidebarModel } from '@/pages/workspaceSidebar.chatModel';
import { SidebarUnreadBadge } from '@/pages/workspaceSidebar.shared';
import type { PersonalAgentEntry } from './personalAgentStore';

type SidebarSessionRow = NonNullable<ReturnType<WorkspaceChatSidebarModel['allSidebarSessionRowsById']['get']>>;

/** One owned agent's always-online session at the top of Agent Chats. */
export function PersonalAgentSidebarRow({
  entry, row, model, activeConvId, onSelectChatSession, onOpenSessionContextMenu,
}: {
  entry?: PersonalAgentEntry;
  /** The local session, once this Mac has it. */
  row?: SidebarSessionRow;
  model: Pick<WorkspaceChatSidebarModel, 'mutedSessionIds' | 'unreadSessionIds'>;
  activeConvId: string;
  onSelectChatSession: (sessionId: string) => void;
  onOpenSessionContextMenu: (target: SessionContextMenuTarget) => void;
}) {
  if (!entry) return null;
  const session = row?.session;
  const sessionId = session?.id ?? entry.sessionId;
  const preferenceId = session ? participantSpaceSessionPreferenceId(session) : entry.sessionId;
  const isActive = [sessionId, session?.canonicalSessionId, entry.sessionId].some((id) => id && id === activeConvId);
  const preview = (session ? participantSpaceSessionPreviewText(session.preview) : '') || 'No messages yet';
  const timeLabel = session && session.conversation.messages.length > 0
    ? session.updatedAtLabel ?? session.conversation.updatedAtLabel ?? ''
    : '';
  const muted = model.mutedSessionIds.has(preferenceId);
  const unread = Math.max(model.unreadSessionIds.has(preferenceId) ? 1 : 0, session?.unread ?? 0);
  return (
    <button
      type="button"
      data-testid="personal-agent-row"
      data-personal-agent-row={entry.agentId}
      data-session-sidebar-section="personal"
      data-session-preview={preview}
      className={cn('app-session-row app-personal-agent-row w-full text-left', isActive && 'app-session-row-active')}
      aria-current={isActive ? 'true' : undefined}
      onClick={() => onSelectChatSession(sessionId)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenSessionContextMenu({
          sessionId: preferenceId, sessionName: entry.name, x: event.clientX, y: event.clientY, canRename: false,
          ...(muted ? { muted: true } : {}), ...(unread > 0 ? { unread: true } : {}),
          personalAgent: { agentId: entry.agentId, localAgentId: entry.localAgentId },
        });
      }}
    >
      <IdentityAvatar
        kind="agent"
        seed={entry.avatarSeed}
        name={entry.name}
        imageUrl={entry.profileImageUrl}
        className="app-personal-agent-avatar h-9 w-9"
        presenceStatus="online"
        presenceLabel={`${entry.name} is online`}
      />
      <span className="app-personal-agent-row-main">
        <span className="app-personal-agent-row-line">
          <span className="app-session-row-title app-personal-agent-row-title" title={entry.name}>{entry.name}</span>
          {muted ? <BellOff className="app-personal-agent-row-muted" aria-label="Muted" /> : null}
          {timeLabel ? <span className="app-personal-agent-row-time">{timeLabel}</span> : null}
        </span>
        <span className="app-personal-agent-row-line">
          <span className="app-personal-agent-row-preview">{preview}</span>
          <SidebarUnreadBadge count={unread} scope="agent-session" muted={muted} />
        </span>
      </span>
    </button>
  );
}
