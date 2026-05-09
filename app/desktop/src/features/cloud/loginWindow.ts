export type CloudLoginMode = 'login' | 'signup';

export const CLOUD_LOGIN_WINDOW_SIZE = {
  width: 760,
  loginHeight: 760,
  signupHeight: 900,
  minWidth: 620,
  minHeight: 640,
} as const;

export const KORDI_MAIN_WINDOW_SIZE = {
  width: 1480,
  height: 980,
  minWidth: 1192,
  minHeight: 760,
} as const;

type LogicalSizeConstructor = new (width: number, height: number) => unknown;
type NativeWindowHandle = {
  setMinSize(size: unknown): Promise<void>;
  setSize(size: unknown): Promise<void>;
  center(): Promise<void>;
  setResizable?(resizable: boolean): Promise<void>;
};
type NativeWindowDeps = {
  getCurrentWindow(): NativeWindowHandle;
  LogicalSize: LogicalSizeConstructor;
};

export function cloudLoginWindowSizeForMode(mode: CloudLoginMode) {
  return {
    width: CLOUD_LOGIN_WINDOW_SIZE.width,
    height: mode === 'signup' ? CLOUD_LOGIN_WINDOW_SIZE.signupHeight : CLOUD_LOGIN_WINDOW_SIZE.loginHeight,
    minWidth: CLOUD_LOGIN_WINDOW_SIZE.minWidth,
    minHeight: CLOUD_LOGIN_WINDOW_SIZE.minHeight,
  };
}

export function isTauriRuntime(runtime: (typeof globalThis & { __TAURI_INTERNALS__?: unknown }) = globalThis) {
  return Boolean(runtime.__TAURI_INTERNALS__);
}

async function nativeWindowDeps(): Promise<NativeWindowDeps | null> {
  if (!isTauriRuntime()) return null;
  const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/dpi'),
  ]);
  return { getCurrentWindow, LogicalSize };
}

export async function applyCloudLoginWindowSize(mode: CloudLoginMode, deps?: NativeWindowDeps) {
  const resolvedDeps = deps ?? await nativeWindowDeps();
  if (!resolvedDeps) return;

  const size = cloudLoginWindowSizeForMode(mode);
  const window = resolvedDeps.getCurrentWindow();
  await window.setResizable?.(false);
  await window.setMinSize(new resolvedDeps.LogicalSize(size.minWidth, size.minHeight));
  await window.setSize(new resolvedDeps.LogicalSize(size.width, size.height));
  await window.center();
}

export async function applyKordiMainWindowSize(deps?: NativeWindowDeps) {
  const resolvedDeps = deps ?? await nativeWindowDeps();
  if (!resolvedDeps) return;

  const window = resolvedDeps.getCurrentWindow();
  await window.setResizable?.(true);
  await window.setMinSize(new resolvedDeps.LogicalSize(KORDI_MAIN_WINDOW_SIZE.minWidth, KORDI_MAIN_WINDOW_SIZE.minHeight));
  await window.setSize(new resolvedDeps.LogicalSize(KORDI_MAIN_WINDOW_SIZE.width, KORDI_MAIN_WINDOW_SIZE.height));
  await window.center();
}
