import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Apple,
  Clock3,
  Flag,
  Film,
  Lightbulb,
  LoaderCircle,
  PawPrint,
  Plane,
  Puzzle,
  Search,
  Shapes,
  Smile,
  StickyNote,
  Trophy,
  UserRound,
  Upload,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  EMOJI_CATEGORIES,
  emojiForSkinTone,
  loadEmojiCatalog,
  resolveEmojiLocale,
  searchEmojiCatalog,
  type EmojiCatalog,
  type EmojiCatalogEntry,
  type EmojiCategory,
  type EmojiSkinTone,
} from './emojiCatalog';
import {
  loadEmojiPreferences,
  recordRecentEmoji,
  saveEmojiPreferences,
  type EmojiPreferences,
} from './emojiPreferences';
import type { EmojiTextSelection } from './emojiText';
import type { CloudCustomEmoji } from '@/features/cloud/authClient';
import {
  addCloudCustomEmojiAlias,
  renameCloudCustomEmoji,
  submitCloudCustomEmoji,
  updateCloudCustomEmojiStatus,
  useCloudCustomEmojiAsset,
  useCloudCustomEmojis,
} from './cloudCustomEmojis';
import {
  giphyConfigured,
  rememberGiphySelection,
  searchGiphyMedia,
  type GiphyProviderMedia,
} from './giphyProvider';

const POPULAR_EMOJI = [
  '😀', '😄', '😅', '😂', '🤣', '😊', '😍', '🥰', '😎', '🤔', '🙃',
  '😭', '😢', '😡', '😮', '🤯', '🤦', '🤷', '👍', '👎', '👏', '🙌',
  '🙏', '🤝', '👀', '💪', '❤️', '💔', '🔥', '🎉', '✨', '💯', '✅',
  '❌', '⚠️', '🚀',
];

type PickerCategory = EmojiCategory | 'custom' | 'gif' | 'sticker';

const CATEGORY_COPY: Record<PickerCategory, string> = {
  recent: 'Recent',
  smileys: 'Smileys',
  people: 'People',
  animals: 'Animals',
  food: 'Food',
  activities: 'Activities',
  travel: 'Travel',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
  custom: 'Custom',
  gif: 'GIFs',
  sticker: 'Stickers',
};

const CATEGORY_ICONS = {
  recent: Clock3,
  smileys: Smile,
  people: UserRound,
  animals: PawPrint,
  food: Apple,
  activities: Trophy,
  travel: Plane,
  objects: Lightbulb,
  symbols: Shapes,
  flags: Flag,
  custom: Puzzle,
  gif: Film,
  sticker: StickyNote,
} satisfies Record<PickerCategory, typeof Smile>;

const TONE_OPTIONS: Array<{ value: '' | EmojiSkinTone; label: string; glyph: string }> = [
  { value: '', label: 'Default skin tone', glyph: '✋' },
  { value: 'light', label: 'Light skin tone', glyph: '✋🏻' },
  { value: 'mediumLight', label: 'Medium-light skin tone', glyph: '✋🏼' },
  { value: 'medium', label: 'Medium skin tone', glyph: '✋🏽' },
  { value: 'mediumDark', label: 'Medium-dark skin tone', glyph: '✋🏾' },
  { value: 'dark', label: 'Dark skin tone', glyph: '✋🏿' },
];

type EmojiPickerPopoverProps = {
  onClose: () => void;
  onSelect: (unicode: string) => void;
  customEmojiScopeId?: string | null;
  onSelectCustom?: (emoji: CloudCustomEmoji) => void;
};

function CustomEmojiTile({ emoji, onSelect }: { emoji: CloudCustomEmoji; onSelect: () => void }) {
  const assetUrl = useCloudCustomEmojiAsset(emoji.emojiId);
  const available = emoji.status === 'active';
  return (
    <button
      type="button"
      className="app-emoji-button relative"
      role="gridcell"
      aria-label={`${emoji.name}${available ? '' : `, ${emoji.status}`}`}
      title={available ? `:${emoji.name}:` : `:${emoji.name}: · ${emoji.status}`}
      disabled={!available}
      onClick={onSelect}
    >
      {assetUrl
        ? <img src={assetUrl} alt="" className="h-7 w-7 object-contain" draggable={false} />
        : <Puzzle className="h-5 w-5" aria-hidden="true" />}
      {!available ? <span className="absolute -bottom-0.5 text-[7px] uppercase">{emoji.status}</span> : null}
    </button>
  );
}

