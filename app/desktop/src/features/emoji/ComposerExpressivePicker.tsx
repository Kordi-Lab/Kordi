import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Film, ImagePlus, Search, Smile, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { cn } from '@/lib/utils';
import type { EmojiTextSelection } from './emojiText';
import { BlobEmojiPicker } from './BlobEmojiPicker';
import { blobEmojiInlineToken } from './blobEmoji';
import {
  addFilesToExpressiveMediaLibrary,
  deleteExpressiveMediaLibraryItem,
  expressiveMediaAttachment,
  expressiveMediaPreviewUrl,
  GIF_FILE_ACCEPT,
  readExpressiveMediaLibrary,
  STICKER_FILE_ACCEPT,
  synchronizeExpressiveMediaLibrary,
  type ExpressiveMediaKind,
} from './expressiveMediaLibrary';

type PickerTab = 'emoji' | 'stickers' | 'gifs';

type ComposerExpressivePickerProps = {
  captureSelection: () => EmojiTextSelection;
  onSelectText: (value: string, selection: EmojiTextSelection) => void;
  onSendMedia: (attachment: AttachmentItem) => Promise<void> | void;
  accountId?: string | null;
};

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
  const [library, setLibrary] = useState(() => (
    readExpressiveMediaLibrary(undefined, accountId)
  ));
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isMediaBusy, setIsMediaBusy] = useState(false);
  const [mediaMenu, setMediaMenu] = useState<{ itemId: string; x: number; y: number } | null>(null);
  const selectionRef = useRef<EmojiTextSelection>({ start: 0, end: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mediaMenuRef = useRef<HTMLDivElement | null>(null);
  const mediaMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const mediaSendPendingRef = useRef(false);

  const synchronizeLibrary = useCallback(async () => {
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
  }, [accountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void synchronizeLibrary(), 0);
    return () => window.clearTimeout(timer);
  }, [accountId, synchronizeLibrary]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const focusTimer = window.setTimeout(() => {
      if (tab !== 'emoji') searchRef.current?.focus();
    }, 0);

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)
        || mediaMenuRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (mediaMenuRef.current) {
        setMediaMenu(null);
        queueMicrotask(() => mediaMenuTriggerRef.current?.focus());
        return;
      }
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

  useEffect(() => {
    if (!mediaMenu) return undefined;
    function closeMenu(event: Event) {
      if (event.target instanceof Node && mediaMenuRef.current?.contains(event.target)) return;
      setMediaMenu(null);
    }
    document.addEventListener('pointerdown', closeMenu, true);
    document.addEventListener('contextmenu', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', closeMenu, true);
      document.removeEventListener('contextmenu', closeMenu, true);
    };
  }, [mediaMenu]);

  function selectTab(nextTab: PickerTab) {
    setMediaMenu(null);
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

  async function sendMedia(attachment: AttachmentItem) {
    if (mediaSendPendingRef.current) return;
    mediaSendPendingRef.current = true;
    setMediaMenu(null);
    setIsMediaBusy(true);
    setMediaError(null);
    setIsOpen(false);
    try {
      await onSendMedia(attachment);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Unable to send that media.');
      setIsOpen(true);
    } finally {
      mediaSendPendingRef.current = false;
      setIsMediaBusy(false);
    }
  }

  async function deleteMedia(itemId: string) {
    setMediaMenu(null);
    setIsMediaBusy(true);
    setMediaError(null);
    try {
      const session = await loadSession();
      setLibrary(await deleteExpressiveMediaLibraryItem(itemId, {
        accountId,
        token: session && session.accountId === accountId?.trim() ? session.token : null,
        client: defaultCloudAuthClient(),
      }));
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Unable to delete that media.');
    } finally {
      setIsMediaBusy(false);
    }
  }

  function openMediaMenu(itemId: string, trigger: HTMLButtonElement, x: number, y: number) {
    mediaMenuTriggerRef.current = trigger;
    setMediaMenu({
      itemId,
      x: Math.max(8, Math.min(x, window.innerWidth - 152)),
      y: Math.max(8, Math.min(y, window.innerHeight - 52)),
    });
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
          }
          setIsOpen(opening);
        }}
        title="Blob Emoji, stickers, and GIFs"
        aria-label="Blob Emoji, stickers, and GIFs"
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
          aria-label="Blob Emoji, stickers, and GIF picker"
          aria-busy={isMediaBusy}
          data-expressive-picker="true"
        >
          <div className="app-expressive-picker-tabs" role="tablist" aria-label="Media type">
            {([
              ['emoji', 'Blob Emoji'],
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
              <BlobEmojiPicker onSelect={(emoji) => selectText(blobEmojiInlineToken(emoji))} />
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
                <div className="app-expressive-picker-media-grid" role="group" aria-label={libraryLabel}>
                  {matchingLibrary.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="app-expressive-picker-media"
                      disabled={isMediaBusy}
                      onClick={() => void sendMedia(expressiveMediaAttachment(item))}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openMediaMenu(item.id, event.currentTarget, event.clientX, event.clientY);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        openMediaMenu(item.id, event.currentTarget, rect.left, rect.bottom + 2);
                      }}
                      aria-haspopup="menu"
                      aria-label={`Send ${item.name}`}
                      title={`Send ${item.name}. Right-click to manage.`}
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
                      ? 'Add a PNG, JPEG, WebP, or GIF image.'
                      : 'Add a GIF file.'}
                </div>
              )}
            </div>
          )}
        </section>
      ) : null}
      {mediaMenu && typeof document !== 'undefined' ? createPortal(
        <div
          ref={mediaMenuRef}
          className="app-transient-surface fixed z-[2147483647] w-36 rounded-[14px] border p-1.5"
          style={{ left: mediaMenu.x, top: mediaMenu.y }}
          role="menu"
          aria-label="Manage saved media"
          data-expressive-media-menu="true"
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            autoFocus
            type="button"
            role="menuitem"
            className="app-transient-flat-action app-transient-flat-action-danger app-transient-action-row flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left transition"
            onClick={() => void deleteMedia(mediaMenu.itemId)}
          >
            <Trash2 className="app-transient-action-icon" aria-hidden="true" />
            Delete
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
