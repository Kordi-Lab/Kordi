import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';
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

export function useSidebarUpdater({
  isNativeShell,
  onCheckForUpdates,
  onInstallUpdate,
  onRetryUpdate,
  onSubscribeToUpdate,
  onOpenUpdateUrl,
}: SidebarUpdaterProps) {
  const updatePopoverRef = useRef<HTMLDivElement | null>(null);
  const updateCheckPromiseRef = useRef<Promise<DesktopUpdaterState> | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdaterState>({ status: 'idle' });
  const updateStateRef = useRef<DesktopUpdaterState>({ status: 'idle' });
  const [isUpdateConfirmOpen, setIsUpdateConfirmOpen] = useState(false);
  const [updateConfirmAnchor, setUpdateConfirmAnchor] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const buttonPresentation = desktopUpdateButtonPresentation(updateState);

  const applyUpdateState = useCallback((nextState: DesktopUpdaterState) => {
    updateStateRef.current = nextState;
    setUpdateState(nextState);
  }, []);

  useEffect(() => {
    if (!onSubscribeToUpdate) return;
    return onSubscribeToUpdate(applyUpdateState);
  }, [applyUpdateState, onSubscribeToUpdate]);

  const runUpdateCheck = useCallback(() => {
    if (!isNativeShell || !onCheckForUpdates) {
      return Promise.resolve<DesktopUpdaterState>({ status: 'idle' });
    }
    if (updateCheckPromiseRef.current) return updateCheckPromiseRef.current;

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
      });
    updateCheckPromiseRef.current = pending;
    return pending;
  }, [applyUpdateState, isNativeShell, onCheckForUpdates]);

  useEffect(() => {
    if (!isNativeShell || !onCheckForUpdates) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void runUpdateCheck();
    });
    return () => {
      active = false;
    };
  }, [isNativeShell, onCheckForUpdates, runUpdateCheck]);

  useEffect(() => {
    if (!isUpdateConfirmOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (updatePopoverRef.current?.contains(target)) return;
      setIsUpdateConfirmOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsUpdateConfirmOpen(false);
    };
    const onResize = () => setIsUpdateConfirmOpen(false);
    window.addEventListener('resize', onResize);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isUpdateConfirmOpen]);

  const handleUpdateButtonClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setUpdateConfirmAnchor({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 288 - 12)),
      bottom: Math.max(12, window.innerHeight - rect.bottom),
    });
    setIsUpdateConfirmOpen(true);
    if (updateState.status === 'idle' || updateState.status === 'up-to-date'
      || (updateState.status === 'failed' && updateState.failureStage === 'check')) {
      void runUpdateCheck();
    }
  };

  const handleConfirmUpdate = async () => {
    if (updateState.status === 'failed' && updateState.failureStage === 'check') {
      await runUpdateCheck();
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

  const enabled = isNativeShell && Boolean(onCheckForUpdates);
  return {
    menuAction: enabled ? {
      updateAvailable: updateState.status === 'available',
      label: buttonPresentation.title,
      onClick: handleUpdateButtonClick,
    } : undefined,
    popover: enabled && isUpdateConfirmOpen ? (
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
    ) : null,
  };
}
