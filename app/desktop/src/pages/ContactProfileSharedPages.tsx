import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronLeft, FileText, Play } from 'lucide-react';

import { readCachedLinkPreview } from '@/kordi-app/components/linkPreviewMetadata';
import { formatAttachmentSize } from '@/kordi-app/components/transcriptAttachmentTypes';
import { cn } from '@/lib/utils';
import { openSharedFile, openSharedLink, openSharedPhoto } from '@/pages/contactProfileSharedActions';
import {
  CONTACT_PROFILE_SHARED_PAGE_TITLES,
  groupSharedItemsByMonth,
  sharedItemDateLabel,
  sharedPageCountLabel,
  sharedLinkDisplayUrl,
  type ContactProfileSharedItems,
  type ContactProfileSharedPage,
  type SharedFileItem,
  type SharedLinkItem,
  type SharedMonthGroup,
  type SharedPhotoItem,
} from '@/pages/contactProfileSharedItems';
import { useSharedPhotoThumbnail } from '@/pages/useSharedPhotoThumbnail';

const EMPTY_LABELS: Record<ContactProfileSharedPage, string> = {
  photos: 'No photos',
  files: 'No files',
  links: 'No links',
};

const LINK_TILE_HUES = [4, 28, 152, 196, 214, 262, 292, 338];

function linkTileHue(domain: string) {
  let hash = 0;
  for (const character of domain) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return LINK_TILE_HUES[hash % LINK_TILE_HUES.length];
}

function MonthLabel({ label }: { label: string }) {
  return label ? <div className="app-contact-shared-month">{label}</div> : null;
}

function PhotoTile({ photo, index, photos }: { photo: SharedPhotoItem; index: number; photos: readonly SharedPhotoItem[] }) {
  const { tileRef, url } = useSharedPhotoThumbnail(photo.attachment, photo.isVideo);
  return (
    <button
      ref={tileRef}
      type="button"
      className="app-contact-shared-tile"
      aria-label={photo.attachment.name || (photo.isVideo ? 'Video' : 'Photo')}
      onClick={() => { void openSharedPhoto(photos, index, url).catch(() => undefined); }}
    >
      {url ? <img src={url} alt="" draggable={false} loading="lazy" decoding="async" /> : null}
      {photo.isVideo ? (
        <span className="app-contact-shared-play" aria-hidden="true">
          <Play className="h-2.5 w-2.5" fill="currentColor" />
        </span>
      ) : null}
    </button>
  );
}

function PhotosPage({ groups, photos }: { groups: SharedMonthGroup<SharedPhotoItem>[]; photos: readonly SharedPhotoItem[] }) {
  const indexByKey = useMemo(() => new Map(photos.map((photo, index) => [photo.key, index])), [photos]);
  return groups.map((group) => (
    <section key={group.key} aria-label={group.label || undefined}>
      <MonthLabel label={group.label} />
      <div className="app-contact-shared-grid">
        {group.items.map((photo) => (
          <PhotoTile key={photo.key} photo={photo} index={indexByKey.get(photo.key) ?? 0} photos={photos} />
        ))}
      </div>
    </section>
  ));
}

function SharedRow({ lead, title, caption, trailing, captionAccent = false, onClick }: {
  lead: ReactNode;
  title: string;
  caption: string;
  trailing?: string;
  captionAccent?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="app-contact-shared-row" onClick={onClick}>
      {lead}
      <span className="min-w-0 flex-1">
        <span className="app-contact-shared-row-title block truncate" title={title}>{title}</span>
        <span className={cn('app-contact-shared-row-caption block truncate', captionAccent && 'is-accent')}>{caption}</span>
      </span>
      {trailing ? <span className="app-contact-shared-row-date">{trailing}</span> : null}
    </button>
  );
}

