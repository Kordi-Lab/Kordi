import { useEffect } from 'react';
import { ExternalLink, X } from 'lucide-react';

import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import {
  releaseHighlightGroups,
  type WhatsNewRelease,
} from '@/features/updates/whatsNew';

type WhatsNewDialogProps = {
  release: WhatsNewRelease;
  onDismiss: () => void;
  onPresented?: () => void;
  onOpenFullReleaseNotes?: () => void;
};

export function WhatsNewDialog({
  release,
  onDismiss,
  onPresented,
  onOpenFullReleaseNotes,
}: WhatsNewDialogProps) {
  const groups = releaseHighlightGroups(release.notes);

  useEffect(() => {
    onPresented?.();
  }, [onPresented]);

  return (
    <AppDialog
      titleId="whats-new-title"
      descriptionId="whats-new-description"
      onDismiss={onDismiss}
      className="app-whats-new-dialog w-[min(38rem,calc(100vw-1.5rem))] max-w-none overflow-hidden rounded-[22px] p-0"
    >
      <article className="flex max-h-[min(42rem,calc(100dvh-1.5rem))] min-h-0 flex-col">
        <header className="app-transient-divider flex shrink-0 items-start justify-between gap-5 border-b px-6 py-5">
          <div className="min-w-0">
            <AppDialogTitle id="whats-new-title">
              What’s New in Kordi {release.version}
            </AppDialogTitle>
            <AppDialogDescription
              id="whats-new-description"
              className="mt-1 max-w-[34rem]"
            >
              A quick look at the changes included in this version.
            </AppDialogDescription>
          </div>
          <button
            type="button"
            className="app-button-quiet grid h-8 w-8 shrink-0 place-items-center rounded-[10px]"
            onClick={onDismiss}
            aria-label="Close What’s New"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-6">
            {groups.map((group, index) => (
              <section key={`${group.title}-${index}`} aria-labelledby={`whats-new-section-${index}`}>
                <h3
                  id={`whats-new-section-${index}`}
                  className="m-0 text-[12px] font-semibold leading-5 text-[color:var(--app-transient-text)]"
                >
                  {group.title}
                </h3>
                <ul className="mt-2.5 grid list-none gap-3 p-0">
                  {group.items.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-3 text-[13px] leading-5 text-[color:var(--app-transient-muted-text)]"
                    >
                      <span
                        className="app-whats-new-bullet mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full"
                        aria-hidden="true"
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        <AppDialogActions className="app-transient-divider mt-0 shrink-0 items-center border-t px-6 py-4">
          {release.changelogUrl && onOpenFullReleaseNotes ? (
            <button
              type="button"
              className="app-transient-flat-action mr-auto inline-flex min-h-9 items-center gap-2 rounded-[10px] px-3 text-[12px] font-medium"
              onClick={onOpenFullReleaseNotes}
            >
              View full release notes
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="app-button-primary min-h-9 rounded-[10px] px-4 text-[12px] font-semibold"
            onClick={onDismiss}
            autoFocus
          >
            Continue
          </button>
        </AppDialogActions>
      </article>
    </AppDialog>
  );
}
