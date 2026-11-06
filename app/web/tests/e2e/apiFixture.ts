import type { Page } from '@playwright/test';

// Synthetic protocol fixtures exercise the complete production application,
// without Tauri mocks. They are not two-account/backend acceptance evidence.
export const account = {
  accountId: 'acct_browser_test_owner', displayName: 'Browser Test',
  primaryEmail: 'browser@example.test', primaryEmailVerified: true,
  avatarUrl: null, avatar: { entityType: 'human', entityId: 'acct_browser_test_owner', source: 'generated',
    style: 'kordi-birds', seed: 'bird-robin-color-coral', rendererVersion: 'fixture-v1',
    uploadedAsset: null, version: 0, updatedAt: '2026-11-05T12:00:00Z' },
  nodeId: null, passwordSet: true, defaultAgent: null,
};

export async function installApiFixture(page: Page, baseURL: string, signedIn: boolean | (() => boolean)) {
  const requests: { path: string; headers: Record<string, string> }[] = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL) return route.abort();
    if (!/^\/v[12]\//.test(url.pathname)) return route.continue();
    requests.push({ path: url.pathname, headers: request.headers() });
    let body: unknown;
    switch (url.pathname) {
      case '/v1/cloud/auth/web/session':
        if (!(typeof signedIn === 'function' ? signedIn() : signedIn)) return route.fulfill({ status: 401, json: { errorCode: 'login_required' } });
        body = { account, csrfToken: 'synthetic-csrf', session: { organizationId: 'browser-test-org', deviceId: 'browser-test-device', expiresAt: '2099-01-01T00:00:00Z' } };
        break;
      case '/v1/cloud/auth/me': body = account; break;
      case '/v1/cloud/auth/capabilities': body = { password: true, oauthProviders: ['google', 'github'] }; break;
      case '/v1/cloud/organizations': body = { organizations: [{ organizationId: 'browser-test-org', name: 'Test workspace', kind: 'personal', role: 'owner', memberCount: 1 }] }; break;
      case '/v2/chat/sync/bootstrap': body = { protocol_version: 2, conversations: [], latest_messages: [], next_cursor: 'fixture-cursor', last_stream_seq: 0, server_time: '2026-11-05T12:00:00Z' }; break;
      case '/v2/chat/sync': body = { protocol_version: 2, events: [], next_cursor: 'fixture-cursor', last_stream_seq: 0, has_more: false, server_time: '2026-11-05T12:00:00Z' }; break;
      case '/v1/cloud/contacts': body = { contacts: [], requests: [] }; break;
      case '/v1/cloud/contacts/requests': body = { requests: [] }; break;
      default: return route.fulfill({ status: 404, json: { errorCode: 'fixture_route_unavailable' } });
    }
    return route.fulfill({ status: 200, json: body });
  });
  return requests;
}

/** The site's /login and /register pages, served on the same origin as /app/ in production. */
export async function stubSitePages(page: Page) {
  const visits: string[] = [];
  await page.route(/\/(login|register)(\?|#|$)/, async route => {
    const url = new URL(route.request().url());
    visits.push(`${url.pathname}${url.search}`);
    const title = url.pathname === '/register' ? 'Site sign up' : 'Site login';
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>${title}</title><h1>${title}</h1>` });
  });
  return visits;
}
