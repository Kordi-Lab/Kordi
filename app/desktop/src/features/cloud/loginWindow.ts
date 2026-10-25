import { INTERFACE_ZOOM_EVENT, readAppliedInterfaceZoom } from '@/app/interfaceZoom';
import { createWindowSizeCoordinator } from './windowSizeCoordinator';

export type CloudLoginMode = 'login' | 'signup';

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

/** How far the web view extends past the window's left and top edges, in points. */
export type AuthWindowCrop = { x: number; y: number };

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
}

function normalizeAuthWindowCrop(value: unknown): AuthWindowCrop | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { x, y } = value as Partial<AuthWindowCrop>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

/** Records a crop reported by the native side; ignores missing values. */
export function applyAuthWindowCrop(value: unknown) {
  const next = normalizeAuthWindowCrop(value);
  if (!next) return;
  const changed = next.x !== authWindowCrop.x || next.y !== authWindowCrop.y;
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

const resizeNativeWindow = createWindowSizeCoordinator(async (surface: CloudLoginMode | 'main') => {
  listenForAuthWindowCrop();
  const { invoke } = await import('@tauri-apps/api/core');
  const crop = await invoke<AuthWindowCrop | undefined>('desktop_set_auth_window_surface', {
    surface,
    animate: !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  });
  applyAuthWindowCrop(crop);
});

export async function applyCloudLoginWindowSize(mode: CloudLoginMode) {
  if (isTauriRuntime()) await resizeNativeWindow(mode);
}

export async function applyKordiMainWindowSize() {
  if (isTauriRuntime()) await resizeNativeWindow('main');
}
