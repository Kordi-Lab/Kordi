import { useEffect, useMemo } from 'react';
import { ExternalLink, LockKeyhole, Sparkles, Users, X } from 'lucide-react';

import {
  AppDialog,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import {
  releaseHighlights,
  type WhatsNewHighlight,
  type WhatsNewRelease,
} from '@/features/updates/whatsNew';

type WhatsNewDialogProps = {
  release: WhatsNewRelease;
  onDismiss: () => void;
  onPresented?: () => void;
  onOpenFullReleaseNotes?: () => void;
};

function highlightIcon(kind: WhatsNewHighlight['kind']) {
  const className = 'h-[18px] w-[18px]';
  if (kind === 'sign-in') return <LockKeyhole className={className} aria-hidden="true" />;
  if (kind === 'collaboration') return <Users className={className} aria-hidden="true" />;
  return <Sparkles className={className} aria-hidden="true" />;
}

function releaseDateLabel(publishedAt: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(publishedAt));
}

function releaseChannelLabel(version: string) {
  return version.split('-', 2)[1] ?? version;
}

export function WhatsNewDialog({
  release,
  onDismiss,
  onPresented,
  onOpenFullReleaseNotes,
}: WhatsNewDialogProps) {
  const highlights = useMemo(() => releaseHighlights(release), [release]);
  const updateCountLabel = `${highlights.length} product ${highlights.length === 1 ? 'update' : 'updates'}`;

  useEffect(() => {
    onPresented?.();
  }, [onPresented]);

  return (
    <AppDialog
      titleId="whats-new-title"
      descriptionId="whats-new-description"
      onDismiss={onDismiss}
      className="app-whats-new-dialog max-w-none overflow-hidden p-0"
    >
      <article className="app-whats-new-layout">
        <header className="app-whats-new-header">
          <div className="min-w-0">
            <AppDialogTitle
              id="whats-new-title"
              className="text-[24px] leading-[1.1] tracking-[-0.03em]"
            >
              What’s New in Kordi
            </AppDialogTitle>
            <AppDialogDescription
              id="whats-new-description"
              className="mt-1.5 text-[12px] font-medium leading-4"
            >
              {updateCountLabel} in the {releaseChannelLabel(release.version)} release.
            </AppDialogDescription>
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="inline-flex min-h-7 items-center rounded-full bg-[color:var(--app-transient-raised-bg)] px-2.5 text-[10.5px] font-semibold">
                {release.version}
              </span>
              <span className="text-[10.5px] font-medium text-[color:var(--app-transient-muted-text)]">
                {releaseDateLabel(release.publishedAt)}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="app-button-quiet grid h-11 w-11 shrink-0 place-items-center rounded-[12px] p-0"
            onClick={onDismiss}
            aria-label="Close What’s New"
          >
            <X className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </header>

        <div className="app-whats-new-content app-scroll-area" role="list" aria-label="Release highlights">
          {highlights.map((highlight) => (
            <article
              key={`${highlight.category}:${highlight.title}`}
              className="app-whats-new-item"
              role="listitem"
            >
              <span className="app-whats-new-icon" aria-hidden="true">
                {highlightIcon(highlight.kind)}
              </span>
              <div className="min-w-0">
                <span className="block text-[10.5px] font-semibold leading-4 text-[color:var(--app-transient-focus-ring)]">
                  {highlight.category}
                </span>
                <h3 className="mt-1 mb-0 text-[13px] font-semibold leading-[1.4] text-[color:var(--app-transient-text)]">
                  {highlight.title}
                </h3>
                {highlight.detail ? (
                  <p className="mt-1.5 mb-0 max-w-[68ch] text-[11px] leading-[1.5] text-[color:var(--app-transient-muted-text)]">
                    {highlight.detail}
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        <footer className="app-whats-new-footer">
          {release.changelogUrl && onOpenFullReleaseNotes ? (
            <button
              type="button"
              className="app-transient-flat-action inline-flex min-h-11 items-center gap-2 rounded-[12px] px-3 text-[11.5px] font-semibold"
              onClick={onOpenFullReleaseNotes}
            >
              View full changelog
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : <span />}
          <button
            type="button"
            className="app-whats-new-continue min-h-11 rounded-[12px] px-5 text-[11.5px] font-semibold"
            onClick={onDismiss}
            autoFocus
          >
            Continue
          </button>
        </footer>
      </article>
    </AppDialog>
  );
}