export function EmojiPickerPopover({ onClose, onSelect, customEmojiScopeId, onSelectCustom }: EmojiPickerPopoverProps) {
  const [catalog, setCatalog] = useState<EmojiCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<PickerCategory>('recent');
  const [preferences, setPreferences] = useState<EmojiPreferences>(() => loadEmojiPreferences());
  const [activeEmoji, setActiveEmoji] = useState<EmojiCatalogEntry | null>(null);
  const [activeCustomEmoji, setActiveCustomEmoji] = useState<CloudCustomEmoji | null>(null);
  const [customName, setCustomName] = useState('');
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [customUploadState, setCustomUploadState] = useState<'idle' | 'submitting' | 'submitted'>('idle');
  const [customUploadError, setCustomUploadError] = useState<string | null>(null);
  const [aliasName, setAliasName] = useState('');
  const [aliasEmojiId, setAliasEmojiId] = useState('');
  const [renamedEmojiName, setRenamedEmojiName] = useState('');
  const [providerMedia, setProviderMedia] = useState<GiphyProviderMedia[]>([]);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const customFileRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const locale = resolveEmojiLocale(typeof navigator === 'undefined' ? 'en' : navigator.language);
  const { emojis: customEmojis, canManage: canManageCustomEmojis } = useCloudCustomEmojis(customEmojiScopeId);
  const pickerCategories: PickerCategory[] = customEmojiScopeId
    ? [...EMOJI_CATEGORIES, 'custom', 'gif', 'sticker']
    : [...EMOJI_CATEGORIES, 'gif', 'sticker'];

  useEffect(() => {
    let active = true;
    void loadEmojiCatalog()
      .then((loaded) => {
        if (active) setCatalog(loaded);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : 'Emoji could not be loaded.');
      });
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      active = false;
      window.clearTimeout(focusTimer);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (category !== 'gif' && category !== 'sticker') return undefined;
    if (!giphyConfigured()) {
      setProviderMedia([]);
      setProviderError('GIPHY is unavailable in this build.');
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setProviderLoading(true);
      setProviderError(null);
      void searchGiphyMedia(query, category, controller.signal)
        .then((items) => { if (!controller.signal.aborted) setProviderMedia(items); })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setProviderError(error instanceof Error ? error.message : 'Could not load GIPHY.');
        })
        .finally(() => { if (!controller.signal.aborted) setProviderLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [category, query]);

  const entriesByUnicode = useMemo(() => new Map(
    catalog?.entries.map((entry) => [entry.unicode, entry]) ?? [],
  ), [catalog]);

  const visibleEntries = useMemo(() => {
    if (!catalog) return [];
    if (category === 'custom' || category === 'gif' || category === 'sticker') return [];
    if (query.trim()) return searchEmojiCatalog(catalog.entries, query, locale);
    if (category === 'recent') {
      const source = preferences.recent.length > 0 ? preferences.recent : POPULAR_EMOJI;
      return source.map((unicode) => entriesByUnicode.get(unicode)).filter((entry): entry is EmojiCatalogEntry => Boolean(entry));
    }
    return catalog.entries.filter((entry) => entry.category === category);
  }, [catalog, category, entriesByUnicode, locale, preferences.recent, query]);

  const visibleCustomEmojis = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return customEmojis;
    return customEmojis.filter((emoji) => (
      emoji.name.includes(normalized) || emoji.aliases.some((alias) => alias.includes(normalized))
    ));
  }, [customEmojis, query]);

  function selectEmoji(entry: EmojiCatalogEntry) {
    const unicode = emojiForSkinTone(entry, preferences.skinTone);
    const nextPreferences = recordRecentEmoji(preferences, entry.unicode);
    setPreferences(nextPreferences);
    saveEmojiPreferences(nextPreferences);
    onSelect(unicode);
  }

  function changeSkinTone(value: string) {
    const skinTone = value === '' ? null : value as EmojiSkinTone;
    const nextPreferences = { ...preferences, skinTone };
    setPreferences(nextPreferences);
    saveEmojiPreferences(nextPreferences);
  }

  async function submitCustomEmoji() {
    if (!customEmojiScopeId || !customFile || customUploadState === 'submitting') return;
    setCustomUploadState('submitting');
    setCustomUploadError(null);
    try {
      const emoji = await submitCloudCustomEmoji(customEmojiScopeId, customName, customFile);
      setActiveCustomEmoji(emoji);
      setCustomUploadState('submitted');
      setCustomName('');
      setCustomFile(null);
      if (customFileRef.current) customFileRef.current.value = '';
    } catch (error) {
      setCustomUploadState('idle');
      setCustomUploadError(error instanceof Error ? error.message : 'Could not submit custom emoji.');
    }
  }

  async function moderateCustomEmoji(emojiId: string, status: 'active' | 'rejected') {
    setCustomUploadError(null);
    try {
      await updateCloudCustomEmojiStatus(emojiId, status);
    } catch (error) {
      setCustomUploadError(error instanceof Error ? error.message : 'Could not update custom emoji.');
    }
  }

  async function addAlias() {
    if (!aliasEmojiId || !aliasName) return;
    setCustomUploadError(null);
    try {
      await addCloudCustomEmojiAlias(aliasEmojiId, aliasName);
      setAliasName('');
    } catch (error) {
      setCustomUploadError(error instanceof Error ? error.message : 'Could not add alias.');
    }
  }

  async function renameOrDisableCustomEmoji(action: 'rename' | 'disable') {
    if (!aliasEmojiId) return;
    setCustomUploadError(null);
    try {
      if (action === 'disable') {
        await updateCloudCustomEmojiStatus(aliasEmojiId, 'disabled');
        setAliasEmojiId('');
      } else {
        await renameCloudCustomEmoji(aliasEmojiId, renamedEmojiName);
        setRenamedEmojiName('');
      }
    } catch (error) {
      setCustomUploadError(error instanceof Error ? error.message : `Could not ${action} custom emoji.`);
    }
  }

  function handleGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (buttons.length === 0) return;
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const columns = category === 'gif' || category === 'sticker' ? 3 : 8;
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowLeft' ? current - 1
          : event.key === 'ArrowRight' ? current + 1
            : event.key === 'ArrowUp' ? current - columns
              : current + columns;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  }

  return (
    <section className="app-emoji-picker app-composer-popover" role="dialog" aria-label="Emoji picker">
      <div className="app-emoji-picker-toolbar">
        <label className="app-emoji-picker-search">
          <Search className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">Search emoji</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search emoji"
            autoComplete="off"
          />
        </label>
        <label className={cn('app-emoji-tone-control', ['custom', 'gif', 'sticker'].includes(category) && 'invisible')} title="Skin tone">
          <span className="sr-only">Preferred skin tone</span>
          <select value={preferences.skinTone ?? ''} onChange={(event) => changeSkinTone(event.target.value)}>
            {TONE_OPTIONS.map((option) => (
              <option key={option.value || 'default'} value={option.value}>{option.glyph} {option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <nav className="app-emoji-categories" aria-label="Emoji categories">
        {pickerCategories.map((item) => {
          const Icon = CATEGORY_ICONS[item];
          return (
            <button
              key={item}
              type="button"
              className={cn('app-emoji-category-button', !query && category === item && 'app-emoji-category-button-active')}
              aria-label={CATEGORY_COPY[item]}
              aria-pressed={!query && category === item}
              title={CATEGORY_COPY[item]}
              onClick={() => {
                setQuery('');
                setCategory(item);
              }}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          );
        })}
      </nav>

      <div className="app-emoji-picker-heading">
        <span>{query ? 'Search results' : CATEGORY_COPY[category]}</span>
        {category === 'custom'
          ? <span>{visibleCustomEmojis.filter((emoji) => emoji.status === 'active').length} available</span>
          : category === 'gif' || category === 'sticker'
            ? <span>G-rated · Powered by GIPHY</span>
          : catalog ? <span>Emoji {catalog.unicodeEmojiVersion}</span> : null}
      </div>

      {category === 'custom' && customEmojiScopeId ? (
        <div className="mx-2 mb-2 rounded-xl border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] p-2">
          <div className="flex items-center gap-1.5">
            <input
              value={customName}
              onChange={(event) => setCustomName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32))}
              placeholder="emoji_name"
              aria-label="Custom emoji name"
              className="min-w-0 flex-1 rounded-lg border border-[color:var(--app-control-border)] bg-transparent px-2 py-1.5 text-[11px] outline-none"
            />
            <input
              ref={customFileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(event) => setCustomFile(event.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] font-medium hover:bg-[color:var(--app-control-hover)]"
              onClick={() => customFileRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              {customFile?.name ?? 'Image'}
            </button>
            <button
              type="button"
              className="h-7 rounded-lg bg-[color:var(--app-sidebar-accent)] px-2.5 text-[10px] font-semibold text-[color:var(--app-sidebar-accent-text)] disabled:opacity-50"
              disabled={!customName || !customFile || customUploadState === 'submitting'}
              onClick={() => { void submitCustomEmoji(); }}
            >
              {customUploadState === 'submitting' ? 'Submitting…' : 'Submit'}
            </button>
          </div>
          <div className={cn('mt-1 text-[9px]', customUploadError ? 'text-red-500' : 'text-[color:var(--utility-muted-text)]')} role={customUploadError ? 'alert' : 'status'}>
            {customUploadError ?? (customUploadState === 'submitted' ? 'Submitted for admin approval.' : 'PNG, JPEG, or WebP · max 1 MB · admin approval required')}
          </div>
          {canManageCustomEmojis && customEmojis.some((emoji) => emoji.status === 'pending') ? (
            <div className="mt-2 space-y-1 border-t border-[color:var(--app-divider)] pt-2" aria-label="Pending custom emoji">
              {customEmojis.filter((emoji) => emoji.status === 'pending').map((emoji) => (
                <div key={emoji.emojiId} className="flex items-center gap-2 text-[10px]">
                  <span className="min-w-0 flex-1 truncate">:{emoji.name}:</span>
                  <button type="button" className="rounded-md px-1.5 py-1 text-red-500 hover:bg-red-500/10" onClick={() => { void moderateCustomEmoji(emoji.emojiId, 'rejected'); }}>Reject</button>
                  <button type="button" className="rounded-md bg-[color:var(--app-sidebar-accent)] px-1.5 py-1 font-semibold text-[color:var(--app-sidebar-accent-text)]" onClick={() => { void moderateCustomEmoji(emoji.emojiId, 'active'); }}>Approve</button>
                </div>
              ))}
            </div>
          ) : null}
          {canManageCustomEmojis && customEmojis.some((emoji) => emoji.status === 'active') ? (
            <div className="mt-2 space-y-1.5 border-t border-[color:var(--app-divider)] pt-2" aria-label="Manage custom emoji">
              <div className="flex items-center gap-1.5">
              <select
                value={aliasEmojiId}
                onChange={(event) => setAliasEmojiId(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-[color:var(--app-control-border)] bg-transparent px-1.5 py-1.5 text-[10px]"
                aria-label="Emoji for alias"
              >
                <option value="">Choose emoji</option>
                {customEmojis.filter((emoji) => emoji.status === 'active').map((emoji) => (
                  <option key={emoji.emojiId} value={emoji.emojiId}>:{emoji.name}:</option>
                ))}
              </select>
              <input
                value={aliasName}
                onChange={(event) => setAliasName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32))}
                placeholder="alias_name"
                aria-label="New alias"
                className="min-w-0 flex-1 rounded-lg border border-[color:var(--app-control-border)] bg-transparent px-2 py-1.5 text-[10px] outline-none"
              />
              <button
                type="button"
                className="h-7 rounded-lg bg-[color:var(--app-sidebar-accent)] px-2 text-[10px] font-semibold text-[color:var(--app-sidebar-accent-text)] disabled:opacity-50"
                disabled={!aliasEmojiId || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(aliasName)}
                onClick={() => { void addAlias(); }}
              >
                Add alias
              </button>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  value={renamedEmojiName}
                  onChange={(event) => setRenamedEmojiName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32))}
                  placeholder="new_name"
                  aria-label="New custom emoji name"
                  className="min-w-0 flex-1 rounded-lg border border-[color:var(--app-control-border)] bg-transparent px-2 py-1.5 text-[10px] outline-none"
                />
                <button
                  type="button"
                  className="h-7 rounded-lg px-2 text-[10px] font-medium hover:bg-[color:var(--app-control-hover)] disabled:opacity-50"
                  disabled={!aliasEmojiId || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(renamedEmojiName)}
                  onClick={() => { void renameOrDisableCustomEmoji('rename'); }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="h-7 rounded-lg px-2 text-[10px] font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                  disabled={!aliasEmojiId}
                  onClick={() => { void renameOrDisableCustomEmoji('disable'); }}
                >
                  Disable
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div ref={gridRef} onKeyDown={handleGridKeyDown} className={cn('app-emoji-grid', (category === 'gif' || category === 'sticker') && 'grid-cols-3 content-start gap-1.5 p-2')} role="grid" aria-busy={(category === 'gif' || category === 'sticker') ? providerLoading : category !== 'custom' && !catalog && !loadError}>
        {category === 'gif' || category === 'sticker' ? (
          providerLoading ? (
            <div className="app-emoji-picker-state col-span-3" role="status">
              <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
              Loading {category === 'gif' ? 'GIFs' : 'stickers'}…
            </div>
          ) : providerError ? (
            <div className="app-emoji-picker-state app-emoji-picker-error col-span-3" role="alert">{providerError}</div>
          ) : providerMedia.length === 0 ? (
            <div className="app-emoji-picker-state col-span-3" role="status">No GIPHY results.</div>
          ) : providerMedia.map((media) => (
            <button
              key={media.providerMediaId}
              type="button"
              role="gridcell"
              className="group relative min-h-20 overflow-hidden rounded-lg bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-sidebar-accent)]"
              aria-label={media.altText}
              title={media.title}
              onClick={() => {
                onSelect(rememberGiphySelection(media));
                onClose();
              }}
            >
              <img src={media.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" draggable={false} />
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-left text-[8px] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{media.title}</span>
            </button>
          ))
        ) : category === 'custom' ? (
          visibleCustomEmojis.length === 0
            ? <div className="app-emoji-picker-state" role="status">No custom emoji yet.</div>
            : visibleCustomEmojis.map((emoji) => (
              <span className="contents" key={emoji.emojiId} onMouseEnter={() => setActiveCustomEmoji(emoji)} onFocus={() => setActiveCustomEmoji(emoji)}>
                <CustomEmojiTile emoji={emoji} onSelect={() => onSelectCustom?.(emoji)} />
              </span>
            ))
        ) : !catalog && !loadError ? (
          <div className="app-emoji-picker-state" role="status">
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
            Loading emoji…
          </div>
        ) : loadError ? (
          <div className="app-emoji-picker-state app-emoji-picker-error" role="alert">{loadError}</div>
        ) : visibleEntries.length === 0 ? (
          <div className="app-emoji-picker-state" role="status">No emoji found. Try another word.</div>
        ) : visibleEntries.map((entry) => {
          const localizedName = entry.localized[locale]?.name || entry.name;
          return (
            <button
              key={entry.codepoints}
              type="button"
              className="app-emoji-button"
              role="gridcell"
              aria-label={localizedName}
              title={localizedName}
              onMouseEnter={() => setActiveEmoji(entry)}
              onFocus={() => setActiveEmoji(entry)}
              onClick={() => selectEmoji(entry)}
            >
              {emojiForSkinTone(entry, preferences.skinTone)}
            </button>
          );
        })}
      </div>

      <div className="app-emoji-picker-footer" aria-live="polite">
        {category === 'gif' || category === 'sticker' ? (
          <>
            <span className="app-emoji-picker-footer-glyph">{category === 'gif' ? 'GIF' : '✦'}</span>
            <span className="truncate">Powered by GIPHY · G-rated results</span>
          </>
        ) : category === 'custom' ? (
          <>
            <span className="app-emoji-picker-footer-glyph">🧩</span>
            <span className="truncate">{activeCustomEmoji ? `:${activeCustomEmoji.name}: · ${activeCustomEmoji.status}` : 'Choose a custom emoji'}</span>
          </>
        ) : (
          <>
            <span className="app-emoji-picker-footer-glyph">{activeEmoji ? emojiForSkinTone(activeEmoji, preferences.skinTone) : '😀'}</span>
            <span className="truncate">{activeEmoji?.localized[locale]?.name || activeEmoji?.name || 'Choose an emoji'}</span>
          </>
        )}
      </div>
    </section>
  );
}

type ComposerEmojiButtonProps = {
  captureSelection: () => EmojiTextSelection;
  onSelect: (unicode: string, selection: EmojiTextSelection) => void;
  customEmojiScopeId?: string | null;
};

export function ComposerEmojiButton({ captureSelection, onSelect, customEmojiScopeId }: ComposerEmojiButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const selectionRef = useRef<EmojiTextSelection>({ start: 0, end: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  return (
    <div ref={rootRef} className="relative" data-emoji-picker-root="true">
      <Button
        size="icon"
        variant="secondary"
        className="app-icon-button h-9 w-9 shrink-0 rounded-full border-0"
        onPointerDown={() => { selectionRef.current = captureSelection(); }}
        onClick={() => setIsOpen((current) => !current)}
        title="Add emoji"
        aria-label="Add emoji"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <Smile className="h-4 w-4" aria-hidden="true" />
      </Button>
      {isOpen ? (
        <EmojiPickerPopover
          onClose={() => setIsOpen(false)}
          customEmojiScopeId={customEmojiScopeId}
          onSelect={(unicode) => {
            onSelect(unicode, selectionRef.current);
            setIsOpen(false);
          }}
          onSelectCustom={(emoji) => {
            onSelect(`:${emoji.name}:`, selectionRef.current);
            setIsOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
