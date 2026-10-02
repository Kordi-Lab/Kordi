import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export const INTERFACE_ZOOM_STORAGE_KEY = 'kordi.interfaceZoom.v1';
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.6;

export function readStoredInterfaceZoom(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const value = Number((storage ?? window.localStorage).getItem(INTERFACE_ZOOM_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) : 1;
  } catch {
    return 1;
  }
}

export function interfaceZoomForShortcut(current: number, key: string): number | null {
  if (key === '0') return 1;
  const direction = key === '+' || key === '=' ? 1 : key === '-' || key === '_' ? -1 : 0;
  return direction ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((current + direction * 0.1) * 10) / 10)) : null;
}

/** Native page zoom resizes text and controls without transforming hit targets. */
export function useInterfaceZoom(isNativeShell: boolean) {
  useEffect(() => {
    if (!isNativeShell) return;
    let zoom = readStoredInterfaceZoom();
    const apply = (next: number) => {
      zoom = next;
      void getCurrentWebview().setZoom(next).then(() => {
        document.documentElement.dataset.kordiInterfaceZoom = String(next);
      }).catch(() => undefined);
    };
    apply(zoom);
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const next = interfaceZoomForShortcut(zoom, event.key);
      if (next === null) return;
      event.preventDefault();
      apply(next);
      try { window.localStorage.setItem(INTERFACE_ZOOM_STORAGE_KEY, String(next)); } catch { /* Keep resizing available without storage. */ }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === INTERFACE_ZOOM_STORAGE_KEY) apply(readStoredInterfaceZoom());
    };
    document.addEventListener('keydown', handleKey);
    window.addEventListener('storage', handleStorage);
    return () => {
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('storage', handleStorage);
    };
  }, [isNativeShell]);
}
