import { useEffect, useState } from 'react';

import {
  applyCloudLoginWindowSize,
  applyKordiMainWindowSize,
  isMainWindowShown,
  isTauriRuntime,
  readMainWindowShown,
  showMainWindow,
  type CloudGateSurface,
} from './loginWindow';

/** Show the hidden main window even when the first screen is still loading. */
export const MAIN_WINDOW_SHOW_FALLBACK_MS = 1_500;
/** WebKit may hold frames for a hidden window, so painting it never waits longer. */
export const HIDDEN_WINDOW_PAINT_MS = 120;

/** Runs `then` after two frames, or after `fallbackMs` when no frame comes. */
function afterPaint(then: () => void, fallbackMs: number) {
  let frame = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    then();
  };
  const timer = setTimeout(finish, fallbackMs);
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(finish);
  });
  return () => {
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

export function useCloudWindowSurface(surface: CloudGateSurface | 'main' | null) {
  const [settled, setSettled] = useState<typeof surface>(null);
  const [previousSurface, setPreviousSurface] = useState(surface);
  if (surface !== previousSurface) {
    setPreviousSurface(surface);
    setSettled(null);
  }
  useEffect(() => {
    if (isMainWindowShown()) return;
    const timer = setTimeout(() => void showMainWindow(), MAIN_WINDOW_SHOW_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!surface || !isTauriRuntime()) return;
    let disposed = false;
    let frame = 0;
    let cancelPaint: (() => void) | undefined;
    const resize = (hidden: boolean) => {
      if (disposed) return;
      const resized = surface === 'main'
        ? applyKordiMainWindowSize()
        : applyCloudLoginWindowSize(surface);
      void resized.catch(() => undefined).then(() => {
        if (disposed) return;
        if (hidden) {
          // Paint the first screen at its final size, then show the window.
          setSettled(surface);
          cancelPaint = afterPaint(() => void showMainWindow(), HIDDEN_WINDOW_PAINT_MS);
          return;
        }
        // Also settle on failure so a window-manager error cannot trap login.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (!disposed) setSettled(surface);
          });
        });
      });
    };
    void readMainWindowShown().then(shown => {
      if (disposed) return;
      if (!shown) {
        // Nothing is on screen yet, so size the window at once.
        resize(true);
        return;
      }
      // Paint the shared loading surface at the CURRENT size before the native
      // frame starts moving. The content must lead the resize, not follow it.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => resize(false));
      });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelPaint?.();
    };
  }, [surface]);
  return !isTauriRuntime() || settled === surface;
}
