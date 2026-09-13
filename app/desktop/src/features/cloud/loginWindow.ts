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

const resizeNativeWindow = createWindowSizeCoordinator(async (surface: CloudLoginMode | 'main') => {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('desktop_set_auth_window_surface', {
    surface,
    animate: !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  });
});

export async function applyCloudLoginWindowSize(mode: CloudLoginMode) {
  if (isTauriRuntime()) await resizeNativeWindow(mode);
}

export async function applyKordiMainWindowSize() {
  if (isTauriRuntime()) await resizeNativeWindow('main');
}
