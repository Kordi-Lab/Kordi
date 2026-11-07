import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAgentSubsession } from '@/features/cloud/useAgentSubsession';
import { agentSubsessionStatusNotice } from '@/features/cloud/agentSubsessionTasks';
import { useBackgroundSessionControl } from '@/features/chat/useBackgroundSessionControl';

import {
  normalizedRelatedAgentSessionStatus,
  runStatusFromTurn,
  type RelatedAgentSession,
  type RelatedAgentSessionRunStatus,
} from '@/features/chat/relatedAgentSessions';
import { cn } from '@/lib/utils';
import { backgroundSessionGroupSummary, FOLDED_BACKGROUND_SESSION_ROWS } from '@/features/chat/backgroundSessionGroups';

const STATUS: Record<RelatedAgentSessionRunStatus, { label: string; tone: string }> = {
  running: { label: 'Running', tone: 'text-[color:var(--app-sidebar-accent)]' },
  done: { label: 'Done', tone: 'text-emerald-600 dark:text-emerald-400' },
  failed: { label: 'Failed', tone: 'text-[color:var(--app-error-text)]' },
  stopped: { label: 'Stopped', tone: 'text-[color:var(--utility-muted-text)]' },
};

const foldedGroups = new Map<string, boolean>();
const FOLD_STORAGE_KEY = 'kordi.backgroundSessionGroups.folded';

function rememberedFold(key: string): boolean | undefined {
  if (foldedGroups.has(key)) return foldedGroups.get(key);
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(FOLD_STORAGE_KEY) ?? '{}') as Record<string, boolean>;
    return typeof stored[key] === 'boolean' ? stored[key] : undefined;
  } catch { return undefined; }
}

function rememberFold(key: string, folded: boolean) {
  foldedGroups.set(key, folded);
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(FOLD_STORAGE_KEY) ?? '{}') as Record<string, boolean>;
    window.sessionStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify({ ...stored, [key]: folded }));
  } catch { /* Folding still works for this page. */ }
}

/**
 * Background sessions an agent started from this message, as child rows
 * under it: one bracket line down the left with an elbow into the last row,
 * the title on one line and a small status glyph that turns into "…" on hover.
 * A long group folds into one summary line; the chevron toggles it.
 */
export function RelatedAgentSessionLinks({
  sessions,
  statusBySessionId,
  onOpen,
}: {
  sessions: RelatedAgentSession[];
  /** Kept for callers; the rows no longer name the agent. */
  agentName?: string | null;
  statusBySessionId?: ReadonlyMap<string, RelatedAgentSessionRunStatus>;
  onOpen?: (sessionId: string, isSubsession?: boolean) => void;
}) {
  const groupKey = sessions.map(session => session.sessionId).join('|');
  const [userFold, setUserFold] = useState<{ key: string; folded: boolean } | null>(null);
  const [resolved, setResolved] = useState<Record<string, RelatedAgentSessionRunStatus>>({});
  const reportStatus = useCallback((sessionId: string, status: RelatedAgentSessionRunStatus) => {
    setResolved(current => current[sessionId] === status ? current : { ...current, [sessionId]: status });
  }, []);
  if (sessions.length === 0) return null;
  const folded = (userFold?.key === groupKey ? userFold.folded : undefined)
    ?? rememberedFold(groupKey) ?? sessions.length > FOLDED_BACKGROUND_SESSION_ROWS;
  const toggle = () => { rememberFold(groupKey, !folded); setUserFold({ key: groupKey, folded: !folded }); };
  const summary = backgroundSessionGroupSummary(sessions.map(session => resolved[session.sessionId]
    ?? statusBySessionId?.get(session.sessionId) ?? normalizedRelatedAgentSessionStatus(session.status)));

  return (
    <div
      className="group/sessions relative isolate ml-1 mt-1 grid w-[30rem] max-w-[calc(100%-0.25rem)]"
      data-related-agent-sessions="true"
      data-related-agent-session-style="bracket"
      data-related-agent-sessions-folded={folded ? 'true' : 'false'}
    >
      {!folded ? <button type="button" onClick={toggle} aria-expanded={true}
        aria-label={`Fold ${summary.text}`}
        className="absolute -top-2.5 left-0 z-10 hidden h-4 w-4 place-items-center rounded-[4px] text-[color:var(--utility-muted-text)] hover:text-[color:var(--utility-foreground)] focus-visible:grid group-hover/sessions:grid">
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button> : null}
      {folded ? <div className="group relative flex h-[26px] min-w-0 cursor-pointer items-center gap-2 pl-[22px] pr-1" onClick={toggle}
        data-related-agent-sessions-summary="true">
        <span aria-hidden="true" className="pointer-events-none absolute -top-1.5 bottom-1/2 left-[7px] w-[9px] rounded-bl-[8px] border-b border-l border-[color:var(--app-divider)]" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-px left-[18px] right-0 -z-10 rounded-md group-hover:bg-[color:var(--app-quiet-control-hover-bg)]" />
        <button type="button" aria-expanded={false} aria-label={`Show ${summary.text}`}
          onClick={(event) => { event.stopPropagation(); toggle(); }}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[12.5px] leading-[26px] text-[color:var(--utility-muted-text)] outline-none">
          <span className="truncate">{summary.text}</span>
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
        </button>
        <span className={cn('grid h-5 w-5 shrink-0 place-items-center', STATUS[summary.status].tone)}
          data-related-agent-sessions-summary-status={summary.status}>
          <StatusGlyph status={summary.status} />
        </span>
      </div> : null}
      {sessions.map((session, index) => <SubsessionLink key={session.sessionId} session={session}
        first={index === 0} last={index === sessions.length - 1} hidden={folded} onStatus={reportStatus}
        status={statusBySessionId?.get(session.sessionId)} onOpen={onOpen} />)}
    </div>
  );
}

