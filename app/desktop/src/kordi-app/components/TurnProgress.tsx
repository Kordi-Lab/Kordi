import { useEffect, useState, type ReactNode } from 'react';
import { Brain, ChevronRight, Wrench } from 'lucide-react';
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
  const Icon = tools[0] ? toolActivityMetadata(tools[0]).Icon : thinkingText ? Brain : Wrench;
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
      {thinkingText ? tools.length || unavailable ? <details><summary>Reasoning</summary><MarkdownContent text={thinkingText} tone="muted" className="app-transcript-thinking-markdown" /></details>
        : <MarkdownContent text={thinkingText} tone="muted" className="app-transcript-thinking-markdown" /> : null}
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
  const [trajectoryExpanded, setTrajectoryExpanded] = useState(true);
  const legacyHasActivity = turn.tools.length > 0 || Boolean(turn.thinkingText);
  if (!ordered) return <>
    {legacyHasActivity || (live && !legacyAnswer) ? <ActivityGroup tools={turn.tools} thinkingText={turn.thinkingText}
      label={!turn.tools.length && turn.thinkingText ? 'Reasoning' : live ? turnProgressLabel(turn) : elapsed ? turnProgressLabel(turn) : settledProgressLabel(turn.tools)}
      active={live} elapsed={elapsed} trailing={live ? trailing : undefined} renderTool={renderTool} /> : null}
    {legacyAnswer}
  </>;
  const statusLabel = live && ['preparing', 'streaming', 'processing', 'thinking', 'writing', 'tooling', 'running', 'starting'].includes(turn.status) && turn.tools.some(tool => !tool.isError && ['running', 'pending'].includes(tool.status))
    ? 'Working' : turnProgressLabel(turn);
  return <div className="app-ordered-progress" data-transcript-stable-disclosure-root="true">
    {hasActivity ? <div className="app-turn-progress-line app-turn-header-line">
      <button type="button" className="app-turn-worked-header" aria-expanded={trajectoryExpanded}
        aria-label={`${statusLabel}${elapsed ? ` ${elapsed}` : ''}`}
        data-transcript-stable-disclosure="true" onClick={() => setTrajectoryExpanded(value => !value)}>
        {live ? <span className="app-turn-progress-dots" aria-hidden="true"><i /><i /><i /></span> : null}
        <span role={live ? 'status' : undefined}>{statusLabel}</span>{elapsed ? <span aria-hidden="true">{elapsed}</span> : null}
        <ChevronRight size={13} aria-hidden="true" className={trajectoryExpanded ? 'rotate-90' : undefined} />
      </button>
      {live ? trailing : null}
    </div> : null}
    {!hasActivity && turn.thinkingText ? <ActivityGroup tools={[]} label="Reasoning" thinkingText={turn.thinkingText} renderTool={renderTool} trailing={live ? trailing : null} /> : !hasActivity && live ? trailing : null}
    <div className="app-turn-trajectory" data-transcript-stable-disclosure-body="true">
      {groups.map(group => <div key={group.id} hidden={hasActivity && !trajectoryExpanded && (group !== last || group.kind !== 'text')}>
        {group.kind === 'text' ? <div className="app-turn-commentary"><MarkdownContent text={group.text} /></div>
          : <ActivityGroup tools={group.tools} unavailable={group.unavailable}
              label={live && group === last ? turnProgressLabel(turn) : settledProgressLabel(group.tools, group.unavailable)}
              thinkingText={group === last ? turn.thinkingText : undefined} renderTool={renderTool} />}
      </div>)}
      {hasActivity && trajectoryExpanded && last?.kind !== 'tools' && turn.thinkingText ? <ActivityGroup tools={[]}
        label="Reasoning" thinkingText={turn.thinkingText} renderTool={renderTool} /> : null}
    </div>
  </div>;
}
