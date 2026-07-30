import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';

export function desktopUpdateButtonPresentation(
  state: DesktopUpdaterState,
  isCheckPending = false,
) {
  const isChecking = state.status === 'checking' || isCheckPending;
  return {
    disabled: isChecking,
    isSpinning: isChecking,
    title: isChecking
      ? 'Checking for updates…'
      : state.status === 'available'
        ? `Kordi ${state.latestVersion ?? 'update'} is available`
        : state.status === 'failed'
          ? 'Open update details'
          : 'Check for updates',
    ariaLabel: isChecking ? 'Checking for Kordi updates' : 'Check for Kordi updates',
  };
}
