import { browserSessionAccountId } from '@web/auth/browserAppRuntime';

export const WEB_CSRF_COOKIE = '__Host-kordi_web_csrf';
export const WEB_CSRF_HEADER = 'X-Kordi-CSRF-Token';
export const WEB_ACCOUNT_HEADER = 'X-Kordi-Web-Account';

export function browserCsrfToken(cookie: string): string | null {
  return cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${WEB_CSRF_COOKIE}=`))
    ?.slice(WEB_CSRF_COOKIE.length + 1) || null;
}

/** Browser credentials are sent only to the page's own API, never to asset hosts. */
export function withBrowserSession(
  fetchImpl: typeof fetch,
  origin: string,
  readCookie: () => string,
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(input instanceof Request ? input.url : input, origin);
    const headers = new Headers(init?.headers ?? request?.headers);
    const token = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '')?.[1] ?? '';
    const accountId = browserSessionAccountId(token);
    const api = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/');
    if (accountId && (url.origin !== origin || !api)) {
      throw new Error('Browser account requests must use the same-origin Kordi API.');
    }
    if (url.origin !== origin || !api) return fetchImpl(input, init);
    if (accountId) {
      headers.delete('authorization');
      headers.set(WEB_ACCOUNT_HEADER, accountId);
    }
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = browserCsrfToken(readCookie());
      if (csrf) headers.set(WEB_CSRF_HEADER, csrf);
    }
    return fetchImpl(input, { ...init, headers, credentials: 'same-origin', redirect: 'error' });
  };
}
