import { useEffect, useState } from 'react';

import { applyCloudLoginWindowSize, applyKordiMainWindowSize, isTauriRuntime, type CloudLoginMode } from './loginWindow';

export function useCloudWindowSurface(surface: CloudLoginMode | 'main' | null) {
  const [settled, setSettled] = useState<typeof surface>(null);
  const [previousSurface, setPreviousSurface] = useState(surface);
  if (surface !== previousSurface) {
    setPreviousSurface(surface);
    setSettled(null);
  }
  useEffect(() => {
    if (!surface || !isTauriRuntime()) return;
    let disposed = false;
    let frame = 0;
    // Paint the shared loading surface at the CURRENT size before the native
    // frame starts moving. The content must lead the resize, not follow it.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const resize = surface === 'main'
          ? applyKordiMainWindowSize()
          : applyCloudLoginWindowSize(surface);
        void resize.catch(() => undefined).then(() => {
          if (disposed) return;
          // Also settle on failure so a window-manager error cannot trap login.
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
              if (!disposed) setSettled(surface);
            });
          });
        });
      });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [surface]);
  return !isTauriRuntime() || settled === surface;
}
