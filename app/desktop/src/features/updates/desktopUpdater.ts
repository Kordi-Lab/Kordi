export const KORDI_MANUAL_UPDATE_URL = 'https://coordinar.io/updates/releases/latest/Kordi.dmg';

export type DesktopUpdaterDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export type DesktopUpdaterUpdate = {
  currentVersion: string;
  version: string;
  body?: string;
  date?: string;
  downloadAndInstall(listener?: (event: DesktopUpdaterDownloadEvent) => void): Promise<void>;
  close?(): Promise<void>;
};

export type DesktopUpdaterAdapter = {
  check(): Promise<DesktopUpdaterUpdate | null>;
  relaunch(): Promise<void>;
};

export type DesktopUpdaterStatus =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'relaunching'
  | 'failed';

export type DesktopUpdaterState = {
  status: DesktopUpdaterStatus;
  currentVersion?: string;
  latestVersion?: string;
  notes?: string;
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
  manualDownloadUrl?: string;
};

type DesktopUpdaterControllerOptions = {
  adapter: DesktopUpdaterAdapter;
  isTauriRuntime: () => boolean;
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unable to install the signed Kordi update.';
}

function stateForUpdate(
  status: DesktopUpdaterStatus,
  update: DesktopUpdaterUpdate,
  extra: Partial<DesktopUpdaterState> = {},
): DesktopUpdaterState {
  return {
    status,
    currentVersion: update.currentVersion,
    latestVersion: update.version,
    notes: update.body,
    manualDownloadUrl: KORDI_MANUAL_UPDATE_URL,
    ...extra,
  };
}

export function createDesktopUpdaterController(options: DesktopUpdaterControllerOptions) {
  let state: DesktopUpdaterState = { status: 'idle' };
  let checkedUpdate: DesktopUpdaterUpdate | null = null;
  let installPromise: Promise<void> | null = null;
  const listeners = new Set<(nextState: DesktopUpdaterState) => void>();

  const publish = (nextState: DesktopUpdaterState) => {
    state = nextState;
    for (const listener of listeners) listener(state);
  };

  const closeCheckedUpdate = async () => {
    const previous = checkedUpdate;
    checkedUpdate = null;
    if (previous?.close) await previous.close();
  };

  const check = async () => {
    if (!options.isTauriRuntime()) {
      publish({ status: 'idle' });
      return state;
    }
    try {
      await closeCheckedUpdate();
      const update = await options.adapter.check();
      if (!update) {
        publish({ status: 'idle' });
        return state;
      }
      checkedUpdate = update;
      publish(stateForUpdate('available', update));
      return state;
    } catch {
      checkedUpdate = null;
      publish({ status: 'idle' });
      return state;
    }
  };

  const install = () => {
    if (installPromise) return installPromise;
    const update = checkedUpdate;
    if (!update) return Promise.reject(new Error('No checked Kordi update is available.'));

    let receivedBytes = 0;
    publish(stateForUpdate('downloading', update, { receivedBytes }));
    installPromise = (async () => {
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            receivedBytes = 0;
            publish(stateForUpdate('downloading', update, {
              receivedBytes,
              totalBytes: event.data.contentLength,
            }));
          } else if (event.event === 'Progress') {
            receivedBytes += event.data.chunkLength;
            publish(stateForUpdate('downloading', update, {
              receivedBytes,
              totalBytes: state.totalBytes,
            }));
          } else {
            publish(stateForUpdate('installing', update, {
              receivedBytes,
              totalBytes: state.totalBytes,
            }));
          }
        });
        publish(stateForUpdate('installing', update, {
          receivedBytes,
          totalBytes: state.totalBytes,
        }));
        publish(stateForUpdate('relaunching', update, {
          receivedBytes,
          totalBytes: state.totalBytes,
        }));
        await options.adapter.relaunch();
      } catch (error) {
        publish(stateForUpdate('failed', update, {
          receivedBytes,
          totalBytes: state.totalBytes,
          error: errorMessage(error),
        }));
        throw error;
      } finally {
        installPromise = null;
      }
    })();
    return installPromise;
  };

  return {
    check,
    install,
    retry: install,
    getState: () => state,
    getCheckedUpdate: () => checkedUpdate,
    subscribe(listener: (nextState: DesktopUpdaterState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      await closeCheckedUpdate();
      publish({ status: 'idle' });
    },
  };
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

export const tauriDesktopUpdaterAdapter: DesktopUpdaterAdapter = {
  async check() {
    const updater = await import('@tauri-apps/plugin-updater');
    return updater.check();
  },
  async relaunch() {
    const processPlugin = await import('@tauri-apps/plugin-process');
    await processPlugin.relaunch();
  },
};

export const desktopUpdaterController = createDesktopUpdaterController({
  adapter: tauriDesktopUpdaterAdapter,
  isTauriRuntime,
});
