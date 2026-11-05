import { INTERFACE_ZOOM_EVENT, readAppliedInterfaceZoom } from '@/app/interfaceZoom';
import { createWindowSizeCoordinator } from './windowSizeCoordinator';

export type CloudLoginMode = 'login' | 'signup';

/** Signed-out window surfaces: the compact browser sign-in window or the in-app form. */
export type CloudGateSurface = CloudLoginMode | 'welcome';

/** The compact browser sign-in window, with the native material behind it on macOS. */
export const CLOUD_WELCOME_WINDOW_SIZE = { width: 440, height: 480 } as const;

export const CLOUD_LOGIN_WINDOW_SIZE = {
  width: 760,
  loginHeight: 760,
  signupHeight: 860,
  minWidth: 620,
  minHeight: 640,
} as const;

export const KORDI_MAIN_WINDOW_SIZE = {
  width: 1480,
  height: 980,
  minWidth: 1192,
  minHeight: 760,
} as const;

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

/**
 * How far the web view extends past the window's left and top edges, in points,
 * and the window's content size when the native side reports it.
 */
export type AuthWindowCrop = { x: number; y: number; width?: number; height?: number };

const AUTH_WINDOW_CROP_EVENT = 'kordi://auth-window-crop';
let authWindowCrop: AuthWindowCrop = { x: 0, y: 0 };
const authWindowCropListeners = new Set<(crop: AuthWindowCrop) => void>();
let authWindowCropListening = false;

export function readAuthWindowCrop(): AuthWindowCrop {
  return authWindowCrop;
}

/** The crop in CSS pixels, for comparing with client coordinates. */
export function readAuthWindowCropOffset(): AuthWindowCrop {
  const zoom = readAppliedInterfaceZoom();
  return { x: authWindowCrop.x / zoom, y: authWindowCrop.y / zoom };
}

export function subscribeAuthWindowCrop(listener: (crop: AuthWindowCrop) => void) {
  authWindowCropListeners.add(listener);
  return () => { authWindowCropListeners.delete(listener); };
}

function paintAuthWindowCrop() {
  if (typeof document === 'undefined') return;
  const { x, y } = readAuthWindowCropOffset();
  const style = document.documentElement.style;
  style.setProperty('--app-gate-crop-x', `${x}px`);
  style.setProperty('--app-gate-crop-y', `${y}px`);
  // The visible window rectangle, so gate screens need not trust the shell size.
  const zoom = readAppliedInterfaceZoom();
  for (const [name, value] of [['width', authWindowCrop.width], ['height', authWindowCrop.height]] as const) {
    if (value) style.setProperty(`--app-gate-window-${name}`, `${value / zoom}px`);
    else style.removeProperty(`--app-gate-window-${name}`);
  }
}

function positiveSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeAuthWindowCrop(value: unknown): AuthWindowCrop | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { x, y, width, height } = value as Partial<Record<keyof AuthWindowCrop, unknown>>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const crop: AuthWindowCrop = { x: Math.max(0, x), y: Math.max(0, y) };
  const visibleWidth = positiveSize(width);
  const visibleHeight = positiveSize(height);
  if (visibleWidth && visibleHeight) {
    crop.width = visibleWidth;
    crop.height = visibleHeight;
  }
  return crop;
}

/** Records a crop reported by the native side; ignores missing values. */
export function applyAuthWindowCrop(value: unknown) {
  const next = normalizeAuthWindowCrop(value);
  if (!next) return;
  const changed = next.x !== authWindowCrop.x || next.y !== authWindowCrop.y
    || next.width !== authWindowCrop.width || next.height !== authWindowCrop.height;
  authWindowCrop = next;
  paintAuthWindowCrop();
  if (changed) authWindowCropListeners.forEach(listener => listener(next));
}

function listenForAuthWindowCrop() {
  if (authWindowCropListening || !isTauriRuntime()) return;
  authWindowCropListening = true;
  globalThis.addEventListener?.(INTERFACE_ZOOM_EVENT, paintAuthWindowCrop);
  let pending: unknown;
  let frame: number | undefined;
  void import('@tauri-apps/api/event').then(({ listen }) => listen(AUTH_WINDOW_CROP_EVENT, ({ payload }) => {
    pending = payload;
    if (frame !== undefined) return;
    frame = globalThis.requestAnimationFrame(() => {
      frame = undefined;
      applyAuthWindowCrop(pending);
    });
  })).catch(() => { authWindowCropListening = false; });
}

// The main window starts hidden (tauri.conf.json), so its bare frame never
// shows before the first screen paints. A reload (account switch, update
// relaunch, a dock click during load) may find it on screen already, so the
// page asks the native window instead of assuming. `null` means not known yet.
let mainWindowShown: boolean | null = null;
let mainWindowShownProbe: Promise<boolean> | undefined;

/** Whether the main window is known to be on screen; always true outside the native shell. */
export function isMainWindowShown() {
  return mainWindowShown === true || !isTauriRuntime();
}

/** Reads whether the main window is on screen, asking the native window once. */
export function readMainWindowShown(): Promise<boolean> {
  if (!isTauriRuntime()) return Promise.resolve(true);
  if (mainWindowShown !== null) return Promise.resolve(mainWindowShown);
  mainWindowShownProbe ??= import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().isVisible())
    // Unknown: take the hidden path; showing the window again is harmless.
    .catch(() => false)
    .then(visible => (mainWindowShown ??= visible));
  return mainWindowShownProbe;
}

export async function showMainWindow() {
  await readMainWindowShown();
  if (isMainWindowShown()) return;
  mainWindowShown = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('desktop_reveal_main_window');
  } catch {
    // The native side shows the window on its own after a delay.
  }
}

/** `null` makes the next read ask the native window. */
export function __setMainWindowShownForTests(shown: boolean | null) {
  mainWindowShown = shown;
  mainWindowShownProbe = undefined;
}

const resizeNativeWindow = createWindowSizeCoordinator(async (surface: CloudGateSurface | 'main') => {
  listenForAuthWindowCrop();
  const { invoke } = await import('@tauri-apps/api/core');
  const crop = await invoke<AuthWindowCrop | undefined>('desktop_set_auth_window_surface', {
    surface,
    // A hidden window takes its first size at once.
    animate: isMainWindowShown() && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  });
  applyAuthWindowCrop(crop);
});

export async function applyCloudLoginWindowSize(surface: CloudGateSurface) {
  if (isTauriRuntime()) await resizeNativeWindow(surface);
}

/** The welcome window shows the macOS material through a transparent page. */
export function supportsFrostedGate(runtime: typeof globalThis = globalThis) {
  const platform = runtime.navigator?.platform ?? '';
  return isTauriRuntime(runtime) && /Mac/.test(platform);
}

export async function applyKordiMainWindowSize() {
  if (isTauriRuntime()) await resizeNativeWindow('main');
}
