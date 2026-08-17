import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Film, ImagePlus, Search, Smile } from 'lucide-react';
import type {
  EmojiClickData,
  EmojiStyle,
  Theme,
} from 'emoji-picker-react';

import { Button } from '@/components/ui/button';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { cn } from '@/lib/utils';
import type { EmojiTextSelection } from './emojiText';
import {
  addFilesToExpressiveMediaLibrary,
  expressiveMediaAttachment,
  expressiveMediaPreviewUrl,
  GIF_FILE_ACCEPT,
  providerMediaAttachment,
  readExpressiveMediaLibrary,
  STICKER_FILE_ACCEPT,
  synchronizeExpressiveMediaLibrary,
  type ExpressiveMediaKind,
  type ProviderMediaSelection,
} from './expressiveMediaLibrary';

const EmojiPicker = lazy(() => import('emoji-picker-react'));
const PublicGifGrid = lazy(() => import('./PublicGifGrid'));
const PublicMemeGrid = lazy(() => import('./PublicMemeGrid'));

type PickerTab = 'emoji' | 'stickers' | 'gifs';

type ComposerExpressivePickerProps = {
  captureSelection: () => EmojiTextSelection;
  onSelectText: (value: string, selection: EmojiTextSelection) => void;
  onSendMedia: (attachment: AttachmentItem) => Promise<void> | void;
  accountId?: string | null;
};

function PickerLoading({ label }: { label: string }) {
  return (
    <div className="app-expressive-picker-empty" role="status">
      {label}
    </div>
  );
}

function libraryKind(tab: Exclude<PickerTab, 'emoji'>): ExpressiveMediaKind {
  return tab === 'stickers' ? 'sticker' : 'gif';
}

