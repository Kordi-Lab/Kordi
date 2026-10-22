import { useState } from 'react';
import { ArrowUpRight, Eye, EyeOff, Plus, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { openExternalMessageLink, safeExternalHttpHref } from '@/kordi-app/components/messageLinks';
import { topicTone } from './format';
import { cardAnchor, isNotesSource, jumpTo, QUOTE_FOLD_CHARS, refMeta, seenLine, sourceLook, topicRefs, type CardRef } from './cardReferences';
import { CgTag } from './parts';
import type { CgOwnCard } from './types';

export const TOPIC_MAX_CHARS = 40;

/** One reference: its own words first, then where and when it came from. */
function RefRow({ id, item }: CardRef) {
  const [open, setOpen] = useState(false);
  const words = item.snippet.trim() || item.title.trim();
  const { title, rest } = refMeta(item);
  const href = item.url ? safeExternalHttpHref(item.url) : null;
  const { Icon } = sourceLook(item.source);
  const folds = words.length > QUOTE_FOLD_CHARS;
  return (
    <div className="cg-ref" id={cardAnchor('ref', id)}>
      <q className={cn('cg-ref-quote', folds && !open && 'is-folded')}>{words}</q>
      {folds ? (
        <button type="button" className="cg-ref-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      <span className="cg-ref-meta">
        {isNotesSource(item.source) ? null : <Icon className="cg-ref-glyph" aria-hidden="true" />}
        {href ? (
          <a className="cg-ref-link" href={href} title={href} target="_blank" rel="noreferrer noopener" onClick={(event) => openExternalMessageLink(event, href)}>
            {title || item.title || item.source}
            <ArrowUpRight className="cg-ref-arrow" aria-hidden="true" />
          </a>
        ) : title ? <span className="cg-ref-title">{title}</span> : null}
        {(href || title) && rest ? <span aria-hidden="true">·</span> : null}
        <span>{rest}</span>
      </span>
    </div>
  );
}

/** One topic: its tag, when it was seen, Hide and Remove on hover, then its references. */
export function CardLine({ card, topic, owners, onHide, onRemove }: {
  card: CgOwnCard;
  topic: string;
  /** For each cited item, the first topic on the page that shows it in full. */
  owners: Map<string, string>;
  onHide: () => void;
  onRemove: () => void;
}) {
  const hidden = card.hidden.includes(topic);
  const refs = topicRefs(card, topic);
  const seen = seenLine(card, topic);
  return (
    <div className={cn('cg-line', hidden && 'is-off')} id={cardAnchor('topic', topic)}>
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
          {refs.map((ref) => {
            const first = owners.get(ref.id) ?? topic;
            if (first === topic) return <RefRow key={ref.id} {...ref} />;
            return (
              <button key={ref.id} type="button" className="cg-ref-same" onClick={() => jumpTo(cardAnchor('ref', ref.id))}>
                Same {isNotesSource(ref.item.source) ? 'note' : 'reference'} as {first}
              </button>
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