function SubsessionLink({ session, first, last, hidden, status, onStatus, onOpen }: {
  session: RelatedAgentSession; first: boolean; last: boolean; hidden: boolean; status?: RelatedAgentSessionRunStatus;
  onStatus: (sessionId: string, status: RelatedAgentSessionRunStatus) => void;
  onOpen?: (id: string, isSubsession?: boolean) => void;
}) {
  const { snapshot: shared, error, accountId } = useAgentSubsession(session.sessionId);
  const control = useBackgroundSessionControl(session.sessionId, shared, accountId);
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !rowRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
    };
  }, [menuOpen]);
  const snapshot = control.remoteSnapshot;
  const localTurn = control.turn && (!snapshot?.startedAtMs || !control.turn.startedAtMs || snapshot.startedAtMs <= control.turn.startedAtMs) ? control.turn : null;
  const resolved = localTurn ? runStatusFromTurn(localTurn) : snapshot ? normalizedRelatedAgentSessionStatus(snapshot.status) : status ?? normalizedRelatedAgentSessionStatus(session.status);
  const presentation = STATUS[resolved];
  // A folded group still counts what each row is doing.
  useEffect(() => { onStatus(session.sessionId, resolved); }, [onStatus, resolved, session.sessionId]);
  const notice = control.stopping ? 'Stopping…' : localTurn ? null : error ? 'Sync unavailable' : snapshot ? agentSubsessionStatusNotice(snapshot) : null;
  const title = snapshot?.title ?? session.title;
  const open = () => { setMenuOpen(false); onOpen?.(session.sessionId, true); };
  return <div ref={rowRef} className="group relative flex h-[26px] min-w-0 items-center gap-2 pl-[22px] pr-1"
    hidden={hidden} data-related-agent-session-id={session.sessionId} onClick={onOpen ? open : undefined}>
    <span aria-hidden="true" className={cn('pointer-events-none absolute left-[7px] border-l border-[color:var(--app-divider)]',
      first ? '-top-1.5' : 'top-0',
      last ? 'bottom-1/2 w-[9px] rounded-bl-[8px] border-b' : 'bottom-0')} />
    <span aria-hidden="true" className={cn('pointer-events-none absolute inset-y-px left-[18px] right-0 -z-10 rounded-md',
      onOpen && 'group-hover:bg-[color:var(--app-quiet-control-hover-bg)]', menuOpen && 'bg-[color:var(--app-quiet-control-hover-bg)]')} />
    <button
      type="button"
      className={cn('min-w-0 flex-1 truncate text-left text-[12.5px] leading-[26px] outline-none disabled:cursor-default',
        resolved === 'running' || resolved === 'done' ? 'text-[color:var(--utility-foreground)]' : 'text-[color:var(--utility-muted-text)]')}
      onClick={(event) => { event.stopPropagation(); open(); }}
      disabled={!onOpen}
      title={title}
      aria-label={`Open background agent session: ${title}`}
    >
      {title}
    </button>
    <span
      className={cn('grid h-5 w-5 shrink-0 place-items-center', presentation.tone, (menuOpen || onOpen) && 'group-hover:hidden', menuOpen && 'hidden')}
      data-related-agent-session-status={resolved}
      title={notice ?? presentation.label}
      aria-live="polite"
    >
      <StatusGlyph status={control.stopping ? 'running' : resolved} />
      <span className="sr-only">{notice ?? presentation.label}</span>
    </span>
    <button
      type="button"
      className={cn('app-button-quiet hidden h-5 w-5 shrink-0 place-items-center rounded-[5px] text-[color:var(--utility-muted-text)] focus-visible:grid group-hover:grid',
        menuOpen && 'grid')}
      aria-label={`More actions for ${title}`}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? menuId : undefined}
      onClick={(event) => { event.stopPropagation(); setMenuOpen(value => !value); }}
    >
      <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    {menuOpen ? <div id={menuId} role="menu" className="absolute right-1 top-[28px] z-20 grid min-w-36 gap-px rounded-[9px] border border-[color:var(--app-transient-divider)] bg-[color:var(--app-transient-surface-fallback,var(--app-main-bg))] p-1 text-[12.5px] text-[color:var(--app-transient-text)] shadow-lg"
      onClick={(event) => event.stopPropagation()}>
      {onOpen ? <button type="button" role="menuitem" className="app-button-quiet rounded-md px-2 py-1 text-left" onClick={open}>Open</button> : null}
      {control.canStop ? <button type="button" role="menuitem" className="app-button-quiet rounded-md px-2 py-1 text-left text-[color:var(--app-error-text)] disabled:opacity-60"
        aria-label={`${control.stopping ? 'Stopping' : 'Stop'} background agent session: ${title}`} disabled={control.stopping}
        onClick={() => { void control.stop(); }}>{control.stopping ? 'Stopping…' : 'Stop'}</button> : null}
    </div> : null}
    {control.error ? <span role="alert" className="sr-only">{control.error}</span> : null}
  </div>;
}

function StatusGlyph({ status }: { status: RelatedAgentSessionRunStatus }) {
  if (status === 'running') {
    return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
      <circle cx="6" cy="6" r="4.5" stroke="var(--app-divider)" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>;
  }
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.3" />
    {status === 'done' ? <path d="M4.6 7.2l1.6 1.6 3.2-3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /> : null}
    {status === 'stopped' ? <rect x="5" y="5" width="4" height="4" rx=".8" fill="currentColor" /> : null}
    {status === 'failed' ? <><path d="M7 4.2v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="7" cy="9.7" r=".75" fill="currentColor" /></> : null}
  </svg>;
}
