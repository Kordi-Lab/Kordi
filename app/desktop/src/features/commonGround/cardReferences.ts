// The references behind a card's topics, the sources they came from, and Now and the timeline.

import { Brain, Calendar, FileText, Link, Mail, MessageSquare, StickyNote } from 'lucide-react';

import { CG_TOPIC_SECTIONS, type CgEvidence, type CgOwnCard } from './types';
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

/** One reference under a topic: its id in the card's evidence, and the item. */
export type CardRef = { id: string; item: CgEvidence };

/** The references behind a topic, newest first. */
export function topicRefs(card: CgOwnCard, topic: string): CardRef[] {
  const info = card.profile?.topics?.[topic];
  const evidence = card.profile?.evidence ?? {};
  return (info?.refs ?? []).flatMap((id) => (evidence[id] ? [{ id, item: evidence[id] }] : []));
}

/** The topics on the card, in the order the page lists them. */
export function cardTopics(card: CgOwnCard): string[] {
  return CG_TOPIC_SECTIONS.flatMap(([key]) => card[key]);
}

/** For each cited item, the first topic on the page that cites it; later topics link back to it. */
export function firstCiters(card: CgOwnCard): Map<string, string> {
  const owners = new Map<string, string>();
  for (const topic of cardTopics(card)) {
    for (const { id } of topicRefs(card, topic)) if (!owners.has(id)) owners.set(id, topic);
  }
  return owners;
}

/** Notes are the default source; their rows carry no glyph and no title. */
export function isNotesSource(source: string): boolean {
  return /^\s*(your\s+)?notes?\s*$/i.test(source);
}

/** The small line under a quote: the title when it says something, the source, the day. */
export function refMeta(item: CgEvidence): { title: string; rest: string } {
  const title = item.title.trim();
  const showTitle = Boolean(title) && Boolean(item.snippet.trim()) && (Boolean(item.url) || !isNotesSource(item.source));
  return { title: showTitle ? title : '', rest: [item.source, shortDay(item.date)].filter(Boolean).join(' · ') };
}

/** Snippets longer than this get "Show more" under their two lines. */
export const QUOTE_FOLD_CHARS = 140;

/** A DOM id for a topic or a reference on the card page. */
export function cardAnchor(kind: 'topic' | 'ref', key: string): string {
  let hash = 5381;
  for (const char of key) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return `cg-${kind}-${hash.toString(36)}`;
}

/** Scrolls a topic or reference into view and highlights it briefly. */
export function jumpTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  target.classList.remove('is-flash');
  void target.offsetWidth; // Restarts the highlight when the same row is picked twice.
  target.classList.add('is-flash');
  target.addEventListener('animationend', () => target.classList.remove('is-flash'), { once: true });
}

/** One row of the timeline; `muted` when every topic in it is in the past. */
export type TimelineRow = { period: string; topics: string[]; muted: boolean };

/**
 * Now and the timeline, as the iPhone shows them: periods newest first, each topic once in the
 * period it first appeared, then the past topics no period holds under "Earlier".
 */
export function cardTimeline(card: CgOwnCard): { now: string[]; rows: TimelineRow[]; earlier: Set<string> } {
  const profile = card.profile ?? {};
  const earlier = new Set(profile.earlier ?? []);
  const now = [...new Set(profile.latest ?? [])];
  const periods = profile.timeline ?? [];
  const placed = new Set<string>();
  // Walk oldest first so a topic listed twice stays where it first came up.
  const kept = [...periods].reverse().map(({ period, topics }) => ({
    period,
    topics: topics.filter((topic) => {
      if (placed.has(topic)) return false;
      placed.add(topic);
      return true;
    }),
  })).reverse();
  const rows: TimelineRow[] = kept
    .filter((row) => row.topics.length)
    .map((row) => ({ ...row, muted: row.topics.every((topic) => earlier.has(topic)) }));
  const rest = [...earlier].filter((topic) => !placed.has(topic));
  if (rest.length) rows.push({ period: 'Earlier', topics: rest, muted: true });
  return { now, rows, earlier };
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
