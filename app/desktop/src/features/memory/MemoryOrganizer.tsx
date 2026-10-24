import { Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { SettingsSection } from '@/kordi-app/components/settingsLayout';

import { MemoryLabels } from './MemoryLabelMenus';
import { MemoryList } from './MemoryList';
import { MEMORY_CATEGORIES, memoryCategoryLabel, type MemoryCategory } from './memoryCategory';
import { memoryCardsAvailable, memoryCategoriesEditable, type MemoryClient } from './memoryClient';
import type { MemoryAddTarget, MemoryLesson } from './memoryModel';
import { memoryOrigin, type MemoryOrigin, type MemoryOriginSources } from './memoryOrigin';
import {
  EVERY_CARD,
  NO_FILTERS,
  canChangeCategory,
  cardLabel,
  filterCounts,
  hasFilter,
  matchesFilters,
  matchesQuery,
  memoryChangeErrorMessage,
  rowKeys,
  toggleFilter,
  type MemoryCard,
  type MemoryFilterLayer,
  type MemoryFilters,
} from './memoryOrganizerModel';

export type MemoryOrganizerProps = {
  client: MemoryClient;
  lessons: MemoryLesson[];
  onLessonsChange: (update: (current: MemoryLesson[]) => MemoryLesson[]) => void;
  viewerAccountId: string | null;
  /** The server's `memoryVersion`: 2 changes categories, 3 shows cards. */
  memoryVersion: number | null;
  cards: readonly MemoryCard[];
  originSources: MemoryOriginSources;
  addTarget: MemoryAddTarget | null;
  onChanged?: () => void;
  /** Rows above the list, such as the memory-off notice. */
  notice?: ReactNode;
  /** Rows after the list, such as Forget everything. */
  footer?: ReactNode;
};

type FilterChip = { value: string; label: string };

function FilterLayer({ name, layer, chips, counts, filters, onToggle }: {
  name: string;
  layer: MemoryFilterLayer;
  chips: FilterChip[];
  counts: Map<string, number>;
  filters: MemoryFilters;
  onToggle: (layer: MemoryFilterLayer, value: string) => void;
}) {
  const shown = chips.filter((chip) => (counts.get(chip.value) ?? 0) > 0 || filters[layer].has(chip.value));
  if (shown.length === 0) return null;
  return (
    <div className="mo-layer" data-memory-filter-layer={layer}>
      <span className="mo-layer-name">{name}</span>
      {shown.map((chip) => (
        <button
          key={chip.value}
          type="button"
          className={`mo-filter is-${layer}`}
          aria-pressed={filters[layer].has(chip.value)}
          onClick={() => onToggle(layer, chip.value)}
        >
          {chip.label}
          <span className="mo-count">{counts.get(chip.value) ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

/** Every memory of the account in one list, newest first, with search, filters and labels. */
export function MemoryOrganizer({
  client,
  lessons,
  onLessonsChange,
  viewerAccountId,
  memoryVersion,
  cards,
  originSources,
  addTarget,
  onChanged,
  notice,
  footer,
}: MemoryOrganizerProps) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<MemoryFilters>(NO_FILTERS);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const cardsEnabled = memoryCardsAvailable(memoryVersion) && 'addMemoryToCard' in client && 'removeMemoryFromCard' in client;
  const categoriesEditable = memoryCategoriesEditable(memoryVersion) && 'updateMemoryCategory' in client;

  const rows = useMemo(() => lessons.map((lesson) => {
    const origin = memoryOrigin(lesson, originSources);
    return { lesson, origin, keys: rowKeys(lesson, cards, origin.key, cardsEnabled) };
  }), [lessons, originSources, cards, cardsEnabled]);
  const counts = useMemo(() => filterCounts(rows.map((row) => row.keys)), [rows]);
  const origins = useMemo(() => {
    const byKey = new Map<string, MemoryOrigin>();
    [...rows].sort((a, b) => b.lesson.updatedAt.localeCompare(a.lesson.updatedAt))
      .forEach((row) => { if (!byKey.has(row.origin.key)) byKey.set(row.origin.key, row.origin); });
    const listed = [...byKey.values()];
    return [...listed.filter((origin) => origin.key === 'global'), ...listed.filter((origin) => origin.key !== 'global')];
  }, [rows]);
  const visible = rows.filter((row) => matchesQuery(row.lesson, query) && matchesFilters(row.keys, filters)).map((row) => row.lesson);
  const originOf = new Map(rows.map((row) => [row.lesson.lessonId, row.origin]));
  const onToggle = (layer: MemoryFilterLayer, value: string) => setFilters((current) => toggleFilter(current, layer, value));

  const change = async (lesson: MemoryLesson, run: () => Promise<MemoryLesson> | undefined, done: string) => {
    const pending = run();
    if (!pending) return;
    setBusy((current) => new Set(current).add(lesson.lessonId));
    setError(null);
    try {
      const updated = await pending;
      onLessonsChange((current) => current.map((entry) => (entry.lessonId === updated.lessonId ? updated : entry)));
      setStatusMessage(done);
      onChanged?.();
    } catch (caught) {
      setError(memoryChangeErrorMessage(caught));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(lesson.lessonId);
        return next;
      });
    }
  };

  const nameOf = (profileId: string) => {
    const card = cards.find((entry) => entry.profileId === profileId);
    return card ? cardLabel(card) : 'card';
  };

  const renderLabels = (lesson: MemoryLesson) => (
    <MemoryLabels
      lesson={lesson}
      cards={cards}
      origin={originOf.get(lesson.lessonId) ?? memoryOrigin(lesson, originSources)}
      filters={filters}
      onToggleFilter={onToggle}
      categoryEditable={categoriesEditable && canChangeCategory(lesson, viewerAccountId)}
      cardsEnabled={cardsEnabled}
      busy={busy.has(lesson.lessonId)}
      onChangeCategory={(category: MemoryCategory) => {
        void change(lesson, () => client.updateMemoryCategory?.(lesson.lessonId, category), `Category set to ${memoryCategoryLabel(category)}.`);
      }}
      onAddCard={(profileId) => {
        void change(lesson, () => client.addMemoryToCard?.(lesson.lessonId, profileId), `Added to ${nameOf(profileId)}.`);
      }}
      onRemoveCard={(profileId) => {
        void change(lesson, () => client.removeMemoryFromCard?.(lesson.lessonId, profileId), `Removed from ${nameOf(profileId)}.`);
      }}
    />
  );

  const cardChips: FilterChip[] = [
    ...cards.map((card) => ({ value: card.profileId, label: cardLabel(card) })),
    { value: EVERY_CARD, label: 'Every card' },
  ];
  const categoryChips: FilterChip[] = MEMORY_CATEGORIES.map((category) => ({ value: category, label: memoryCategoryLabel(category) ?? category }));
  const originChips: FilterChip[] = origins.map((origin) => ({ value: origin.key, label: origin.label }));

  return (
    <SettingsSection title={`All memories · ${lessons.length}`}>
      <div data-memory-organizer="">
        <p className="sr-only" aria-live="polite">{statusMessage}</p>
        {lessons.length > 0 ? (
          <>
            <label className="mo-find">
              <Search aria-hidden="true" />
              <input type="search" placeholder="Search memories" aria-label="Search memories" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="mo-filters">
              {cardsEnabled ? <FilterLayer name="Cards" layer="card" chips={cardChips} counts={counts.card} filters={filters} onToggle={onToggle} /> : null}
              <FilterLayer name="Categories" layer="category" chips={categoryChips} counts={counts.category} filters={filters} onToggle={onToggle} />
              <FilterLayer name="From" layer="from" chips={originChips} counts={counts.from} filters={filters} onToggle={onToggle} />
              {hasFilter(filters) ? <button type="button" className="mo-clear" onClick={() => setFilters(NO_FILTERS)}>Clear</button> : null}
            </div>
          </>
        ) : null}
        {error ? (
          <p className="app-error-text my-2 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">{error}</p>
        ) : null}
        {notice}
        <MemoryList
          client={client}
          lessons={visible}
          onLessonsChange={onLessonsChange}
          emptyLabel={lessons.length === 0 ? 'No memories yet.' : 'No memories match.'}
          onChanged={onChanged}
          viewerAccountId={viewerAccountId}
          addTarget={addTarget}
          renderLabels={renderLabels}
        />
        {footer}
      </div>
    </SettingsSection>
  );
}
