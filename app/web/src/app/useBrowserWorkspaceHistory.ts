import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { ChatNavigationState } from '@/features/chat/chatNavigation';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { applyBrowserWorkspaceRoute, browserRouteFromNavigation, createBrowserWorkspaceHistory } from '@web/app/browserNavigation';

export function useBrowserWorkspaceHistory(
  state: ChatNavigationState,
  setState: Dispatch<SetStateAction<ChatNavigationState>>,
) {
  const history = useRef<ReturnType<typeof createBrowserWorkspaceHistory> | null>(null);
  useEffect(() => {
    if (!isBrowserAppRuntime()) return;
    const controller = createBrowserWorkspaceHistory(window, route => {
      setState(current => applyBrowserWorkspaceRoute(current, route));
    });
    history.current = controller;
    return () => { controller.dispose(); history.current = null; };
  }, [setState]);
  const { activeNav, activeConvId } = state;
  useEffect(() => {
    history.current?.sync(browserRouteFromNavigation({ activeNav, activeConvId }));
  }, [activeNav, activeConvId]);
}
