import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';


import { memoryCategoryLabel, type MemoryCategory } from './memoryCategory';
import type { MemoryLesson } from './memoryModel';
import type { MemoryOrigin } from './memoryOrigin';
import {
  EVERY_CARD,
  addableCards,
  cardLabel,
  categoryChoices,
  memoryRowCards,
  type MemoryCard,
  type MemoryFilterLayer,
} from './memoryOrganizerModel';

type OpenMenu = 'category' | 'card' | null;

/** Closes a menu on Escape or a click outside `ref`, which holds the menu and its trigger. */
function useMenuDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node | null)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape closes the menu, not the settings dialog around it.
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ref, open, onClose]);
}

function MenuWrap({ open, onClose, trigger, children }: { open: boolean; onClose: () => void; trigger: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useMenuDismiss(ref, open, onClose);
  return (
    <span ref={ref} className="mo-wrap">
      {trigger}
      {open ? <span className="mo-menu" role="menu">{children}</span> : null}
    </span>
  );
}

export type MemoryLabelsProps = {
  lesson: MemoryLesson;
  cards: readonly MemoryCard[];
  origin: MemoryOrigin;
  onToggleFilter: (layer: MemoryFilterLayer, value: string) => void;
  /** The category menu; false shows the category as a plain label. */
  categoryEditable: boolean;
  /** Card labels and their controls (`memoryVersion` 3). */
  cardsEnabled: boolean;
  busy: boolean;
  onChangeCategory: (category: MemoryCategory) => void;
  onAddCard: (profileId: string) => void;
  onRemoveCard: (profileId: string) => void;
};

/** The labels under a memory: its category, its cards and where it came from. Each label toggles its filter. */
export function MemoryLabels({
  lesson,
  cards,
  origin,
  onToggleFilter,
  categoryEditable,
  cardsEnabled,
  busy,
  onChangeCategory,
  onAddCard,
  onRemoveCard,
}: MemoryLabelsProps) {
  const [menu, setMenu] = useState<OpenMenu>(null);
  const close = () => setMenu(null);
  const toggleMenu = (next: Exclude<OpenMenu, null>) => setMenu((current) => (current === next ? null : next));
  const category = lesson.category && memoryCategoryLabel(lesson.category) ? lesson.category : null;
  const row = cardsEnabled ? memoryRowCards(lesson, cards) : { every: false, cards: [] };
  const addable = cardsEnabled ? addableCards(lesson, cards) : [];
  const filterPart = (layer: MemoryFilterLayer, value: string, label: string) => (
    <button type="button" className="mo-part" onClick={() => onToggleFilter(layer, value)}>
      {label}
    </button>
  );

  const categoryLabel = category ? (
    categoryEditable ? (
      <MenuWrap
        open={menu === 'category'}
        onClose={close}
        trigger={(
          <span data-memory-label="category" className="mo-chip">
            {filterPart('category', category, memoryCategoryLabel(category) ?? '')}
            <button
              type="button"
              className="mo-icon"
              aria-label="Change category"
              aria-haspopup="menu"
              aria-expanded={menu === 'category'}
              disabled={busy}
              onClick={() => toggleMenu('category')}
            >
              <ChevronDown aria-hidden="true" strokeWidth={2.4} />
            </button>
          </span>
        )}
      >
        {categoryChoices(lesson).map((choice) => (
          <button
            key={choice}
            type="button"
            role="menuitemradio"
            aria-checked={choice === category}
            onClick={() => {
              close();
              if (choice !== category) onChangeCategory(choice);
            }}
          >
            <span className="mo-check">{choice === category ? <Check aria-hidden="true" /> : null}</span>
            {memoryCategoryLabel(choice)}
          </button>
        ))}
      </MenuWrap>
    ) : (
      <span data-memory-label="category" className="mo-chip">
        {filterPart('category', category, memoryCategoryLabel(category) ?? '')}
      </span>
    )
  ) : null;

  return (
    <span className="mo-labels" data-memory-labels="">
      {categoryLabel}
      {row.every ? (
        <span data-memory-label="every" className="mo-chip is-card">
          {filterPart('card', EVERY_CARD, 'Every card')}
        </span>
      ) : null}
      {row.cards.map((card) => (
        <span key={card.profileId} data-memory-label="card" data-profile-id={card.profileId} className="mo-chip is-card">
          {filterPart('card', card.profileId, cardLabel(card))}
          <button type="button" className="mo-icon" aria-label={`Remove from ${cardLabel(card)}`} disabled={busy} onClick={() => onRemoveCard(card.profileId)}>
            <X aria-hidden="true" strokeWidth={2.4} />
          </button>
        </span>
      ))}
      {addable.length > 0 ? (
        <MenuWrap
          open={menu === 'card'}
          onClose={close}
          trigger={(
            <button
              type="button"
              data-memory-label="add-card"
              className="mo-chip is-add"
              aria-haspopup="menu"
              aria-expanded={menu === 'card'}
              disabled={busy}
              onClick={() => toggleMenu('card')}
            >
              + Card
            </button>
          )}
        >
          {addable.map((card) => (
            <button
              key={card.profileId}
              type="button"
              role="menuitemcheckbox"
              aria-checked={false}
              onClick={() => {
                close();
                onAddCard(card.profileId);
              }}
            >
              <span className="mo-check" />
              {cardLabel(card)}
            </button>
          ))}
        </MenuWrap>
      ) : null}
      <button
        type="button"
        data-memory-label="from"
        className="mo-chip is-from"
        onClick={() => onToggleFilter('from', origin.key)}
      >
        {origin.label}
      </button>
    </span>
  );
}
