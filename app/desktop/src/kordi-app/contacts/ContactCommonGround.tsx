import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { CardGlyph } from '@/features/commonGround/ProfileCard';
import type { CloudContactProfile } from '@/features/cloud/contactProfileClient';
import { cn } from '@/lib/utils';
import type { ContactMatch, ContactMatchCard } from './contactMatch';
import { SectionLabel } from './ContactProfileCards';

type CommonGround = NonNullable<CloudContactProfile['commonGround']>;
type Variant = 'pane' | 'compact';
type Chip = { key: string; label: string; title: string };

const OWN_ROWS: { key: 'workingOn' | 'canHelp' | 'lookingFor'; label: string }[] = [
  { key: 'workingOn', label: 'Working on' },
  { key: 'canHelp', label: 'Can help' },
  { key: 'lookingFor', label: 'Looking for' },
];

function Chips({ chips }: { chips: Chip[] }) {
  return (
    <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span key={chip.key} className="app-contacts-chip rounded-full px-2.5 py-1 text-[12px] leading-4" title={chip.title}>{chip.label}</span>
      ))}
    </span>
  );
}

/** Their own topics, one labelled row each, as the card showed before matches. */
function OwnTopics({ card }: { card: CommonGround }) {
  return OWN_ROWS.filter((row) => card[row.key].length > 0).map((row) => (
    <div key={row.key} className="flex items-start gap-2.5">
      <span className="app-contacts-muted app-contacts-match-muted w-[86px] shrink-0 text-[12px] leading-6">{row.label}</span>
      <Chips chips={card[row.key].map((topic) => ({ key: topic, label: topic, title: topic }))} />
    </div>
  ));
}

function CardChip({ card }: { card: ContactMatchCard }) {
  return (
    <span className="app-contacts-chip inline-flex min-w-0 shrink items-center gap-1.5 rounded-full py-1 pl-1.5 pr-2.5 text-[12px] leading-4" title={card.name}>
      <span className="app-contacts-match-swatch grid h-3.5 w-5 shrink-0 place-items-center rounded-[3px]" data-design={card.design} aria-hidden="true">
        <CardGlyph design={card.design} icon={card.icon} kind={card.kind} className="h-2.5 w-2.5" />
      </span>
      <span className="min-w-0 truncate">{card.name}</span>
    </span>
  );
}

function MatchRow({ label, chips }: { label: string; chips: Chip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="app-contacts-muted app-contacts-match-muted text-[12px] leading-4">{label}</span>
      <Chips chips={chips} />
    </div>
  );
}

function MatchBody({ match }: { match: ContactMatch }) {
  const trades = (items: ContactMatch['youBring']) => items.map((item, index) => ({ key: `${index}:${item.topic}`, label: item.topic, title: item.topic }));
  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="flex shrink-0 items-baseline gap-1" title={match.headline ?? undefined}>
          <span className="app-contacts-match-score text-[28px] font-semibold leading-8 tabular-nums">{match.score}</span>
          <span className="app-contacts-muted app-contacts-match-muted text-[11px] leading-4">% match</span>
        </span>
        {match.theirProfile ? <CardChip card={match.theirProfile} /> : null}
      </div>
      <MatchRow
        label="You both"
        chips={match.shared.map((item, index) => ({
          key: `${index}:${item.topic}`,
          label: item.topic,
          title: item.theirTopic ? `${item.topic} · ${item.theirTopic}` : item.topic,
        }))}
      />
      <MatchRow label="They can help with" chips={trades(match.theyBring)} />
      <MatchRow label="You can help with" chips={trades(match.youBring)} />
      {match.nextStep ? <p className="app-contacts-muted app-contacts-match-muted text-[12px] leading-[17px]">{match.nextStep}</p> : null}
    </>
  );
}

function TheirCard({ card }: { card: CommonGround }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="app-contacts-match-divider flex flex-col gap-2.5 pt-2">
      <button
        type="button"
        className="app-contacts-muted app-contacts-match-disclosure -mx-1 flex items-center gap-1 rounded-[6px] px-1 text-left text-[12px] leading-6"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        Their card
      </button>
      {open ? <OwnTopics card={card} /> : null}
    </div>
  );
}

/**
 * Common ground with a contact: the match score, shared topics, what each can bring and the next
 * step, with their own card's topics folded below. Without a match, their topics only.
 * `compact` is the chat person popover's version.
 */
export function CommonGroundCard({ card, variant = 'pane' }: { card: CommonGround; variant?: Variant }) {
  const hasOwn = OWN_ROWS.some((row) => card[row.key].length > 0);
  const body = (
    <div
      className={cn(
        'app-contacts-match flex flex-col',
        variant === 'pane' ? 'app-contacts-card gap-2.5 rounded-[12px] px-4 pb-3.5 pt-3' : 'is-compact app-contact-profile-summary gap-2 rounded-[14px] px-3 pb-2.5 pt-2',
      )}
      aria-label={variant === 'compact' ? 'Common ground' : undefined}
      role={variant === 'compact' ? 'group' : undefined}
    >
      {card.match ? <MatchBody match={card.match} /> : null}
      {card.match && hasOwn ? <TheirCard card={card} /> : null}
      {card.match ? null : <OwnTopics card={card} />}
    </div>
  );
  if (variant === 'compact') return body;
  return (
    <>
      <SectionLabel>Common ground</SectionLabel>
      {body}
    </>
  );
}

export type ContactProfileLoader = (accountId: string, signal: AbortSignal) => Promise<CloudContactProfile>;

/** Loads a person's profile for the chat popover and shows its common ground; quiet while loading or on failure. */
export function ContactCommonGroundLoader({ accountId, load }: { accountId: string; load: ContactProfileLoader }) {
  const [settled, setSettled] = useState<{ accountId: string; card: CommonGround | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    load(accountId, controller.signal).then(
      (profile) => { if (!controller.signal.aborted) setSettled({ accountId, card: profile.commonGround }); },
      () => { if (!controller.signal.aborted) setSettled({ accountId, card: null }); },
    );
    return () => controller.abort();
  }, [accountId, load]);
  const card = settled?.accountId === accountId ? settled.card : null;
  return card ? <div className="mb-2"><CommonGroundCard card={card} variant="compact" /></div> : null;
}
