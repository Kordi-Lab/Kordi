import { useLayoutEffect } from 'react';
import { isTauriRuntime, subscribeAuthWindowCrop } from '@/features/cloud/loginWindow';
import { INTERFACE_ZOOM_EVENT, readAppliedInterfaceZoom } from './interfaceZoom';

/** Convert native client dimensions to the current page's layout coordinates. */
export function useNativeViewport() {
  useLayoutEffect(() => {
    if (!isTauriRuntime()) return;
    const style = document.documentElement.style;
    let disposed = false;
    const unlisten: (() => void)[] = [];
    let nativeScale = window.devicePixelRatio || 1;
    let hasScaleEvent = false;
    let measurementRevision = 0;
    let latestPhysicalSize: { width: number; height: number } | undefined;
    let clientWidth = window.innerWidth * readAppliedInterfaceZoom();
    let clientHeight = window.innerHeight * readAppliedInterfaceZoom();
    const paint = () => {
      const zoom = readAppliedInterfaceZoom();
      const width = clientWidth / zoom;
      const height = clientHeight / zoom;
      if (disposed || width <= 0 || height <= 0) return;
      style.setProperty('--app-native-width', `${width}px`);
      style.setProperty('--app-native-height', `${height}px`);
    };
    const applyPhysicalSize = (size: { width: number; height: number }) => {
      measurementRevision++;
      latestPhysicalSize = size;
      clientWidth = size.width / nativeScale;
      clientHeight = size.height / nativeScale;
      paint();
    };
    paint();
    window.addEventListener(INTERFACE_ZOOM_EVENT, paint);
    // Native resize events carry the new client size even when WebKit's
    // viewport-unit update is one presentation behind the moving window.
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const nativeWindow = getCurrentWindow();
      for (const subscribe of [
        () => nativeWindow.onResized(({ payload }) => applyPhysicalSize(payload)),
        () => nativeWindow.onScaleChanged(({ payload }) => {
          hasScaleEvent = true;
          nativeScale = payload.scaleFactor;
          applyPhysicalSize(payload.size);
        }),
      ]) {
        const stop = await subscribe();
        if (disposed) { stop(); return; }
        unlisten.push(stop);
      }
      const [scale, size] = await Promise.all([nativeWindow.scaleFactor(), nativeWindow.innerSize()]);
      if (disposed) return;
      // Resize and monitor changes may arrive while the initial query is pending.
      if (!hasScaleEvent) nativeScale = scale;
      applyPhysicalSize(latestPhysicalSize ?? size);
      // Docking the inspector or reattaching the webview changes its frame
      // without resizing the native window. Re-query native dimensions on
      // webview resize; browser viewport metrics can lag behind native events.
      const refreshSize = () => {
        const revision = ++measurementRevision;
        void nativeWindow.innerSize().then(next => {
          if (!disposed && revision === measurementRevision) applyPhysicalSize(next);
        }).catch(() => undefined);
      };
      window.addEventListener('resize', refreshSize);
      unlisten.push(() => window.removeEventListener('resize', refreshSize));
      unlisten.push(subscribeAuthWindowCrop(refreshSize));
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten.forEach(stop => stop());
      window.removeEventListener(INTERFACE_ZOOM_EVENT, paint);
      style.removeProperty('--app-native-width');
      style.removeProperty('--app-native-height');
    };
  }, []);
}
