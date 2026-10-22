import type { CSSProperties } from 'react';
import { Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ProfileCardTile, type CgCardFace } from './ProfileCard';
import { deckLayout } from './wallet';

export type CgDeckCard = { id: string; face: CgCardFace };

/**
 * The deck rail: the profiles as overlapping tiles, the selected one at full height with a ring,
 * then "New card". Clicking a tile selects it; Open on the selected tile shows its page.
 */
export function DeckRail({ cards, selected, canAdd, onSelect, onOpen, onNew }: {
  cards: CgDeckCard[];
  selected: string | null;
  canAdd: boolean;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  onNew: () => void;
}) {
  const layout = deckLayout(cards.map((card) => card.id), selected);
  return (
    <nav className="cg-deck-rail" aria-label="Cards">
      <div className="cg-deck" style={{ height: canAdd ? layout.height : layout.plusY }}>
        {cards.map((card, index) => {
          const tile = layout.tiles[index];
          const on = card.id === selected;
          const openable = on && onOpen && card.face.status === 'built';
          const style: CSSProperties = { transform: `translate3d(0, ${tile.y}px, 0)`, height: tile.height, zIndex: tile.z };
          return (
            <div
              key={card.id}
              role="button"
              tabIndex={0}
              className={cn('cg-card is-tile', on && 'is-on')}
              data-design={card.face.design}
              style={style}
              aria-pressed={on}
              aria-label={`${card.face.name} card`}
              onClick={() => onSelect(card.id)}
              onDoubleClick={() => { if (card.face.status === 'built') onOpen?.(card.id); }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                onSelect(card.id);
              }}
            >
              <ProfileCardTile
                face={card.face}
                trailing={openable ? (
                  <button
                    type="button"
                    className="cg-tile-open"
                    aria-label={`Open ${card.face.name}`}
                    onClick={(event) => { event.stopPropagation(); onOpen(card.id); }}
                  >
                    Open
                  </button>
                ) : null}
              />
            </div>
          );
        })}
        {canAdd ? (
          <button type="button" className="cg-deck-new" style={{ transform: `translate3d(0, ${layout.plusY}px, 0)` }} onClick={onNew}>
            <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
            New card
          </button>
        ) : null}
      </div>
    </nav>
  );
}
