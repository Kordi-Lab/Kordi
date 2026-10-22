import { useEffect, useState, type ReactNode } from 'react';
import { Brain, ChevronRight, Wrench } from 'lucide-react';
import type { DesktopChatTurnSnapshot, DesktopChatToolSnapshot } from '../types';
import { groupTurnSegments } from '@/features/chat/turnSegments';
import { elapsedLabel, turnProgressLabel, settledProgressLabel, progressToolIsActive } from './turnProgressLabels';
import { toolActivityMetadata } from './toolActivityMetadata';
import { MarkdownContent } from './markdown';
import { ProgressBird } from './ProgressBird';

function ActivityGroup({ tools, unavailable = 0, label, active, elapsed, trailing, renderTool, thinkingText, hideIcon }: {
  tools: DesktopChatToolSnapshot[]; unavailable?: number; label: string; active?: boolean;
  elapsed?: string | null; trailing?: ReactNode; renderTool: (tool: DesktopChatToolSnapshot) => ReactNode; thinkingText?: string; hideIcon?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = tools[0] ? toolActivityMetadata(tools[0]).Icon : thinkingText ? Brain : Wrench;
  const expandable = tools.length > 0 || unavailable > 0 || Boolean(thinkingText);
  return <section className={`app-turn-progress${thinkingText ? ' app-turn-reasoning' : ''}`} data-transcript-stable-disclosure-root="true">
    <div className="app-turn-progress-line">
      <button type="button" className="app-turn-progress-summary" aria-label={`${label}${elapsed ? ` ${elapsed}` : ''}`} aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable} data-transcript-stable-disclosure="true" onClick={() => setExpanded(value => !value)}>
        {active ? <ProgressBird /> : !hideIcon ? <Icon size={14} aria-hidden="true" /> : null}
        <span role={active ? 'status' : undefined} className={active ? 'app-turn-status-label' : undefined}><span key={label} className={active ? 'app-turn-status-text' : undefined}>{label}</span></span>
        {elapsed ? <span className="app-turn-progress-time" aria-hidden="true">{elapsed}</span> : null}
        {expandable ? <ChevronRight aria-hidden="true" className={expanded ? 'rotate-90' : undefined} size={13} /> : null}
      </button>
      {trailing}
    </div>
    {expanded ? <div className="app-turn-progress-details" data-transcript-stable-disclosure-body="true">
      {thinkingText ? <MarkdownContent text={thinkingText} tone="muted" className="app-transcript-thinking-markdown" /> : null}
      {tools.map(renderTool)}
      {unavailable > 0 ? <p className="text-xs">Details unavailable for {unavailable} earlier {unavailable === 1 ? 'tool' : 'tools'}.</p> : null}
    </div> : null}
  </section>;
}

/** One compact header stays in place through completion; plain replies need no progress section. */
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
  const hasActivity = groups.some(group => group.kind === 'tools') || groups.length > 1;
  const elapsed = elapsedLabel(turn, now);
  const standaloneReasoning = !hasActivity && turn.tools.length === 0;
  const reasoningLabel = !live && standaloneReasoning ? turn.succeeded && !elapsed ? 'Finished' : turnProgressLabel(turn) : 'Reasoning';
  const [trajectoryExpanded, setTrajectoryExpanded] = useState(true);
  const legacyHasActivity = turn.tools.length > 0 || Boolean(turn.thinkingText);
  if (!ordered) return <>
    {legacyHasActivity || (live && !legacyAnswer) ? <ActivityGroup tools={turn.tools} thinkingText={turn.tools.length ? undefined : turn.thinkingText}
      label={!turn.tools.length && turn.thinkingText ? reasoningLabel : live ? turnProgressLabel(turn) : elapsed ? turnProgressLabel(turn) : settledProgressLabel(turn.tools)}
      active={live} hideIcon={!live && standaloneReasoning} elapsed={elapsed} trailing={live ? trailing : undefined} renderTool={renderTool} /> : null}
    {turn.tools.length > 0 && turn.thinkingText ? <ActivityGroup tools={[]} label="Reasoning" thinkingText={turn.thinkingText} renderTool={renderTool} /> : null}
    {legacyAnswer}
  </>;
  const statusLabel = turnProgressLabel(turn);
  return <div className="app-ordered-progress" data-transcript-stable-disclosure-root="true">
    {hasActivity ? <div className="app-turn-progress-line app-turn-header-line">
      <button type="button" className="app-turn-worked-header" aria-expanded={trajectoryExpanded}
        aria-label={`${statusLabel}${elapsed ? ` ${elapsed}` : ''}`}
        data-transcript-stable-disclosure="true" onClick={() => setTrajectoryExpanded(value => !value)}>
        {live ? <ProgressBird /> : null}
        <span role={live ? 'status' : undefined} className="app-turn-status-label" title={statusLabel}><span key={statusLabel} className="app-turn-status-text">{statusLabel}</span></span>{elapsed ? <span className="app-turn-progress-time" aria-hidden="true">{elapsed}</span> : null}
        <ChevronRight size={13} aria-hidden="true" className={trajectoryExpanded ? 'rotate-90' : undefined} />
      </button>
      {live ? trailing : null}
    </div> : null}
    {turn.thinkingText ? <div hidden={hasActivity && !trajectoryExpanded}><ActivityGroup tools={[]} label={reasoningLabel} thinkingText={turn.thinkingText}
      active={standaloneReasoning && live} hideIcon={standaloneReasoning && !live} elapsed={standaloneReasoning ? elapsed : null}
      renderTool={renderTool} trailing={!hasActivity && live ? trailing : null} /></div> : !hasActivity && live ? trailing : null}
    <div className="app-turn-trajectory" data-transcript-stable-disclosure-body="true">
      {groups.map(group => <div key={group.id} hidden={hasActivity && !trajectoryExpanded && (group !== last || group.kind !== 'text')}>
        {group.kind === 'text' ? <div className="app-turn-commentary"><MarkdownContent text={group.text} /></div>
          : <ActivityGroup tools={group.tools} unavailable={group.unavailable}
              label={live && group.tools.some(progressToolIsActive) ? `${group.tools.length + group.unavailable} ${group.tools.length + group.unavailable === 1 ? 'tool' : 'tools'}` : settledProgressLabel(group.tools, group.unavailable)}
              renderTool={renderTool} />}
      </div>)}
    </div>
  </div>;
}
