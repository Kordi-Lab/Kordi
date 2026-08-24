import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';

export function desktopUpdateButtonPresentation(
  state: DesktopUpdaterState,
) {
  const visible = state.status === 'available'
    || state.status === 'downloading'
    || state.status === 'installing'
    || state.status === 'relaunching'
    || (state.status === 'failed' && state.failureStage === 'install');
  const version = state.latestVersion ? ` ${state.latestVersion}` : '';
  return {
    visible,
    title: state.status === 'available'
      ? `Kordi${version} is ready — open update options`
      : state.status === 'downloading'
        ? `Downloading Kordi${version}…`
        : state.status === 'installing'
          ? `Installing Kordi${version}…`
          : state.status === 'relaunching'
            ? 'Relaunching Kordi…'
            : 'Kordi update needs attention',
  };
}
