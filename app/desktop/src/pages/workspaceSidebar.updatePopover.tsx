import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  CircleAlert,
  Download,
  RefreshCw,
  X,
} from 'lucide-react';

import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';
import { cn } from '@/lib/utils';

function formatUpdateBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateStatusMessage(state: DesktopUpdaterState) {
  if (state.status === 'checking') return 'Checking for Kordi updates…';
  if (state.status === 'up-to-date') {
    return state.currentVersion
      ? `Version ${state.currentVersion}`
      : 'Latest version installed';
  }
  if (state.status === 'downloading') {
    const received = formatUpdateBytes(state.receivedBytes ?? 0);
    const total = typeof state.totalBytes === 'number'
      ? ` of ${formatUpdateBytes(state.totalBytes)}`
      : '';
    return `Downloading update… ${received}${total}`;
  }
  if (state.status === 'installing') return 'Installing verified update…';
  if (state.status === 'relaunching') return 'Relaunching Kordi…';
  if (state.status === 'failed') return state.error || 'Unable to install the verified update.';
  return null;
}

function updateDialogTitle(state: DesktopUpdaterState) {
  if (state.status === 'checking') return 'Checking for updates';
  if (state.status === 'up-to-date') return 'Kordi is up to date';
  if (state.status === 'downloading') return 'Downloading update';
  if (state.status === 'installing') return 'Installing update';
  if (state.status === 'relaunching') return 'Relaunching Kordi';
  if (state.status === 'failed' && state.failureStage === 'check') {
    return 'Couldn’t check for updates';
  }
  if (state.status === 'failed') return 'Update failed';
  return 'New Kordi is here';
}

type SidebarUpdatePopoverProps = {
  anchor: { left: number; bottom: number } | null;
  popoverRef: RefObject<HTMLDivElement | null>;
  state: DesktopUpdaterState;
  canInstall: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onOpenUrl?: (url: string) => Promise<void> | void;
};

