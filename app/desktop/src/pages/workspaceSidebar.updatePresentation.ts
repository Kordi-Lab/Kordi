import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';

export function desktopUpdateButtonPresentation(state: DesktopUpdaterState) {
  const title = state.status === 'available'
    ? 'Update available'
    : state.status === 'checking'
      ? 'Checking for updates…'
      : state.status === 'downloading'
        ? 'Downloading update…'
        : state.status === 'installing'
          ? 'Installing update…'
          : state.status === 'relaunching'
            ? 'Relaunching Kordi…'
            : state.status === 'failed' && state.failureStage === 'install'
              ? 'Retry update'
              : 'Check for updates';
  return { title };
}
