import { useEffect } from 'react';

// The browser app has no sign-in screen of its own. A signed-out visitor goes
// to the site's /login (or /register) page, which returns to `next` after
// sign-in. The site validates `next` with the same rule as BROWSER_APP_NEXT.

export type BrowserSitePage = 'login' | 'register';

export const BROWSER_SITE_PAGES: Record<BrowserSitePage, string> = {
  login: '/login',
  register: '/register',
};

const BROWSER_APP_HOME = '/app/';
const MAX_NEXT_LENGTH = 512;
// Under /app only: no scheme, no fragment. The server refuses a fragment in
// an OAuth return path, and a fragment here only ever carries a one-time
// OAuth result that must not be replayed.
const BROWSER_APP_NEXT = /^\/app(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?(\?[^#\s]*)?$/;
// No `//`, backslash, encoded slash or backslash, or dot segment anywhere.
const UNSAFE_NEXT = /\/\/|\\|%2f|%5c|\/\.\.?(?:[/?]|$)/i;

/** A same-origin browser app path the site may return to, or null. */
export function safeBrowserAppNext(value: string | null | undefined): string | null {
  if (!value || value.length > MAX_NEXT_LENGTH || UNSAFE_NEXT.test(value)) return null;
  return BROWSER_APP_NEXT.test(value) ? value : null;
}

/** The page to come back to: path and query, or just the path, or the app home. */
export function browserAppNextFromHref(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return BROWSER_APP_HOME;
  }
  return safeBrowserAppNext(`${url.pathname}${url.search}`)
    ?? safeBrowserAppNext(url.pathname)
    ?? BROWSER_APP_HOME;
}

const OAUTH_ERROR_CODE = /^[a-z0-9_]{1,64}$/;

/** The server's OAuth error code from a callback fragment, never its free text. */
export function browserOAuthErrorCode(hash: string | null | undefined): string | null {
  const fragment = new URLSearchParams((hash ?? '').replace(/^#/, ''));
  if (!fragment.has('kordi_cloud_oauth_error') && !fragment.has('kordi_cloud_oauth_error_code')) return null;
  const code = fragment.get('kordi_cloud_oauth_error_code')?.trim() ?? '';
  return OAUTH_ERROR_CODE.test(code) ? code : 'oauth_failed';
}

export type BrowserSiteSignInOptions = {
  page?: BrowserSitePage;
  /** The visitor signed out on purpose, so there is nowhere to come back to. */
  signedOut?: boolean;
  oauthErrorCode?: string | null;
};

/** The site sign-in URL (path, query and fragment) for a signed-out browser app page. */
export function browserSiteSignInUrl(href: string, options: BrowserSiteSignInOptions = {}): string {
  const path = BROWSER_SITE_PAGES[options.page ?? 'login'];
  const query = options.signedOut ? '' : `?next=${encodeURIComponent(browserAppNextFromHref(href))}`;
  const fragment = options.oauthErrorCode
    ? `#kordi_cloud_oauth_error_code=${encodeURIComponent(options.oauthErrorCode)}`
    : '';
  return `${path}${query}${fragment}`;
}

// Read once at startup: session restore strips the OAuth fragment from the
// address bar before the redirect runs.
const initialOAuthErrorCode = typeof window === 'undefined' ? null : browserOAuthErrorCode(window.location.hash);
let signOutRequested = false;

/** Wraps sign-out so the redirect that follows lands on the site without a return path. */
export function signOutToSite(signOut: () => Promise<void>): () => Promise<void> {
  return async () => {
    signOutRequested = true;
    try {
      await signOut();
    } catch (error) {
      signOutRequested = false;
      throw error;
    }
  };
}

/** While active, replaces this page with the site's sign-in page. */
export function useBrowserSiteSignInRedirect(active: boolean, page: BrowserSitePage = 'login') {
  useEffect(() => {
    if (!active) return;
    window.location.replace(browserSiteSignInUrl(window.location.href, {
      page,
      signedOut: signOutRequested,
      oauthErrorCode: signOutRequested ? null : initialOAuthErrorCode,
    }));
  }, [active, page]);
}
