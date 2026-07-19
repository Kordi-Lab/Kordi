const KORDI_RELEASE_ORIGIN = 'https://coordinar.io';
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

export function manualUpdateUrlForVersion(version: string | undefined) {
  if (!version || !BETA_VERSION.test(version)) return undefined;
  const encoded = encodeURIComponent(version);
  return `${KORDI_RELEASE_ORIGIN}/updates/releases/${encoded}/Kordi_${encoded}_aarch64.dmg`;
}

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
  currentVersion?(): Promise<string>;
  relaunch(): Promise<void>;
};

export type DesktopUpdaterStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
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
  failureStage?: 'check' | 'install';
};

type DesktopUpdaterControllerOptions = {
  adapter: DesktopUpdaterAdapter;
  isTauriRuntime: () => boolean;
};

function updaterErrorText(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return null;
}

const UPDATER_NETWORK_ERROR = /(?:error sending request|failed to (?:send|download)|network (?:connection )?(?:was )?lost|connection (?:error|reset|closed|refused)|request (?:timed out|timeout)|timed out|could not resolve|failed to lookup|dns error)/i;
const UPDATER_VERIFICATION_ERROR = /(?:signature|verification failed|could not verify)/i;
const UPDATER_PERMISSION_ERROR = /(?:permission denied|operation not permitted|access is denied)/i;

export function desktopUpdaterInstallErrorMessage(error: unknown) {
  const message = updaterErrorText(error);
  if (!message) return 'Unable to install the verified Kordi update.';
  if (UPDATER_NETWORK_ERROR.test(message)) {
    return 'Download interrupted. Check your connection and try again.';
  }
  if (UPDATER_VERIFICATION_ERROR.test(message)) {
    return 'Kordi could not verify this update. Download it manually instead.';
  }
  if (UPDATER_PERMISSION_ERROR.test(message)) {
    return 'Kordi needs permission to replace the app. Download it manually instead.';
  }
  return message;
}

export function desktopUpdaterCheckErrorMessage(error: unknown) {
  const message = updaterErrorText(error);
  if (!message || UPDATER_NETWORK_ERROR.test(message)) {
    return 'Unable to reach the update server. Check your connection and try again.';
  }
  return message;
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
    manualDownloadUrl: manualUpdateUrlForVersion(update.version),
    ...extra,
  };
}

export function createDesktopUpdaterController(options: DesktopUpdaterControllerOptions) {
  let state: DesktopUpdaterState = { status: 'idle' };
  let checkedUpdate: DesktopUpdaterUpdate | null = null;
  let checkPromise: Promise<DesktopUpdaterState> | null = null;
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

  const readCurrentVersion = async () => {
    try {
      const version = await options.adapter.currentVersion?.();
      return version?.trim() || state.currentVersion;
    } catch {
      return state.currentVersion;
    }
  };

  const check = () => {
    if (checkPromise) return checkPromise;
    if (!options.isTauriRuntime()) {
      publish({ status: 'idle' });
      return Promise.resolve(state);
    }
    if (installPromise) return Promise.resolve(state);

    const previousState = state;
    publish({
      status: 'checking',
      currentVersion: previousState.currentVersion,
    });

    checkPromise = (async () => {
      const currentVersionPromise = readCurrentVersion();
      try {
        await closeCheckedUpdate();
        const update = await options.adapter.check();
        if (!update) {
          publish({
            status: 'up-to-date',
            currentVersion: await currentVersionPromise,
          });
          return state;
        }
        checkedUpdate = update;
        publish(stateForUpdate('available', update));
        return state;
      } catch (error) {
        checkedUpdate = null;
        publish({
          status: 'failed',
          currentVersion: (await currentVersionPromise) ?? previousState.currentVersion,
          ...(previousState.latestVersion ? { latestVersion: previousState.latestVersion } : {}),
          ...(previousState.manualDownloadUrl ? { manualDownloadUrl: previousState.manualDownloadUrl } : {}),
          failureStage: 'check',
          error: desktopUpdaterCheckErrorMessage(error),
        });
        return state;
      } finally {
        checkPromise = null;
      }
    })();

    return checkPromise;
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
          failureStage: 'install',
          error: desktopUpdaterInstallErrorMessage(error),
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
    retry() {
      if (state.status === 'failed' && state.failureStage === 'check') return check();
      return install();
    },
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
  async currentVersion() {
    const app = await import('@tauri-apps/api/app');
    return app.getVersion();
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
