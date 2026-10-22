import { useState } from 'react';
import { Eye, EyeOff, Plus, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { topicTone } from './format';
import { seenLine, sourceLook, topicRefs } from './cardReferences';
import { CgTag } from './parts';
import type { CgOwnCard } from './types';
import { shortDay } from './wallet';

export const TOPIC_MAX_CHARS = 40;

/** One topic: its tag, when it was seen, Hide and Remove on hover, then its references. */
export function CardLine({ card, topic, onHide, onRemove }: {
  card: CgOwnCard;
  topic: string;
  onHide: () => void;
  onRemove: () => void;
}) {
  const hidden = card.hidden.includes(topic);
  const refs = topicRefs(card, topic);
  const seen = seenLine(card, topic);
  return (
    <div className={cn('cg-line', hidden && 'is-off')}>
      <div className="cg-line-head">
        <CgTag topic={topic} muted={hidden} small />
        {seen ? <span className="cg-line-seen">{seen}</span> : <span className="cg-line-seen" />}
        <button type="button" className="cg-line-act" aria-pressed={hidden} aria-label={hidden ? `Show ${topic}` : `Hide ${topic}`} onClick={onHide}>
          {hidden ? <Eye className="h-[13px] w-[13px]" aria-hidden="true" /> : <EyeOff className="h-[13px] w-[13px]" aria-hidden="true" />}
          {hidden ? 'Show' : 'Hide'}
        </button>
        <button type="button" className="cg-line-act is-icon" aria-label={`Remove ${topic}`} onClick={onRemove}>
          <X className="h-[13px] w-[13px]" aria-hidden="true" />
        </button>
      </div>
      {refs.length ? (
        <div className="cg-line-refs">
          {refs.map((ref, index) => {
            const { Icon, tint } = sourceLook(ref.source);
            return (
              <div key={`${ref.title}:${index}`} className="cg-ref">
                <span className="cg-ref-icon" style={{ '--cg-src': tint } as React.CSSProperties}><Icon className="h-[14px] w-[14px]" aria-hidden="true" /></span>
                <span className="cg-ref-body">
                  <span className="cg-ref-title">{ref.title}</span>
                  <span className="cg-ref-snip">{[ref.source, ref.snippet].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="cg-ref-date">{shortDay(ref.date)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** "+ Add" at the end of a section: type a topic, Enter adds it. */
export function AddTopic({ onAdd }: { onAdd: (topic: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (!editing) {
    return (
      <button type="button" className="cg-line-add" onClick={() => setEditing(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add
      </button>
    );
  }
  const commit = () => {
    const topic = text.replace(/\s+/g, ' ').trim();
    setEditing(false);
    setText('');
    if (topic) onAdd(topic);
  };
  return (
    <span className={cn('cg-line-add is-editing', `tone-${topicTone(text || 'x')}`)}>
      <input
        autoFocus
        value={text}
        maxLength={TOPIC_MAX_CHARS}
        placeholder="New topic"
        aria-label="New topic"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            event.stopPropagation();
            setEditing(false);
            setText('');
          }
        }}
      />
      {text.length >= TOPIC_MAX_CHARS - 10 ? <span className="cg-count">{text.length}/{TOPIC_MAX_CHARS}</span> : null}
    </span>
  );
}
