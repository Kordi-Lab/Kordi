import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import type { DesktopChatTurnSnapshot, DesktopChatToolSnapshot } from '../types';
import { groupTurnSegments } from '@/features/chat/turnSegments';
import { elapsedLabel, turnProgressLabel, settledProgressLabel } from './turnProgressLabels';
import { toolActivityMetadata } from './toolActivityMetadata';
import { MarkdownContent } from './markdown';

function ActivityGroup({ tools, unavailable = 0, label, active, elapsed, trailing, renderTool, thinkingText }: {
  tools: DesktopChatToolSnapshot[]; unavailable?: number; label: string; active?: boolean;
  elapsed?: string | null; trailing?: ReactNode; renderTool: (tool: DesktopChatToolSnapshot) => ReactNode; thinkingText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = tools[0] ? toolActivityMetadata(tools[0]).Icon : Wrench;
  const expandable = tools.length > 0 || unavailable > 0 || Boolean(thinkingText);
  return <section className="app-turn-progress" data-transcript-stable-disclosure-root="true">
    <div className="app-turn-progress-line">
      <button type="button" className="app-turn-progress-summary" aria-label={`${label}${elapsed ? ` ${elapsed}` : ''}`} aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable} data-transcript-stable-disclosure="true" onClick={() => setExpanded(value => !value)}>
        {active ? <span className="app-turn-progress-dots" aria-hidden="true"><i /><i /><i /></span> : <Icon size={14} aria-hidden="true" />}
        <span role={active ? 'status' : undefined}>{label}</span>
        {elapsed ? <span className="app-turn-progress-time" aria-hidden="true">{elapsed}</span> : null}
        {expandable ? <ChevronRight aria-hidden="true" className={expanded ? 'rotate-90' : undefined} size={13} /> : null}
      </button>
      {trailing}
    </div>
    {expanded ? <div className="app-turn-progress-details" data-transcript-stable-disclosure-body="true">
      {thinkingText ? <details><summary>Reasoning</summary><MarkdownContent text={thinkingText} tone="muted" className="app-transcript-thinking-markdown" /></details> : null}
      {tools.map(renderTool)}
      {unavailable > 0 ? <p className="text-xs">Details unavailable for {unavailable} earlier {unavailable === 1 ? 'tool' : 'tools'}.</p> : null}
    </div> : null}
  </section>;
}

/** Commentary stays in event order; only the last activity row is live. */
export function TurnProgress({ turn, trailing, renderTool, legacyAnswer }: {
  turn: DesktopChatTurnSnapshot; trailing?: ReactNode; renderTool: (tool: DesktopChatToolSnapshot) => ReactNode; legacyAnswer?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (turn.completed || turn.startedAtMs == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turn.completed, turn.startedAtMs]);
  const groups = groupTurnSegments(turn.segments ?? [], turn.tools);
  const ordered = groups.length > 0;
  const last = groups[groups.length - 1];
  const live = !turn.completed;
  const canFold = groups.some(group => group !== last || group.kind === 'tools') || Boolean(turn.thinkingText);
  const elapsed = elapsedLabel(turn, now);
  const [trajectoryExpanded, setTrajectoryExpanded] = useState(true);
  const legacyActivity = <ActivityGroup tools={turn.tools} thinkingText={turn.thinkingText}
    label={live ? turnProgressLabel(turn) : elapsed ? turnProgressLabel(turn) : turn.tools.length ? settledProgressLabel(turn.tools) : 'Activity'}
    active={live} elapsed={elapsed} trailing={live ? trailing : undefined} renderTool={renderTool} />;
  if (!ordered) return <>
    {!live && (turn.tools.length > 0 || turn.thinkingText) ? legacyActivity : null}
    {legacyAnswer}
    {live ? legacyActivity : null}
  </>;
  return <div className="app-ordered-progress" data-transcript-stable-disclosure-root="true">
    {!live && elapsed ? <button type="button" className="app-turn-worked-header" disabled={!canFold} aria-expanded={canFold ? trajectoryExpanded : undefined}
      data-transcript-stable-disclosure="true" onClick={() => setTrajectoryExpanded(value => !value)}>
      <span>{turnProgressLabel(turn)} {elapsed}</span>{canFold ? <ChevronRight size={13} aria-hidden="true" className={trajectoryExpanded ? 'rotate-90' : undefined} /> : null}
    </button> : null}
    <div hidden={!live && !trajectoryExpanded} className="app-turn-trajectory" data-transcript-stable-disclosure-body="true">
    {groups.filter(group => live || group !== last || group.kind !== 'text').map(group => group.kind === 'text'
      ? <div key={group.id} className="app-turn-commentary"><MarkdownContent text={group.text} /></div>
      : <ActivityGroup key={group.id} tools={group.tools} unavailable={group.unavailable}
          label={live && group === last ? turnProgressLabel(turn) : settledProgressLabel(group.tools, group.unavailable)}
          active={live && group === last} elapsed={live && group === last ? elapsed : null}
          thinkingText={group === last ? turn.thinkingText : undefined}
          trailing={live && group === last ? trailing : undefined} renderTool={renderTool} />)}
    {last?.kind !== 'tools' && (live || turn.thinkingText) ? <ActivityGroup tools={[]} label={live ? turnProgressLabel(turn) : 'Activity'}
      thinkingText={turn.thinkingText} active={live} elapsed={live ? elapsed : null} trailing={live ? trailing : undefined} renderTool={renderTool} /> : null}
    </div>
    {!live && last?.kind === 'text' ? <div className="app-turn-commentary app-turn-final"><MarkdownContent text={last.text} /></div> : null}
  </div>;
}
