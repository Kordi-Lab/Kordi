import { Bell, BellOff, CheckCircle2, Mail, Settings } from 'lucide-react';
import type { SessionContextMenuTarget } from '@/pages/SessionActionOverlays';

const ROW_CLASS = 'app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition';

/**
 * The context menu of a personal session. It is never renamed, pinned,
 * moved, archived or deleted; only its read state and mute change here.
 */
export function PersonalAgentSessionMenu({
  target, onClose, onSetMuted, onSetUnread, onOpenAgentSettings,
}: {
  target: SessionContextMenuTarget & { personalAgent: NonNullable<SessionContextMenuTarget['personalAgent']> };
  onClose: () => void;
  onSetMuted: (sessionId: string, muted: boolean) => void;
  onSetUnread: (sessionId: string, unread: boolean) => void;
  onOpenAgentSettings?: (localAgentId: string) => void;
}) {
  const run = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        role="menu"
        aria-label={`${target.sessionName} actions`}
        className="app-transient-surface app-modal-panel absolute w-[220px] rounded-[18px] border p-1.5"
        style={{
          left: Math.max(12, Math.min(target.x, window.innerWidth - 232)),
          top: Math.max(12, Math.min(target.y, window.innerHeight - 160)),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" role="menuitem" data-session-context-action={target.unread ? 'read' : 'unread'} className={ROW_CLASS}
          onClick={() => run(() => onSetUnread(target.sessionId, !target.unread))}>
          {target.unread
            ? <CheckCircle2 className="app-transient-action-icon" aria-hidden="true" />
            : <Mail className="app-transient-action-icon" aria-hidden="true" />}
          {target.unread ? 'Mark as read' : 'Mark as unread'}
        </button>
        <button type="button" role="menuitem" data-session-context-action="mute" className={ROW_CLASS}
          onClick={() => run(() => onSetMuted(target.sessionId, !target.muted))}>
          {target.muted
            ? <Bell className="app-transient-action-icon" aria-hidden="true" />
            : <BellOff className="app-transient-action-icon" aria-hidden="true" />}
          {target.muted ? 'Unmute' : 'Mute'}
        </button>
        {onOpenAgentSettings ? (
          <button type="button" role="menuitem" data-session-context-action="agent-settings" className={ROW_CLASS}
            onClick={() => run(() => onOpenAgentSettings(target.personalAgent.localAgentId))}>
            <Settings className="app-transient-action-icon" aria-hidden="true" />
            Agent settings
          </button>
        ) : null}
      </div>
    </div>
  );
}
