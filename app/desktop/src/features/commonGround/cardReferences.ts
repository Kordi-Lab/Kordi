// The references behind a card's topics, and the sources they came from.

import { Brain, Calendar, FileText, Link, Mail, MessageSquare, StickyNote } from 'lucide-react';

import type { CgEvidence, CgOwnCard } from './types';
import { shortDay } from './wallet';

const SOURCE_ICONS: Array<[RegExp, typeof Mail, string]> = [
  [/mail/i, Mail, '#2563eb'],
  [/calendar|event|reminder/i, Calendar, '#e5484d'],
  [/memor|agent/i, Brain, '#847ac4'],
  [/paper|pdf|doc|drive/i, FileText, '#e8590c'],
  [/slack|chat|message/i, MessageSquare, '#27b9d1'],
  [/link|web|github/i, Link, '#4b5563'],
];

/** A source's icon and tint, by its name. */
export function sourceLook(source: string): { Icon: typeof Mail; tint: string } {
  const found = SOURCE_ICONS.find(([pattern]) => pattern.test(source));
  return found ? { Icon: found[1], tint: found[2] } : { Icon: StickyNote, tint: '#d9a00b' };
}

/** The references behind a topic, newest first. */
export function topicRefs(card: CgOwnCard, topic: string): CgEvidence[] {
  const info = card.profile?.topics?.[topic];
  const evidence = card.profile?.evidence ?? {};
  return (info?.refs ?? []).map((id) => evidence[id]).filter((item): item is CgEvidence => Boolean(item));
}

/** "First seen 3 Oct · Last seen 12 Oct", or "Seen 6 Oct". */
export function seenLine(card: CgOwnCard, topic: string): string {
  const info = card.profile?.topics?.[topic];
  const first = shortDay(info?.firstSeen);
  const last = shortDay(info?.lastSeen);
  if (!first && !last) return '';
  return first === last || !last ? `Seen ${first || last}` : `First seen ${first} · Last seen ${last}`;
}

/** The sources behind the card's references, with how many each gave. */
export function cardSources(card: CgOwnCard): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of Object.values(card.profile?.evidence ?? {})) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  return [...counts.entries()].map(([source, count]) => ({ source, count }));
}
