import { useId, type ReactNode } from 'react';
import { Briefcase, Landmark, Leaf, ListChecks, Medal, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { isColourDesign, type CgCardDesign, type CgCardIcon } from './cardDesign';
import { CARD_ICONS } from './cardLook';
import { topicCount } from './format';
import type { CgProfileKind } from './types';

const GLYPHS = { work: Briefcase, health: Leaf, daily: ListChecks, workshop: Medal, research: Landmark, custom: Sparkles } as const;

/**
 * The card's icon, or without one the design's own glyph; a colour background draws its kind's
 * glyph. Drawn in the card's accent.
 */
export function CardGlyph({ design, icon, kind, className }: { design: CgCardDesign; icon?: CgCardIcon | null; kind?: CgProfileKind; className?: string }) {
  const Icon = icon ? CARD_ICONS[icon] : GLYPHS[isColourDesign(design) ? kind ?? 'custom' : design];
  return <Icon className={className} aria-hidden="true" />;
}

/** The small Kordi bird in the card's corner, cut out like the app mark. */
export function CardBird() {
  const mask = `cg-bird-${useId().replace(/:/g, '')}`;
  return (
    <svg className="cg-card-bird" viewBox="64 58 384 384" aria-hidden="true" focusable="false">
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="-100" y="-100" width="712" height="712">
          <ellipse cx="262" cy="292" rx="150" ry="136" fill="#fff" />
          <path d="M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z" fill="#fff" stroke="#fff" strokeWidth="4" strokeLinejoin="round" />
          <circle cx="194" cy="266" r="17" />
          <path d="M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z" />
        </mask>
      </defs>
      <g transform="translate(256,250) scale(0.94) translate(-270,-292)">
        <path d="M120,276 L82,294 L120,312Z" fill="#f7b32b" stroke="#f7b32b" strokeWidth="12" strokeLinejoin="round" />
        <rect x="-100" y="-100" width="712" height="712" fill="currentColor" mask={`url(#${mask})`} />
      </g>
    </svg>
  );
}

/** A small flat swatch of a card's design, for rows, chips and pickers. */
export function CardSwatch({ design, className, empty = false }: { design: CgCardDesign; className?: string; empty?: boolean }) {
  return <span className={cn('cg-swatch', empty && 'is-empty', className)} data-design={design} aria-hidden="true" />;
}

export type CgCardStatus = 'built' | 'empty' | 'building' | 'suggested';

export type CgCardFace = {
  design: CgCardDesign;
  icon?: CgCardIcon | null;
  /** The profile's kind, for a colour background's default glyph. */
  kind?: CgProfileKind;
  name: string;
  focus: string | null;
  topicCount: number;
  status: CgCardStatus;
};

function footLine(face: CgCardFace): ReactNode {
  if (face.status === 'building') return <><i className="cg-spin" aria-hidden="true" />Building</>;
  if (face.status === 'suggested') return 'Suggested';
  if (face.status === 'empty') return 'Not built';
  return topicCount(face.topicCount);
}

/** The rail tile (176×110): glyph, name, focus, topic count and the bird. */
export function ProfileCardTile({ face, trailing }: { face: CgCardFace; trailing?: ReactNode }) {
  return (
    <>
      <span className="cg-tile-head">
        <span className="cg-card-glyph"><CardGlyph design={face.design} icon={face.icon} kind={face.kind} /></span>
        <span className="cg-tile-name">{face.name}</span>
        {trailing}
      </span>
      <span className="cg-tile-focus">{face.focus ?? ''}</span>
      <span className="cg-tile-foot">
        <span>{footLine(face)}</span>
        <CardBird />
      </span>
    </>
  );
}

export type CgCardEdit = {
  namePlaceholder: string;
  disabled: boolean;
  onName: (value: string) => void;
  onFocus: (value: string) => void;
  nameMax: number;
  focusMax: number;
};

/**
 * The large card (372×235) for dialogs; with `edit`, the name and focus are typed into it, and
 * `glyph` replaces the icon square (New card makes it a button that picks the look).
 */
export function ProfileCardLarge({ face, topics = [], edit, badge, glyph }: { face: CgCardFace; topics?: string[]; edit?: CgCardEdit; badge?: string; glyph?: ReactNode }) {
  return (
    <div className="cg-card is-large" data-design={face.design}>
      <div className="cg-large-head">
        {glyph ?? <span className="cg-card-glyph"><CardGlyph design={face.design} icon={face.icon} kind={face.kind} /></span>}
        {edit ? (
          <label className="cg-large-field">
            <input
              autoFocus={!edit.disabled}
              className="cg-large-name"
              value={face.name}
              placeholder={edit.namePlaceholder}
              maxLength={edit.nameMax}
              disabled={edit.disabled}
              aria-label="Name"
              autoComplete="off"
              onChange={(event) => edit.onName(event.target.value)}
            />
          </label>
        ) : <span className="cg-large-name">{face.name}</span>}
        {badge ? <span className="cg-large-badge">{badge}</span> : null}
      </div>
      <div className="cg-large-focus">
        {edit ? (
          <label className="cg-large-field">
            <input
              value={face.focus ?? ''}
              placeholder="Focus, optional"
              maxLength={edit.focusMax}
              disabled={edit.disabled}
              aria-label="Focus"
              autoComplete="off"
              onChange={(event) => edit.onFocus(event.target.value)}
            />
          </label>
        ) : face.focus}
      </div>
      <div className="cg-large-topics">
        {topics.length
          ? topics.slice(0, 5).map((topic) => <span key={topic} className="cg-large-topic">{topic}</span>)
          : [70, 96, 58].map((width) => <span key={width} className="cg-large-topic is-skeleton" style={{ width }} />)}
      </div>
      <CardBird />
    </div>
  );
}

/** A profile drawn as its card: the rail tile (176×110) or the large dialog card (372×235). */
export function ProfileCard({ face, size = 'tile', topics }: { face: CgCardFace; size?: 'tile' | 'large'; topics?: string[] }) {
  if (size === 'large') return <ProfileCardLarge face={face} topics={topics} />;
  return (
    <div className="cg-card is-tile is-static" data-design={face.design}>
      <ProfileCardTile face={face} />
    </div>
  );
}
