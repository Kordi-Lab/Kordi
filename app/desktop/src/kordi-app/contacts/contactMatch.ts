// The Grounding match on a contact profile (`commonGround.match`): a score, the topics the two
// people share, what each can bring the other, and the two cards it compares. Lives outside
// features/cloud so the cloud chunk only carries the call.

import { isCardDesign, isCardIcon, profileDesign, type CgCardDesign, type CgCardIcon } from '@/features/commonGround/cardDesign';
import { kindLabel } from '@/features/commonGround/profiles';
import type { CgProfileKind } from '@/features/commonGround/types';

export type ContactMatchTopic = { topic: string; theirTopic: string | null; why: string | null };
export type ContactMatchTrade = { topic: string; for: string | null; why: string | null };
export type ContactMatchCard = { profileId: string | null; kind: CgProfileKind; name: string; design: CgCardDesign; icon: CgCardIcon | null };

export type ContactMatch = {
  /** 0 to 100. */
  score: number;
  headline: string | null;
  shared: ContactMatchTopic[];
  youBring: ContactMatchTrade[];
  theyBring: ContactMatchTrade[];
  nextStep: string | null;
  yourProfile: ContactMatchCard | null;
  theirProfile: ContactMatchCard | null;
  updatedAt: string | null;
};

const KINDS: readonly CgProfileKind[] = ['work', 'health', 'daily', 'custom'];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rows<T>(value: unknown, limit: number, read: (row: Record<string, unknown>, topic: string) => T): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    const topic = text(row?.topic);
    return row && topic ? [read(row, topic)] : [];
  }).slice(0, limit);
}

function card(value: unknown): ContactMatchCard | null {
  const row = record(value);
  if (!row) return null;
  const kind = KINDS.find((item) => item === row.kind) ?? 'custom';
  const name = text(row.name) ?? kindLabel(kind);
  const design = isCardDesign(row.design) ? row.design : profileDesign({ kind, name, design: null });
  return { profileId: text(row.profileId), kind, name, design, icon: isCardIcon(row.icon) ? row.icon : null };
}

const trade = (row: Record<string, unknown>, topic: string): ContactMatchTrade => ({ topic, for: text(row.for), why: text(row.why) });

/** Reads `commonGround.match`; anything without a numeric score is no match. */
export function normalizeContactMatch(value: unknown): ContactMatch | null {
  const row = record(value);
  const score = row?.score;
  if (!row || typeof score !== 'number' || !Number.isFinite(score)) return null;
  return {
    score: Math.round(Math.min(100, Math.max(0, score))),
    headline: text(row.headline),
    shared: rows(row.shared, 5, (item, topic) => {
      const theirTopic = text(item.theirTopic);
      return { topic, theirTopic: theirTopic && theirTopic !== topic ? theirTopic : null, why: text(item.why) };
    }),
    youBring: rows(row.youBring, 3, trade),
    theyBring: rows(row.theyBring, 3, trade),
    nextStep: text(row.nextStep),
    yourProfile: card(row.yourProfile),
    theirProfile: card(row.theirProfile),
    updatedAt: text(row.updatedAt),
  };
}
