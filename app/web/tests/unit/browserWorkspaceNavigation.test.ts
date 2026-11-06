import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBrowserWorkspaceRoute,
  browserRouteFromNavigation,
  browserWorkspacePath,
  createBrowserWorkspaceHistory,
  parseBrowserWorkspaceRoute,
  type BrowserWorkspaceRoute,
} from '@web/app/browserNavigation';
import type { ChatNavigationState } from '@/features/chat/chatNavigation';

const initial: ChatNavigationState = {
  activeNav: 'agent-chats', activeConvId: '', selections: { chats: '', 'agent-chats': '' },
};

test('all real workspace destinations round trip through URLs', () => {
  for (const nav of ['contacts', 'chats', 'agent-chats', 'agents', 'digest'] as const) {
    const route = { nav, conversationId: '' };
    assert.deepEqual(parseBrowserWorkspaceRoute(browserWorkspacePath(route)), route);
  }
  assert.equal(browserWorkspacePath({ nav: 'agents', conversationId: '' }), '/app/factory');
  assert.deepEqual(parseBrowserWorkspaceRoute('/app'), { nav: 'agent-chats', conversationId: '' });
});

test('conversation IDs survive deep links without becoming path or query segments', () => {
  for (const conversationId of ['session:group:team', 'cloud:agent/account', 'session:\u65e5\u672c\u8a9e #?%']) {
    const route: BrowserWorkspaceRoute = { nav: 'chats', conversationId };
    assert.deepEqual(parseBrowserWorkspaceRoute(browserWorkspacePath(route)), route);
    assert.equal(new URL(browserWorkspacePath(route), 'https://example.test').search, '');
  }
});

test('malformed and unrelated routes are rejected', () => {
  for (const path of ['/v1/cloud/auth', '/app/settings', '/app/contacts/person', '/app/chats/a/b', '/app/chats/%E0%A4', '/app/chats/%00', '/application/chats', '/app/__proto__']) {
    assert.equal(parseBrowserWorkspaceRoute(path), null, path);
  }
});

test('a deep-linked conversation is selected before its catalog arrives', () => {
  const route: BrowserWorkspaceRoute = { nav: 'chats', conversationId: 'session:group:pending' };
  const state = applyBrowserWorkspaceRoute(initial, route);
  assert.equal(state.activeConvId, route.conversationId);
  assert.equal(state.selections.chats, route.conversationId);
  assert.deepEqual(browserRouteFromNavigation(state), route);
  const contacts = applyBrowserWorkspaceRoute(state, { nav: 'contacts', conversationId: '' });
  assert.equal(contacts.selections.chats, route.conversationId);
  assert.deepEqual(browserRouteFromNavigation(contacts), { nav: 'contacts', conversationId: '' });
});

class HistoryHarness extends EventTarget {
  entries: Array<{ url: URL; state: unknown }>;
  cursor = 0;
  constructor(path: string) {
    super();
    this.entries = [{ url: new URL(path, 'https://example.test'), state: { anotherFeature: true } }];
  }
  get location() { return this.entries[this.cursor].url; }
  get history() {
    return {
      state: this.entries[this.cursor].state,
      pushState: (state: unknown, _unused: string, url: string) => {
        this.entries.splice(this.cursor + 1);
        this.entries.push({ url: new URL(url, this.location), state });
        this.cursor += 1;
      },
      replaceState: (state: unknown, _unused: string, url: string) => {
        this.entries[this.cursor] = { url: new URL(url, this.location), state };
      },
    };
  }
  go(delta: number) {
    this.cursor += delta;
    this.dispatchEvent(new Event('popstate'));
  }
  asWindow() { return this as unknown as Window; }
}

test('Back and Forward restore selection without creating extra history entries', () => {
  const browser = new HistoryHarness('/app/chats/first?invite=opaque#handoff');
  let restored: BrowserWorkspaceRoute | null = null;
  const history = createBrowserWorkspaceHistory(browser.asWindow(), route => { restored = route; });
  history.sync({ nav: 'chats', conversationId: 'first' });
  history.sync({ nav: 'chats', conversationId: 'second' });
  history.sync({ nav: 'digest', conversationId: '' });
  assert.equal(browser.entries.length, 3);
  assert.equal(browser.location.search, '?invite=opaque');
  assert.equal(browser.location.hash, '#handoff');
  assert.deepEqual(browser.history.state, { anotherFeature: true, kordiWorkspace: true });
  browser.go(-1);
  assert.deepEqual(restored, { nav: 'chats', conversationId: 'second' });
  history.sync(restored!);
  assert.equal(browser.entries.length, 3);
  browser.go(1);
  assert.deepEqual(restored, { nav: 'digest', conversationId: '' });
  history.sync(restored!);
  assert.equal(browser.cursor, 2);
  history.dispose();
  restored = null;
  browser.go(-1);
  assert.equal(restored, null);
});

test('app root normalization replaces history and repeated renders do not push', () => {
  const browser = new HistoryHarness('/app');
  const history = createBrowserWorkspaceHistory(browser.asWindow(), () => {});
  history.sync({ nav: 'agent-chats', conversationId: '' });
  history.sync({ nav: 'agent-chats', conversationId: '' });
  assert.equal(browser.location.pathname, '/app/agent-chats');
  assert.equal(browser.entries.length, 1);
  history.dispose();
});

test('initial history synchronization cannot overwrite a pending deep link', () => {
  const browser = new HistoryHarness('/app/chats/pending');
  const history = createBrowserWorkspaceHistory(browser.asWindow(), () => {});
  history.sync({ nav: 'agent-chats', conversationId: '' });
  assert.equal(browser.location.pathname, '/app/chats/pending');
  assert.equal(browser.entries.length, 1);
  history.dispose();
});
