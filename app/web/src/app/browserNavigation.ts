import type { ChatNavigationState } from '@/features/chat/chatNavigation';
import type { NavId } from '@/kordi-app/types';

const destinations = {
  contacts: 'contacts',
  chats: 'chats',
  'agent-chats': 'agent-chats',
  factory: 'agents',
  digest: 'digest',
} as const satisfies Record<string, NavId>;

export type BrowserWorkspaceRoute = {
  nav: (typeof destinations)[keyof typeof destinations];
  conversationId: string;
};

export const DEFAULT_BROWSER_WORKSPACE_ROUTE: BrowserWorkspaceRoute = {
  nav: 'agent-chats', conversationId: '',
};

/** Routes refer to real product destinations; unknown pages never become IDs. */
export function parseBrowserWorkspaceRoute(pathname: string): BrowserWorkspaceRoute | null {
  if (pathname === '/app' || pathname === '/app/') return DEFAULT_BROWSER_WORKSPACE_ROUTE;
  const match = /^\/app\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match || !Object.prototype.hasOwnProperty.call(destinations, match[1])) return null;
  const nav = destinations[match[1] as keyof typeof destinations];
  if (match[2] && nav !== 'chats' && nav !== 'agent-chats') return null;
  try {
    const conversationId = match[2] ? decodeURIComponent(match[2]) : '';
    if (Array.from(conversationId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || conversationId.length > 2048) return null;
    return { nav, conversationId };
  } catch {
    return null;
  }
}

export function browserWorkspacePath(route: BrowserWorkspaceRoute): string {
  const segment = route.nav === 'agents' ? 'factory' : route.nav;
  const conversation = (route.nav === 'chats' || route.nav === 'agent-chats') && route.conversationId;
  return `/app/${segment}${conversation ? `/${encodeURIComponent(conversation)}` : ''}`;
}

export function browserRouteFromNavigation(state: Pick<ChatNavigationState, 'activeNav' | 'activeConvId'>): BrowserWorkspaceRoute {
  const nav = Object.values(destinations).find(destination => destination === state.activeNav) ?? 'agent-chats';
  return { nav, conversationId: nav === 'chats' || nav === 'agent-chats' ? state.activeConvId : '' };
}

export function applyBrowserWorkspaceRoute(state: ChatNavigationState, route: BrowserWorkspaceRoute): ChatNavigationState {
  const chat = route.nav === 'chats' || route.nav === 'agent-chats';
  return {
    ...state,
    activeNav: route.nav,
    activeConvId: chat ? route.conversationId : state.activeConvId,
    selections: chat ? { ...state.selections, [route.nav]: route.conversationId } : state.selections,
  };
}

export const BROWSER_WORKSPACE_NAVIGATED_EVENT = 'kordi-browser-workspace-navigated';

type HistoryWindow = Pick<Window, 'location' | 'history' | 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;

/** One owner for browser history. Query/hash hand-offs survive route changes. */
export function createBrowserWorkspaceHistory(
  browser: HistoryWindow,
  restore: (route: BrowserWorkspaceRoute) => void,
) {
  let initialized = false;
  let restoredPath: string | null = null;
  const onPopState = () => {
    const route = parseBrowserWorkspaceRoute(browser.location.pathname);
    if (!route) return;
    restoredPath = browserWorkspacePath(route);
    restore(route);
    browser.dispatchEvent(new Event(BROWSER_WORKSPACE_NAVIGATED_EVENT));
  };
  browser.addEventListener('popstate', onPopState);
  return {
    sync(route: BrowserWorkspaceRoute) {
      const pathname = browserWorkspacePath(route);
      if (restoredPath === pathname) {
        restoredPath = null;
        initialized = true;
        return;
      }
      const current = parseBrowserWorkspaceRoute(browser.location.pathname);
      if (!initialized) {
        initialized = true;
        if (current && browserWorkspacePath(current) !== pathname) return;
      }
      if (browser.location.pathname === pathname) return;
      const url = `${pathname}${browser.location.search}${browser.location.hash}`;
      const previousState: unknown = browser.history.state;
      const state = { ...(previousState && typeof previousState === 'object' ? previousState : {}), kordiWorkspace: true };
      if (browser.location.pathname === '/app' || browser.location.pathname === '/app/') {
        browser.history.replaceState(state, '', url);
      } else {
        browser.history.pushState(state, '', url);
      }
      browser.dispatchEvent(new Event(BROWSER_WORKSPACE_NAVIGATED_EVENT));
    },
    dispose() { browser.removeEventListener('popstate', onPopState); },
  };
}
