import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useLayoutEffect, useState, type MouseEventHandler, type ReactNode } from 'react';

import { syncNativeWindowTheme } from '@/app/nativeWindowTheme';
import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';
import { shouldStartNativeWindowDrag } from '@/app/windowDrag';
import { isTauriRuntime, readAuthWindowCropOffset } from '@/features/cloud/loginWindow';
import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';

function readSystemTheme(): ResolvedThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function nativeWindowThemeIsResolvedTheme(theme: unknown): theme is ResolvedThemeMode {
  return theme === 'light' || theme === 'dark';
}

const GATE_WINDOW_BACKGROUND: Record<ResolvedThemeMode, string> = {
  light: '#f8fafc',
  dark: '#0f1115',
};

const APP_WINDOW_BACKGROUND: Record<ResolvedThemeMode, string> = {
  light: '#f4f1e7',
  dark: '#22231d',
};

// The frosted welcome window shows the native material through the page.
const FROSTED_GATE_WINDOW_BACKGROUND = '#00000000';

// The shell's useKordiUiEffects also writes `theme-*` to <body>, but it only
// runs after KordiAppShell mounts. Before that — on the cloud login gate and
// the restoring-session splash — nothing else applies a theme class, so the
// dark/light tokens never reach those screens. This hook syncs the body class
// to the persisted theme preference; `auto` follows system while the
// gate/splash is up. Once the shell mounts, its effect takes over.
function useGateThemeClass(active: boolean, frosted = false) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [theme, setTheme] = useState<ResolvedThemeMode>(() => {
    return resolveThemeMode(themeMode, readSystemTheme());
  });

  const [previousActive, setPreviousActive] = useState(active);
  if (active !== previousActive) {
    setPreviousActive(active);
    if (active) {
      const nextMode = readStoredThemeMode();
      setThemeMode(nextMode);
      setTheme(resolveThemeMode(nextMode, readSystemTheme()));
    }
  }

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlistenNativeTheme: (() => void) | undefined;
    const mediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)')
      : null;
    const applySystemTheme = (systemTheme: ResolvedThemeMode) => {
      setTheme(resolveThemeMode(themeMode, systemTheme));
    };
    const handleMediaTheme = () => {
      if (!mediaQuery) return;
      applySystemTheme(mediaQuery.matches ? 'light' : 'dark');
    };

    if (themeMode === 'auto' && isTauriRuntime()) {
      void getCurrentWindow().theme()
        .then((nativeTheme) => {
          if (!disposed && nativeWindowThemeIsResolvedTheme(nativeTheme)) setTheme(nativeTheme);
        })
        .catch(() => {
          handleMediaTheme();
        });
      void getCurrentWindow().onThemeChanged(({ payload }) => {
        if (!disposed && nativeWindowThemeIsResolvedTheme(payload)) setTheme(payload);
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenNativeTheme = unlisten;
        })
        .catch(() => undefined);
    } else {
      handleMediaTheme();
    }

    mediaQuery?.addEventListener('change', handleMediaTheme);
    return () => {
      disposed = true;
      mediaQuery?.removeEventListener('change', handleMediaTheme);
      unlistenNativeTheme?.();
    };
  }, [active, themeMode]);

  useLayoutEffect(() => {
    if (!active) return;
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    void syncNativeWindowTheme(themeMode).catch(() => undefined);
  }, [active, theme, themeMode]);

  useLayoutEffect(() => {
    document.body.classList.toggle('app-cloud-gate-active', active);
    document.body.classList.toggle('app-cloud-gate-frosted', active && frosted);
    if (isTauriRuntime()) {
      const background = !active
        ? APP_WINDOW_BACKGROUND[theme]
        : frosted ? FROSTED_GATE_WINDOW_BACKGROUND : GATE_WINDOW_BACKGROUND[theme];
      void getCurrentWindow().setBackgroundColor(background).catch(() => undefined);
    }

    return () => {
      document.body.classList.remove('app-cloud-gate-active', 'app-cloud-gate-frosted');
    };
  }, [active, frosted, theme]);

  return theme;
}

// Hosts whatever gate-time screen is showing (login form or restoring-session
// splash) inside the same `kordi-app` root the main shell uses, so the
// theme-tokens.css palette resolves. The wrapping hook installs the system
// theme class on <body> until the shell takes over.
export function CloudGateShell({
  children,
  active = true,
  frosted = false,
}: { children: ReactNode; active?: boolean; frosted?: boolean }) {
  const theme = useGateThemeClass(active, frosted);
  const handleGateWindowDragMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (!shouldStartNativeWindowDrag({
      isNativeShell: isTauriRuntime(),
      button: event.button,
      clientY: event.clientY,
      shellTop: event.currentTarget.getBoundingClientRect().top + readAuthWindowCropOffset().y,
      target: event.target,
    })) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  return (
    <div
      className={`kordi-app app-cloud-login-shell theme-${theme}`}
      data-active={active}
      data-frosted={frosted}
      inert={!active}
      aria-hidden={!active}
      onMouseDownCapture={handleGateWindowDragMouseDown}
    >
      {children}
    </div>
  );
}
