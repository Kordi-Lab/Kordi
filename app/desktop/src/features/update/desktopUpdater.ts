export const KORDI_RELEASES_URL = 'https://github.com/Kordi-AI/Kordi/releases';

export type DesktopUpdateProgress = {
  downloaded: number;
  total: number | null;
};

export type DesktopUpdateInfo = {
  available: boolean;
  version?: string | null;
  currentVersion?: string | null;
  body?: string | null;
};

export type DesktopUpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version?: string | null; currentVersion?: string | null; body?: string | null }
  | { kind: 'downloading'; version?: string | null; downloaded: number; total: number | null; percent: number | null }
  | { kind: 'installing'; version?: string | null }
  | { kind: 'ready'; version?: string | null }
  | { kind: 'restarting' }
  | { kind: 'failed'; message: string; fallbackUrl: string };

export type DesktopUpdateAdapter = {
  isAvailable: boolean;
  check?: () => Promise<DesktopUpdateInfo | null>;
  install?: (update: DesktopUpdateInfo, onProgress: (progress: DesktopUpdateProgress) => void) => Promise<void>;
  relaunch?: () => Promise<void>;
};

export type DesktopUpdateController = {
  state: () => DesktopUpdateState;
  check: () => Promise<DesktopUpdateState>;
  install: () => Promise<DesktopUpdateState>;
  restart: () => Promise<DesktopUpdateState>;
  reset: () => DesktopUpdateState;
};

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false;
  return typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Update failed.';
}

function progressState(update: DesktopUpdateInfo, progress: DesktopUpdateProgress): DesktopUpdateState {
  const downloaded = Math.max(0, progress.downloaded);
  const total = typeof progress.total === 'number' && Number.isFinite(progress.total) && progress.total > 0
    ? progress.total
    : null;
  return {
    kind: 'downloading',
    version: update.version,
    downloaded,
    total,
    percent: total ? Math.min(100, Math.max(0, Math.round((downloaded / total) * 100))) : null,
  };
}

export function createDesktopUpdateController(input: {
  adapter?: DesktopUpdateAdapter;
  isAvailable?: boolean;
  onStateChange?: (state: DesktopUpdateState) => void;
} = {}): DesktopUpdateController {
  const adapter = input.adapter ?? defaultDesktopUpdateAdapter();
  const available = input.isAvailable ?? adapter.isAvailable;
  let current: DesktopUpdateState = { kind: 'idle' };
  let availableUpdate: DesktopUpdateInfo | null = null;

  const setState = (state: DesktopUpdateState) => {
    current = state;
    input.onStateChange?.(state);
    return state;
  };

  return {
    state: () => current,
    async check() {
      setState({ kind: 'checking' });
      if (!available || !adapter.check) return setState({ kind: 'idle' });
      try {
        const update = await adapter.check();
        availableUpdate = update?.available ? update : null;
        if (!availableUpdate) return setState({ kind: 'idle' });
        return setState({
          kind: 'available',
          version: availableUpdate.version,
          currentVersion: availableUpdate.currentVersion,
          body: availableUpdate.body,
        });
      } catch {
        return setState({ kind: 'idle' });
      }
    },
    async install() {
      if (!available || !adapter.install) return setState({ kind: 'failed', message: 'In-app updates are not available in this build.', fallbackUrl: KORDI_RELEASES_URL });
      const update = availableUpdate ?? await adapter.check?.();
      if (!update?.available) return setState({ kind: 'idle' });
      availableUpdate = update;
      try {
        await adapter.install(update, (progress) => setState(progressState(update, progress)));
        setState({ kind: 'installing', version: update.version });
        return setState({ kind: 'ready', version: update.version });
      } catch (error) {
        return setState({ kind: 'failed', message: errorMessage(error), fallbackUrl: KORDI_RELEASES_URL });
      }
    },
    async restart() {
      setState({ kind: 'restarting' });
      await adapter.relaunch?.();
      return current;
    },
    reset() {
      availableUpdate = null;
      return setState({ kind: 'idle' });
    },
  };
}

export function defaultDesktopUpdateAdapter(): DesktopUpdateAdapter {
  return {
    isAvailable: isNativeDesktopShell(),
    async check() {
      const updater = await import('@tauri-apps/plugin-updater');
      const update = await updater.check();
      if (!update) return { available: false };
      return {
        available: true,
        version: update.version,
        currentVersion: update.currentVersion,
        body: update.body,
      };
    },
    async install(_update, onProgress) {
      const updater = await import('@tauri-apps/plugin-updater');
      const update = await updater.check();
      if (!update) return;
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          downloaded = 0;
          onProgress({ downloaded, total });
          return;
        }
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          onProgress({ downloaded, total });
        }
      });
    },
    async relaunch() {
      const process = await import('@tauri-apps/plugin-process');
      await process.relaunch();
    },
  };
}