export function ComposerExpressivePicker({
  captureSelection,
  onSelectText,
  onSendMedia,
  accountId = null,
}: ComposerExpressivePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<PickerTab>('emoji');
  const [query, setQuery] = useState('');
  const [isLightTheme, setIsLightTheme] = useState(false);
  const [library, setLibrary] = useState(() => (
    readExpressiveMediaLibrary(undefined, accountId)
  ));
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isMediaBusy, setIsMediaBusy] = useState(false);
  const selectionRef = useRef<EmojiTextSelection>({ start: 0, end: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const focusTimer = window.setTimeout(() => {
      if (tab !== 'emoji') searchRef.current?.focus();
    }, 0);

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, tab]);

  function selectTab(nextTab: PickerTab) {
    setTab(nextTab);
    setQuery('');
    setMediaError(null);
  }

  function selectText(value: string) {
    onSelectText(value, selectionRef.current);
    setIsOpen(false);
  }

  async function addToLibrary(files: File[], kind: ExpressiveMediaKind) {
    if (files.length === 0) return;
    setIsMediaBusy(true);
    setMediaError(null);
    try {
      setLibrary(await addFilesToExpressiveMediaLibrary(files, kind, { accountId }));
      void synchronizeLibrary();
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Unable to add that media.');
    } finally {
      setIsMediaBusy(false);
    }
  }

  async function synchronizeLibrary() {
    const normalizedAccountId = accountId?.trim();
    if (!normalizedAccountId) return;
    try {
      const session = await loadSession();
      if (!session?.token || session.accountId !== normalizedAccountId) return;
      setLibrary(await synchronizeExpressiveMediaLibrary({
        accountId: normalizedAccountId,
        token: session.token,
        client: defaultCloudAuthClient(),
      }));
    } catch {
      // The account-scoped local library remains available while offline.
    }
  }

  async function sendMedia(attachment: AttachmentItem) {
    setIsMediaBusy(true);
    setMediaError(null);
    try {
      await onSendMedia(attachment);
      setIsOpen(false);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Unable to send that media.');
    } finally {
      setIsMediaBusy(false);
    }
  }

  async function sendProviderMedia(selection: ProviderMediaSelection) {
    setIsMediaBusy(true);
    setMediaError(null);
    try {
      await onSendMedia(await providerMediaAttachment(selection));
      setIsOpen(false);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Unable to send that media.');
    } finally {
      setIsMediaBusy(false);
    }
  }

  const mediaTab = tab === 'emoji' ? null : tab;
  const currentKind = mediaTab ? libraryKind(mediaTab) : null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingLibrary = currentKind
    ? library.filter((item) => (
      item.kind === currentKind
      && (!normalizedQuery || item.name.toLocaleLowerCase().includes(normalizedQuery))
    ))
    : [];
  const libraryLabel = currentKind === 'sticker' ? 'My Stickers' : 'My GIFs';
  return (
    <div ref={rootRef} className="app-expressive-picker-root" data-expressive-picker-root="true">
      <Button
        ref={triggerRef}
        size="icon"
        variant="secondary"
        className="app-expressive-picker-trigger app-icon-button h-8 w-8 shrink-0 rounded-full border-0"
        onPointerDown={() => {
          selectionRef.current = captureSelection();
        }}
        onClick={() => {
          const opening = !isOpen;
          if (opening) {
            setLibrary(readExpressiveMediaLibrary(undefined, accountId));
            void synchronizeLibrary();
            setIsLightTheme(Boolean(rootRef.current?.closest('.kordi-app')?.classList.contains('theme-light')));
          }
          setIsOpen(opening);
        }}
        title="Emoji, stickers, and GIFs"
        aria-label="Emoji, stickers, and GIFs"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-expressive-picker-trigger="true"
      >
        <Smile className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
      </Button>

      {isOpen ? (
        <section
          className="app-expressive-picker app-composer-popover app-transient-surface"
          role="dialog"
          aria-label="Emoji, stickers, and GIF picker"
          aria-busy={isMediaBusy}
          data-expressive-picker="true"
        >
          <div className="app-expressive-picker-tabs" role="tablist" aria-label="Media type">
            {([
              ['emoji', 'Emoji'],
              ['stickers', 'Stickers'],
              ['gifs', 'GIFs'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={cn('app-expressive-picker-tab', tab === value && 'app-expressive-picker-tab-active')}
                onClick={() => selectTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'emoji' ? (
            <div className="app-expressive-picker-emoji-library" role="tabpanel">
              <Suspense fallback={<PickerLoading label="Loading emoji…" />}>
                <EmojiPicker
                  width="100%"
                  height="100%"
                  theme={(isLightTheme ? 'light' : 'dark') as Theme}
                  emojiStyle={'native' as EmojiStyle}
                  lazyLoadEmojis
                  autoFocusSearch
                  searchPlaceholder="Search emoji"
                  searchClearButtonLabel="Clear emoji search"
                  previewConfig={{ showPreview: true }}
                  onEmojiClick={(emoji: EmojiClickData) => selectText(emoji.emoji)}
                />
              </Suspense>
            </div>
          ) : (
            <div className="app-expressive-picker-media-panel" role="tabpanel">
              <label className="app-expressive-picker-search">
                <Search className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">Search {tab}</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={`Search ${tab}`}
                  autoComplete="off"
                />
              </label>

              <input
                ref={libraryInputRef}
                type="file"
                multiple
                accept={tab === 'stickers' ? STICKER_FILE_ACCEPT : GIF_FILE_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  void addToLibrary(files, libraryKind(tab));
                }}
              />

              <div className="app-expressive-picker-heading app-expressive-picker-library-heading">
                <span>{libraryLabel}</span>
                <button
                  type="button"
                  className="app-expressive-picker-add-library"
                  disabled={isMediaBusy}
                  onClick={() => libraryInputRef.current?.click()}
                >
                  {tab === 'stickers'
                    ? <ImagePlus className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                    : <Film className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
                  Add
                </button>
              </div>

              {mediaError ? (
                <div className="app-expressive-picker-inline-error" role="alert">
                  {mediaError}
                </div>
              ) : null}

              {matchingLibrary.length > 0 ? (
                <div className="app-expressive-picker-media-grid" role="list" aria-label={libraryLabel}>
                  {matchingLibrary.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="app-expressive-picker-media"
                      disabled={isMediaBusy}
                      onClick={() => void sendMedia(expressiveMediaAttachment(item))}
                      role="listitem"
                      aria-label={`Send ${item.name}`}
                      title={`Send ${item.name}`}
                    >
                      <img src={expressiveMediaPreviewUrl(item)} alt="" draggable={false} />
                      {item.kind === 'gif' ? <span>GIF</span> : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="app-expressive-picker-library-empty">
                  {normalizedQuery
                    ? `No saved ${tab} match your search.`
                    : tab === 'stickers'
                      ? 'Add a PNG, JPEG, or WebP image.'
                      : 'Add a GIF file.'}
                </div>
              )}

              <div className="app-expressive-picker-provider-grid">
                <div className="app-expressive-picker-heading">
                  <span>{tab === 'stickers' ? 'Public Stickers' : 'Public GIFs'}</span>
                </div>
                <Suspense fallback={<PickerLoading label={`Loading ${tab}…`} />}>
                  {tab === 'stickers' ? (
                    <PublicMemeGrid
                      query={query}
                      isDisabled={isMediaBusy}
                      onSelect={(selection) => void sendProviderMedia(selection)}
                    />
                  ) : (
                    <PublicGifGrid
                      query={query}
                      isDisabled={isMediaBusy}
                      onSelect={(selection) => void sendProviderMedia(selection)}
                    />
                  )}
                </Suspense>
              </div>

              <p className="app-expressive-picker-guidance">
                Added media stays in your library. Click any saved or public result to send it.
              </p>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
