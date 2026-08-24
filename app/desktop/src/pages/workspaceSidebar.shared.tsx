import type { SessionStatusIndicator } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

const SIDEBAR_STATUS_DOT_TONE: Record<SessionStatusIndicator['tone'], string> = {
  running: 'app-session-status-light-running',
  ready: 'app-session-status-light-ready',
  draft: 'app-session-status-light-draft',
  error: 'app-session-status-light-error',
  stopped: 'app-session-status-light-stopped',
};

export function SidebarSessionStatusIndicator({
  indicator,
}: {
  indicator?: SessionStatusIndicator;
}) {
  if (!indicator) return null;
  return (
    <span
      className={cn('app-session-status-light', SIDEBAR_STATUS_DOT_TONE[indicator.tone])}
      title={indicator.label}
      aria-label={indicator.label}
    />
  );
}

export function SidebarUnreadBadge({
  count,
  mentionCount,
  scope,
}: {
  count?: number;
  mentionCount?: number;
  scope?: string;
}) {
  if (!count || count <= 0) return null;

  const hasMention = Boolean(mentionCount && mentionCount > 0);
  const displayCount = count > 99 ? '99+' : count;

  return (
    <span
      className="app-sidebar-attention inline-flex shrink-0 items-center justify-end gap-1"
      aria-label={hasMention
        ? `${displayCount} unread messages, ${mentionCount} mention${mentionCount === 1 ? '' : 's'} for you`
        : `${displayCount} unread messages`}
    >
      {hasMention ? (
        <span className="app-sidebar-mention-indicator shrink-0" aria-hidden="true">@</span>
      ) : null}
      <span
        className="app-sidebar-unread-badge inline-flex min-w-[1.05rem] shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none"
        data-unread-scope={scope}
        data-unread-count={displayCount}
        data-unread-mention-count={hasMention ? mentionCount : undefined}
        aria-hidden="true"
      >
        {displayCount}
      </span>
    </span>
  );
}

export function SidebarSessionMetaColumn({
  timeLabel,
  unreadCount,
  unreadMentionCount,
  unreadScope,
  indicator,
  active = false,
  reserveStatusSpace = true,
}: {
  timeLabel: string;
  unreadCount?: number;
  unreadMentionCount?: number;
  unreadScope?: string;
  indicator?: SessionStatusIndicator;
  active?: boolean;
  reserveStatusSpace?: boolean;
}) {
  const hasStatusLine = Boolean((unreadCount && unreadCount > 0) || indicator);
  return (
    <div className="flex min-w-[2.9rem] shrink-0 flex-col items-end gap-[0.3rem] pt-px">
      <span
        className={cn(
          'app-session-meta-time whitespace-nowrap text-right text-[10px] font-medium leading-none tabular-nums',
          active && 'app-session-meta-time-active',
        )}
      >
        {timeLabel}
      </span>
      {reserveStatusSpace || hasStatusLine ? (
        <div className="flex h-2.5 items-center justify-end gap-1.5 self-end">
          <SidebarUnreadBadge count={unreadCount} mentionCount={unreadMentionCount} scope={unreadScope} />
          <SidebarSessionStatusIndicator indicator={indicator} />
        </div>
      ) : null}
    </div>
  );
}