function FilesPage({ groups, now }: { groups: SharedMonthGroup<SharedFileItem>[]; now: Date }) {
  return groups.map((group) => (
    <section key={group.key} aria-label={group.label || undefined}>
      <MonthLabel label={group.label} />
      <div className="app-contact-shared-list">
        {group.items.map((file) => {
          const caption = [formatAttachmentSize(file.attachment.sizeBytes), sharedItemDateLabel(file.timestampMs, now)]
            .filter(Boolean)
            .join(' · ');
          return (
            <SharedRow
              key={file.key}
              lead={<span className="app-contact-shared-lead is-file"><FileText aria-hidden="true" /></span>}
              title={file.attachment.name || 'File'}
              caption={caption}
              onClick={() => { void openSharedFile(file.attachment).catch(() => undefined); }}
            />
          );
        })}
      </div>
    </section>
  ));
}

function LinksPage({ groups, now }: { groups: SharedMonthGroup<SharedLinkItem>[]; now: Date }) {
  return groups.map((group) => (
    <section key={group.key} aria-label={group.label || undefined}>
      <MonthLabel label={group.label} />
      <div className="app-contact-shared-list">
        {group.items.map((link) => (
          <SharedRow
            key={link.key}
            lead={(
              <span className="app-contact-shared-lead is-link" style={{ '--app-shared-link-hue': linkTileHue(link.domain) } as CSSProperties} aria-hidden="true">
                {link.domain.charAt(0).toUpperCase()}
              </span>
            )}
            title={readCachedLinkPreview(link.href)?.title ?? link.label ?? sharedLinkDisplayUrl(link.href)}
            caption={link.domain}
            captionAccent
            trailing={sharedItemDateLabel(link.timestampMs, now)}
            onClick={() => { void openSharedLink(link.href).catch(() => undefined); }}
          />
        ))}
      </div>
    </section>
  ));
}

/**
 * A shared Photos, Files or Links page that replaces the profile inside the same card or pane.
 * The header is a toolbar row: a back control ("Back" in panes, icon only in the popover), the
 * title and a quiet item count. Escape and the back control return to the profile.
 */
export function ContactProfileSharedPageView({
  page,
  items,
  variant,
  onBack,
  backLabel = 'Back to profile',
  trailing,
}: {
  page: ContactProfileSharedPage;
  items: ContactProfileSharedItems;
  variant: 'popover' | 'pane';
  onBack: () => void;
  /** Accessible name of the back control. */
  backLabel?: string;
  trailing?: ReactNode;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  const onBackRef = useRef(onBack);
  useEffect(() => { onBackRef.current = onBack; });
  const title = CONTACT_PROFILE_SHARED_PAGE_TITLES[page];
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
    // Window capture runs before the popover's and the Contacts page's own Escape handlers.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onBackRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const count = items[page].length;
  const countLabel = sharedPageCountLabel(page, count);
  return (
    <div className={cn('app-contact-shared-page', `is-${variant}`)} role="region" aria-label={title}>
      <div className="app-contact-shared-header">
        <div className="app-contact-shared-header-row">
          <button ref={backRef} type="button" className="app-contact-shared-back" onClick={onBack} aria-label={backLabel} title="Back">
            <ChevronLeft className="app-contact-shared-back-icon" aria-hidden="true" />
            {variant === 'pane' ? <span className="app-contact-shared-back-label">Back</span> : null}
          </button>
          <span className="app-contact-shared-title truncate">{title}</span>
          {countLabel ? <span className="app-contact-shared-count">{countLabel}</span> : null}
        </div>
        {trailing}
      </div>
      <div className="app-contact-shared-body app-transient-scroll">
        {count === 0 ? <div className="app-contact-shared-empty">{EMPTY_LABELS[page]}</div>
          : page === 'photos' ? <PhotosPage groups={groupSharedItemsByMonth(items.photos, now)} photos={items.photos} />
            : page === 'files' ? <FilesPage groups={groupSharedItemsByMonth(items.files, now)} now={now} />
              : <LinksPage groups={groupSharedItemsByMonth(items.links, now)} now={now} />}
      </div>
    </div>
  );
}
