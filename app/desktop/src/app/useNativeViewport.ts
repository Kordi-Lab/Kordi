import { useLayoutEffect } from 'react';
import { isTauriRuntime } from '@/features/cloud/loginWindow';

/** Native geometry drives layout dimensions only; content is never scaled. */
export function useNativeViewport() {
  useLayoutEffect(() => {
    if (!isTauriRuntime()) return;
    const style = document.documentElement.style;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const apply = (width: number, height: number) => {
      if (disposed || width <= 0 || height <= 0) return;
      style.setProperty('--app-native-width', `${width}px`);
      style.setProperty('--app-native-height', `${height}px`);
    };
    apply(window.innerWidth, window.innerHeight);
    // Native resize events carry the new client size even when WebKit's
    // viewport-unit update is one presentation behind the moving window.
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onResized(({ payload }) => {
        const scale = window.devicePixelRatio || 1;
        apply(payload.width / scale, payload.height / scale);
      });
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      style.removeProperty('--app-native-width');
      style.removeProperty('--app-native-height');
    };
  }, []);
}