export function SidebarUpdatePopover({
  anchor,
  popoverRef,
  state,
  canInstall,
  onClose,
  onConfirm,
  onOpenUrl,
}: SidebarUpdatePopoverProps) {
  if (!anchor || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Kordi update status"
      style={{
        position: 'fixed',
        left: anchor.left,
        bottom: anchor.bottom,
        zIndex: 180,
      }}
      className={cn(
        'app-transient-surface app-popover app-update-popover',
        state.status === 'checking'
          ? 'w-[14.5rem] overflow-hidden rounded-[14px] px-3 py-2.5'
          : state.status === 'available'
            ? 'w-[12.75rem] overflow-visible rounded-[15px] rounded-bl-[8px] p-2.5'
            : 'w-[18rem] overflow-hidden rounded-[16px] p-3.5',
      )}
      data-update-state={state.status}
    >
      {state.status === 'available' ? (
        <span className="app-update-popover-tail" aria-hidden="true" />
      ) : null}
      {state.status === 'checking' ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2.5"
        >
          <div className="app-update-popover-symbol grid h-7 w-7 shrink-0 place-items-center rounded-full">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          </div>
          <div className="app-update-popover-title text-[12px] font-medium tracking-[-0.01em]">
            Checking for updates
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          {state.status !== 'available' ? (
            <div className={cn(
              'app-update-popover-symbol mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full',
              state.status === 'failed' && 'app-update-popover-symbol-danger',
              state.status === 'up-to-date' && 'app-update-popover-symbol-success',
            )}>
              {state.status === 'up-to-date' ? (
                <CheckCircle2 className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : null}
              {state.status === 'failed' ? (
                <CircleAlert className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : null}
              {state.status === 'downloading' ? (
                <Download className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : null}
              {state.status === 'installing' || state.status === 'relaunching' ? (
                <RefreshCw
                  className="h-[18px] w-[18px] animate-spin"
                  aria-hidden="true"
                />
              ) : null}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="app-update-popover-title text-[12px] font-semibold tracking-[-0.01em]">
              {updateDialogTitle(state)}
            </div>
            <div className="app-update-popover-copy mt-0.5 text-[10.5px] leading-4">
              {state.status === 'up-to-date' ? updateStatusMessage(state) : null}
              {state.status === 'available'
                ? `${state.latestVersion ?? 'Update'} · Ready to install.`
                : null}
              {state.status === 'failed' && state.failureStage === 'check'
                ? 'The update server could not be reached. Your current app is unaffected.'
                : null}
              {state.status === 'failed' && state.failureStage !== 'check'
                ? `Kordi ${state.latestVersion ?? 'update'} could not be installed.`
                : null}
              {state.status === 'downloading'
                ? 'Downloading and verifying the update.'
                : null}
              {state.status === 'installing'
                ? 'Finishing installation before Kordi relaunches.'
                : null}
              {state.status === 'relaunching'
                ? 'The verified update is installed.'
                : null}
            </div>
          </div>
          {state.status !== 'downloading'
            && state.status !== 'installing'
            && state.status !== 'relaunching' ? (
              <button
                type="button"
                className="app-button-quiet app-update-popover-close grid h-5 w-5 shrink-0 place-items-center rounded-full p-0"
                aria-label="Close update status"
                onClick={onClose}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
        </div>
      )}

      {state.status === 'failed'
        || state.status === 'downloading'
        || state.status === 'installing'
        || state.status === 'relaunching' ? (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              'app-update-popover-status ml-11 mt-2 text-[10.5px] leading-4',
              state.status === 'failed' && 'app-update-popover-status-danger',
            )}
          >
            {updateStatusMessage(state)}
          </div>
        ) : null}

      {state.status === 'downloading'
        && typeof state.totalBytes === 'number'
        && state.totalBytes > 0 ? (
          <div
            className="app-update-popover-progress ml-11 mt-2 h-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(
              100,
              ((state.receivedBytes ?? 0) / state.totalBytes) * 100,
            ))}
          >
            <div
              className="app-update-popover-progress-value h-full rounded-full transition-[width]"
              style={{
                width: `${Math.min(
                  100,
                  ((state.receivedBytes ?? 0) / state.totalBytes) * 100,
                )}%`,
              }}
            />
          </div>
        ) : null}

      {state.status === 'up-to-date' ? (
        <div className="app-update-popover-meta ml-11 mt-2 flex items-center gap-1.5 text-[10.5px]">
          <span
            className="app-update-popover-success-dot h-1.5 w-1.5 rounded-full"
            aria-hidden="true"
          />
          Checked just now
        </div>
      ) : null}

      {state.status === 'available'
        || state.status === 'failed'
        || state.status === 'downloading'
        || state.status === 'installing'
        || state.status === 'relaunching' ? (
          <div className={cn(
            'flex items-center justify-end gap-2',
            state.status === 'available' ? 'mt-2' : 'mt-3',
          )}>
            {state.status === 'failed' && state.manualDownloadUrl ? (
              <button
                type="button"
                    className="app-button-quiet app-update-popover-action app-update-popover-action-secondary mr-auto rounded-[9px] px-2.5 py-1.5 text-[11px] font-medium"
                onClick={() => {
                  void onOpenUrl?.(state.manualDownloadUrl!);
                }}
              >
                Download manually
              </button>
            ) : null}
            {state.status === 'available' || state.status === 'failed' ? (
              <button
                type="button"
                className={cn(
                  'app-update-popover-action app-update-popover-action-primary font-semibold transition disabled:cursor-not-allowed disabled:opacity-55',
                  state.status === 'available'
                    ? 'grid h-7 w-7 place-items-center rounded-full p-0'
                    : 'rounded-[9px] px-2.5 py-1.5 text-[11px]',
                )}
                disabled={state.status === 'available' ? !canInstall : false}
                onClick={onConfirm}
                aria-label={state.status === 'available' ? 'Update Kordi now' : undefined}
                title={state.status === 'available' ? 'Update now' : undefined}
              >
                {state.status === 'available' ? (
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                ) : state.failureStage === 'check' ? (
                  'Try again'
                ) : (
                  'Retry'
                )}
              </button>
            ) : null}
            {state.status === 'downloading'
              || state.status === 'installing'
              || state.status === 'relaunching' ? (
                <button
                  type="button"
                  className="app-update-popover-action app-update-popover-action-primary rounded-[9px] px-2.5 py-1.5 text-[11px] font-semibold opacity-55"
                  disabled
                >
                  {state.status === 'downloading'
                    ? 'Downloading…'
                    : state.status === 'installing'
                      ? 'Installing…'
                      : 'Relaunching…'}
                </button>
              ) : null}
          </div>
        ) : null}
    </div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
