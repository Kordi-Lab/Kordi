import { useEffect, useState, type ReactNode } from 'react';
import { Brain, ChevronRight, Wrench } from 'lucide-react';
import type { DesktopChatTurnSnapshot, DesktopChatToolSnapshot } from '../types';
import { groupTurnSegments } from '@/features/chat/turnSegments';
import { elapsedLabel, turnProgressLabel, settledProgressLabel, progressToolIsActive } from './turnProgressLabels';
import { toolActivityMetadata } from './toolActivityMetadata';
import { MarkdownContent } from './markdown';
import { ProgressBird } from './ProgressBird';
import { ProgressDisclosure } from './ProgressDisclosure';

function ActivityGroup({ tools, unavailable = 0, label, renderTool, thinkingText }: {
  tools: DesktopChatToolSnapshot[]; unavailable?: number; label: string;
  renderTool: (tool: DesktopChatToolSnapshot) => ReactNode; thinkingText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = tools[0] ? toolActivityMetadata(tools[0]).Icon : thinkingText ? Brain : Wrench;
  const expandable = tools.length > 0 || unavailable > 0 || Boolean(thinkingText);
  return <section className={`app-turn-progress${thinkingText ? ' app-turn-reasoning' : ''}`} data-transcript-stable-disclosure-root="true" data-transcript-stable-disclosure-direction="down">
    <div className="app-turn-progress-line">
      <button type="button" className="app-turn-progress-summary" aria-label={label} aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable} data-transcript-stable-disclosure="true" onClick={() => setExpanded(value => !value)}>
        <Icon size={14} aria-hidden="true" />
        <span>{label}</span>
        {expandable ? <ChevronRight aria-hidden="true" className={expanded ? 'rotate-90' : undefined} size={13} /> : null}
      </button>
    </div>
    <ProgressDisclosure expanded={expanded}><div className="app-turn-progress-details">
      {thinkingText ? <MarkdownContent text={thinkingText} tone="muted" className="app-transcript-thinking-markdown" /> : null}
      {tools.map(renderTool)}
      {unavailable > 0 ? <p className="text-xs">Details unavailable for {unavailable} earlier {unavailable === 1 ? 'tool' : 'tools'}.</p> : null}
    </div></ProgressDisclosure>
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
  const [trajectoryExpanded, setTrajectoryExpanded] = useState(false);
  const hasTrace = hasActivity || turn.tools.length > 0 || Boolean(turn.thinkingText);
  const showHeader = hasTrace || (live && (ordered || !legacyAnswer));
  const expandable = hasTrace || (live && ordered);
  const progressLabel = turnProgressLabel(turn);
  const statusLabel = live && standaloneReasoning && turn.thinkingText && ['Working', 'Thinking'].includes(progressLabel) ? 'Reasoning' : progressLabel;
  return <div className="app-ordered-progress" data-transcript-stable-disclosure-root="true" data-transcript-stable-disclosure-direction="down">
    {showHeader ? <div className="app-turn-progress-line app-turn-header-line">
      <button type="button" className="app-turn-worked-header" aria-expanded={expandable ? trajectoryExpanded : undefined}
        aria-label={`${statusLabel}${elapsed ? ` ${elapsed}` : ''}`} disabled={!expandable}
        data-transcript-stable-disclosure="true" onClick={() => setTrajectoryExpanded(value => !value)}>
        {live ? <ProgressBird /> : null}
        <span role={live ? 'status' : undefined} className={live ? 'app-turn-status-label' : undefined} title={statusLabel}><span key={statusLabel} className="app-turn-status-text">{statusLabel}</span></span>{elapsed ? <span className="app-turn-progress-time" aria-hidden="true">{elapsed}</span> : null}
        {expandable ? <ChevronRight size={13} aria-hidden="true" className={trajectoryExpanded ? 'rotate-90' : undefined} /> : null}
      </button>
      {live ? trailing : null}
    </div> : null}
    <ProgressDisclosure expanded={showHeader && trajectoryExpanded}>
      {ordered && hasActivity ? <>
        {turn.thinkingText ? <ActivityGroup tools={[]} label="Reasoning" thinkingText={turn.thinkingText} renderTool={renderTool} /> : null}
        <div className="app-turn-trajectory">
          {groups.filter(group => live || group !== last || group.kind !== 'text').map(group => <div key={group.id}>
            {group.kind === 'text' ? <div className="app-turn-commentary"><MarkdownContent text={group.text} /></div>
              : <ActivityGroup tools={group.tools} unavailable={group.unavailable}
                  label={live && group.tools.some(progressToolIsActive) ? `${group.tools.length + group.unavailable} ${group.tools.length + group.unavailable === 1 ? 'tool' : 'tools'}` : settledProgressLabel(group.tools, group.unavailable)}
                  renderTool={renderTool} />}
          </div>)}
        </div>
      </> : <div className="app-turn-progress">
        {turn.thinkingText ? <div className="app-turn-reasoning"><div className="app-turn-progress-details"><MarkdownContent text={turn.thinkingText} tone="muted" className="app-transcript-thinking-markdown" /></div></div> : null}
        {turn.tools.map(renderTool)}
        {live && ordered ? groups.map(group => group.kind === 'text' ? <div key={group.id} className="app-turn-commentary"><MarkdownContent text={group.text} /></div> : null) : null}
      </div>}
    </ProgressDisclosure>
    {!live && last?.kind === 'text' ? <div className="app-turn-commentary"><MarkdownContent text={last.text} /></div> : null}
    {!ordered ? legacyAnswer : null}
  </div>;
}
