import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { RefreshCw } from 'lucide-react';

import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';
import { cn } from '@/lib/utils';
import { SidebarUpdatePopover } from '@/pages/workspaceSidebar.updatePopover';
import { desktopUpdateButtonPresentation } from '@/pages/workspaceSidebar.updatePresentation';

export type SidebarUpdaterProps = {
  isNativeShell: boolean;
  onCheckForUpdates?: () => Promise<DesktopUpdaterState>;
  onInstallUpdate?: () => Promise<void>;
  onRetryUpdate?: () => Promise<void | DesktopUpdaterState>;
  onSubscribeToUpdate?: (listener: (state: DesktopUpdaterState) => void) => () => void;
  onOpenUpdateUrl?: (url: string) => Promise<void> | void;
};

export function SidebarUpdater({
  isNativeShell,
  onCheckForUpdates,
  onInstallUpdate,
  onRetryUpdate,
  onSubscribeToUpdate,
  onOpenUpdateUrl,
}: SidebarUpdaterProps) {
  const updateButtonRef = useRef<HTMLButtonElement | null>(null);
  const updatePopoverRef = useRef<HTMLDivElement | null>(null);
  const updateCheckPromiseRef = useRef<Promise<DesktopUpdaterState> | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdaterState>({ status: 'idle' });
  const updateStateRef = useRef<DesktopUpdaterState>({ status: 'idle' });
  const [isUpdateConfirmOpen, setIsUpdateConfirmOpen] = useState(false);
  const [updateConfirmAnchor, setUpdateConfirmAnchor] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const [isUpdateCheckPending, setIsUpdateCheckPending] = useState(false);
  const buttonPresentation = desktopUpdateButtonPresentation(
    updateState,
    isUpdateCheckPending,
  );

  const applyUpdateState = useCallback((nextState: DesktopUpdaterState) => {
    updateStateRef.current = nextState;
    setUpdateState(nextState);
  }, []);

  useEffect(() => {
    if (!onSubscribeToUpdate) return;
    return onSubscribeToUpdate(applyUpdateState);
  }, [applyUpdateState, onSubscribeToUpdate]);

  const runUpdateCheck = useCallback((showResult: boolean) => {
    if (!isNativeShell || !onCheckForUpdates) {
      return Promise.resolve<DesktopUpdaterState>({ status: 'idle' });
    }
    if (showResult) setIsUpdateConfirmOpen(true);
    if (updateCheckPromiseRef.current) return updateCheckPromiseRef.current;

    setIsUpdateCheckPending(true);
    applyUpdateState({
      ...updateStateRef.current,
      status: 'checking',
      error: undefined,
      failureStage: undefined,
    });

    const pending = onCheckForUpdates()
      .then((result) => {
        applyUpdateState(result);
        return result;
      })
      .catch((error) => {
        const failed: DesktopUpdaterState = {
          ...updateStateRef.current,
          status: 'failed',
          failureStage: 'check',
          error: error instanceof Error && error.message.trim()
            ? error.message
            : 'Unable to check for Kordi updates. Check your connection and try again.',
        };
        applyUpdateState(failed);
        return failed;
      })
      .finally(() => {
        if (updateCheckPromiseRef.current === pending) {
          updateCheckPromiseRef.current = null;
        }
        setIsUpdateCheckPending(false);
      });
    updateCheckPromiseRef.current = pending;
    return pending;
  }, [applyUpdateState, isNativeShell, onCheckForUpdates]);

  useEffect(() => {
    if (!isNativeShell || !onCheckForUpdates) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void runUpdateCheck(false);
    });
    return () => {
      active = false;
    };
  }, [isNativeShell, onCheckForUpdates, runUpdateCheck]);

  const measureUpdateConfirmAnchor = useCallback(() => {
    const trigger = updateButtonRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const popoverWidth = updateState.status === 'checking' ? 232 : 288;
    setUpdateConfirmAnchor({
      left: Math.max(
        12,
        Math.min(rect.right + 8, window.innerWidth - popoverWidth - 12),
      ),
      bottom: Math.max(12, window.innerHeight - rect.bottom),
    });
  }, [updateState.status]);

  useLayoutEffect(() => {
    if (!isUpdateConfirmOpen) return;
    measureUpdateConfirmAnchor();
    window.addEventListener('resize', measureUpdateConfirmAnchor);
    return () => window.removeEventListener('resize', measureUpdateConfirmAnchor);
  }, [isUpdateConfirmOpen, measureUpdateConfirmAnchor]);

  useEffect(() => {
    if (!isUpdateConfirmOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (updatePopoverRef.current?.contains(target)) return;
      if (updateButtonRef.current?.contains(target)) return;
      setIsUpdateConfirmOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsUpdateConfirmOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isUpdateConfirmOpen]);

  useEffect(() => {
    if (!isUpdateConfirmOpen || updateState.status !== 'up-to-date') return;
    const timer = window.setTimeout(() => setIsUpdateConfirmOpen(false), 5000);
    return () => window.clearTimeout(timer);
  }, [isUpdateConfirmOpen, updateState.status]);

  const handleUpdateButtonClick = () => {
    if (updateState.status === 'checking' || isUpdateCheckPending) return;
    if (isUpdateConfirmOpen) {
      setIsUpdateConfirmOpen(false);
      return;
    }
    if (updateState.status === 'idle' || updateState.status === 'up-to-date') {
      void runUpdateCheck(true);
      return;
    }
    setIsUpdateConfirmOpen(true);
  };

  const handleConfirmUpdate = async () => {
    if (updateState.status === 'failed' && updateState.failureStage === 'check') {
      await runUpdateCheck(true);
      return;
    }
    const action = updateState.status === 'failed'
      ? (onRetryUpdate ?? onInstallUpdate)
      : onInstallUpdate;
    if (!action) return;
    try {
      const result = await action();
      if (result) applyUpdateState(result);
    } catch (error) {
      applyUpdateState({
        ...updateStateRef.current,
        status: 'failed',
        failureStage: 'install',
        error: error instanceof Error ? error.message : 'Unable to install update',
      });
    }
  };

  if (!isNativeShell || !onCheckForUpdates) return null;

  return (
    <>
      <button
        ref={updateButtonRef}
        type="button"
        onClick={handleUpdateButtonClick}
        disabled={buttonPresentation.disabled}
        data-update-status={updateState.status}
        className={cn(
          'app-update-logo-button app-update-rail-button app-workspace-nav-button relative mx-auto grid h-11 w-11 place-items-center rounded-[14px] p-0',
          (updateState.status === 'checking' || isUpdateCheckPending)
            && 'cursor-wait opacity-80',
        )}
        title={isUpdateConfirmOpen ? undefined : buttonPresentation.title}
        aria-label={buttonPresentation.ariaLabel}
        aria-expanded={isUpdateConfirmOpen}
      >
        <RefreshCw
          className={cn(
            'h-[18px] w-[18px] stroke-[1.9]',
            buttonPresentation.isSpinning && 'animate-spin',
          )}
          aria-hidden="true"
        />
      </button>
      {updateState.status === 'checking' ? (
        <span className="sr-only" role="status">Checking for Kordi updates</span>
      ) : null}
      {isUpdateConfirmOpen ? (
        <SidebarUpdatePopover
          anchor={updateConfirmAnchor}
          popoverRef={updatePopoverRef}
          state={updateState}
          canInstall={Boolean(onInstallUpdate)}
          onClose={() => setIsUpdateConfirmOpen(false)}
          onConfirm={() => {
            void handleConfirmUpdate();
          }}
          onOpenUrl={onOpenUpdateUrl}
        />
      ) : null}
    </>
  );
}
