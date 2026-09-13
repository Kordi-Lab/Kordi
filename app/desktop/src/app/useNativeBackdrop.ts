import { useLayoutEffect, useRef } from 'react';
import { isTauriRuntime } from '@/features/cloud/loginWindow';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';

export function useNativeBackdrop(isNativeShell: boolean, theme: string, sidebarWidth: number) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!isNativeShell || !root.current || !isTauriRuntime()) return;
    const element = root.current;
    // Resolve the existing CSS palette (including oklch) to sRGB for AppKit.
    // This converts two palette colors, never page content.
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return;
    let disposed = false;
    let previousColor = '';
    const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const sync = () => {
      const styles = getComputedStyle(element);
      const wallpaper = element.querySelector('.app-chat-theme-surface');
      const color = wallpaper
        ? getComputedStyle(wallpaper).backgroundColor
        : styles.getPropertyValue('--app-native-main-bg').trim();
      const sessions = styles.getPropertyValue(transparency.matches ? '--app-native-session-fallback' : '--app-native-session-bg').trim();
      const colors = [color, sessions];
      const signature = colors.join('|');
      if (colors.some(value => !value) || signature === previousColor) return;
      previousColor = signature;
      context.clearRect(0, 0, 2, 1);
      colors.forEach((value, index) => {
        context.fillStyle = value;
        context.fillRect(index, 0, 1, 1);
      });
      const pixel = context.getImageData(0, 0, 2, 1).data;
      const background = [pixel[0], pixel[1], pixel[2]];
      const sessionBackground = Array.from(pixel.slice(4, 8));
      void import('@tauri-apps/api/core').then(async ({ invoke }) => {
        if (disposed) return;
        await invoke('desktop_set_window_backdrop', { sidebarWidth, background, navigationWidth: LEFT_RAIL_WIDTH, sessionBackground });
        if (!disposed) element.dataset.nativeBackdrop = 'ready';
      }).catch(() => undefined);
    };
    sync();
    // Page switches replace the content plane; chat themes change on <body>.
    // Text streaming and viewport style updates do not trigger this observer.
    const observer = new MutationObserver(sync);
    observer.observe(element, { childList: true, subtree: true });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-kordi-chat-theme'] });
    transparency.addEventListener('change', sync);
    return () => { disposed = true; observer.disconnect(); transparency.removeEventListener('change', sync); };
  }, [isNativeShell, theme, sidebarWidth]);
  return root;
}
