import { cn } from '@/lib/utils';
import { cardAnchor, jumpTo, type TimelineRow } from './cardReferences';
import { CgTag } from './parts';

/** A topic chip; on the card it opens the topic's references, otherwise it only reads. */
function TopicChip({ topic, onCard, muted }: { topic: string; onCard: boolean; muted: boolean }) {
  const tag = <CgTag topic={topic} muted={muted} small />;
  if (!onCard) return <span className="cg-chip">{tag}</span>;
  return (
    <button type="button" className="cg-chip is-link" aria-label={`Go to ${topic}`} onClick={() => jumpTo(cardAnchor('topic', topic))}>
      {tag}
    </button>
  );
}

/** Now: the topics active lately, as chips. */
export function CardNow({ topics, onCard }: { topics: string[]; onCard: Set<string> }) {
  if (!topics.length) return null;
  return (
    <section>
      <h3 className="cg-msec">Now</h3>
      <div className="cg-chips">
        {topics.map((topic) => <TopicChip key={topic} topic={topic} onCard={onCard.has(topic)} muted={false} />)}
      </div>
    </section>
  );
}

/** Timeline: periods newest first on a dotted rail, past topics muted at the end. */
export function CardTimeline({ rows, earlier, onCard }: { rows: TimelineRow[]; earlier: Set<string>; onCard: Set<string> }) {
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="cg-msec">Timeline</h3>
      <ol className={cn('cg-panel cg-timeline', rows.length === 1 && 'is-single')}>
        {rows.map((row) => (
          <li key={row.period} className={cn('cg-tl-row', row.muted && 'is-muted')}>
            <span className="cg-tl-period">{row.period}</span>
            <span className="cg-tl-dot" aria-hidden="true" />
            <span className="cg-chips">
              {row.topics.map((topic) => <TopicChip key={topic} topic={topic} onCard={onCard.has(topic)} muted={earlier.has(topic)} />)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
