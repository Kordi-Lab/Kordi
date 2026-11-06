import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { browserSessionMarker } from '@web/auth/browserAppRuntime';
import { withBrowserSession } from '@web/auth/browserSessionTransport';
import { CloudAuthClient } from '@/features/cloud/authClient';
import {
  CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
  type CloudGroupInvitationAcceptedDetail,
} from '@/features/cloud/groupInvitationDeepLink';
import { isGroupInvitationPromptBusy } from '@/features/cloud/groupInvitationPromptPresence';
import { GroupInvitationPromptHost } from '@/pages/GroupInvitationPromptHost';
import { withJsdomRoot } from '../../../desktop/tests/helpers/mountWithJsdom';
import { waitForReactCondition } from '../../../desktop/tests/helpers/waitForReactCondition';

// Matches the synthetic JSDOM page origin, so requests count as same-origin.
const ORIGIN = 'https://desktop.kordi.test';
const ACCOUNT = 'acct_web_invitee';
const CSRF = 'synthetic-csrf';

type Recorded = { method: string; path: string; headers: Headers; credentials: RequestCredentials | undefined };

function pendingInvitation(id: string, groupName: string) {
  return {
    id,
    invitationId: `inv_${id}`,
    groupName,
    inviterName: 'Maya Chen',
    memberCount: 3,
    expiresAt: '2026-11-12T00:00:00Z',
  };
}

/** A browser client on the cookie transport, against a synthetic pending API. */
function browserClient(list: () => ReturnType<typeof pendingInvitation>[]) {
  const requests: Recorded[] = [];
  const server: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ method, path: url.pathname, headers: new Headers(init?.headers), credentials: init?.credentials });
    if (method === 'GET' && url.pathname === '/v1/cloud/invitations/groups/pending') {
      return Response.json({ invitations: list() });
    }
    const accept = /^\/v1\/cloud\/invitations\/groups\/pending\/([^/]+)\/accept$/.exec(url.pathname);
    if (method === 'POST' && accept) {
      return Response.json({
        conversationId: 'session:group:reading',
        status: 'joined',
        groupId: 'group:reading',
        groupSpaceId: 'session:group:reading',
        groupTitle: 'Reading group',
      });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/v1/cloud/invitations/groups/pending/')) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ errorCode: 'not_found' }, { status: 404 });
  };
  const client = new CloudAuthClient({
    baseUrl: ORIGIN,
    fetchImpl: withBrowserSession(server, ORIGIN, () => `__Host-kordi_web_csrf=${CSRF}`),
  });
  return { client, requests };
}

const loadToken = async () => browserSessionMarker(ACCOUNT);
const noDeepLink = { token: null, dismiss: () => undefined };
const flush = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
const title = (host: HTMLElement) => host.querySelector('#group-invitation-title')?.textContent ?? '';
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')]
  .find((candidate) => candidate.textContent?.trim() === label);

async function withPromptDom(run: Parameters<typeof withJsdomRoot>[0]) {
  await withJsdomRoot(async (mount, root) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
    Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
    try {
      await run(mount, root);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'CustomEvent', previous);
    }
  });
}

function assertCookieAuthenticated(request: Recorded, write: boolean) {
  assert.equal(request.headers.get('authorization'), null, `${request.method} ${request.path} sends no bearer`);
  assert.equal(request.headers.get('x-kordi-web-account'), ACCOUNT);
  assert.equal(request.headers.get('x-kordi-csrf-token'), write ? CSRF : null);
  assert.equal(request.credentials, 'same-origin');
}

test('the web app shows a claimed invitation and Join accepts it with the CSRF header and opens the group', async () => {
  await withPromptDom(async (mount) => {
    const { client, requests } = browserClient(() => [pendingInvitation('p_reading', 'Reading group')]);
    const accepted: CloudGroupInvitationAcceptedDetail[] = [];
    const onAccepted = (event: Event) => {
      accepted.push((event as CustomEvent<CloudGroupInvitationAcceptedDetail>).detail);
    };
    window.addEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAccepted);
    try {
      const host = await mount(createElement(GroupInvitationPromptHost, {
        deepLink: noDeepLink, visible: true, client, loadToken,
      }));
      await waitForReactCondition(() => title(host) === 'Join Reading group?', 'the pending prompt should show');
      assert.match(host.textContent ?? '', /Maya Chen invited you · 3 members/);
      assert.doesNotMatch(host.innerHTML, /kordi:\/\//);
      assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), ['GET /v1/cloud/invitations/groups/pending']);
      assertCookieAuthenticated(requests[0], false);

      await act(async () => { button(host, 'Join')?.click(); });
      await flush();
      const accept = requests.find((request) => request.method === 'POST');
      assert.equal(accept?.path, '/v1/cloud/invitations/groups/pending/p_reading/accept');
      assertCookieAuthenticated(accept!, true);
      assert.deepEqual(accepted, [{
        groupId: 'group:reading', groupSpaceId: 'session:group:reading', groupTitle: 'Reading group',
      }]);
    } finally {
      window.removeEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAccepted);
    }
  });
});

test('Not now dismisses the invitation on the server with the CSRF header', async () => {
  await withPromptDom(async (mount) => {
    const { client, requests } = browserClient(() => [pendingInvitation('p_design', 'Design club')]);
    const host = await mount(createElement(GroupInvitationPromptHost, {
      deepLink: noDeepLink, visible: true, client, loadToken,
    }));
    await waitForReactCondition(() => title(host) === 'Join Design club?', 'the pending prompt should show');
    await act(async () => { button(host, 'Not now')?.click(); });
    await flush();
    const dismiss = requests.find((request) => request.method === 'DELETE');
    assert.equal(dismiss?.path, '/v1/cloud/invitations/groups/pending/p_design');
    assertCookieAuthenticated(dismiss!, true);
    assert.equal(host.querySelectorAll('[role="dialog"]').length, 0);
  });
});

test('first-run help waits for the invitation check and for the prompt to be answered', async () => {
  await withPromptDom(async (mount, root) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client } = browserClient(() => [pendingInvitation('p_tour', 'Tour group')]);
    const list = client.listPendingGroupInvitations.bind(client);
    client.listPendingGroupInvitations = async (token: string) => { await gate; return list(token); };
    const host = await mount(createElement(GroupInvitationPromptHost, {
      deepLink: noDeepLink, visible: true, client, loadToken,
    }));
    assert.equal(isGroupInvitationPromptBusy(), true, 'help waits while the first check runs');
    release();
    await waitForReactCondition(() => title(host) === 'Join Tour group?', 'the pending prompt should show');
    assert.equal(isGroupInvitationPromptBusy(), true, 'help waits while the prompt shows');
    await act(async () => { button(host, 'Not now')?.click(); });
    await flush();
    assert.equal(isGroupInvitationPromptBusy(), false, 'help may show once the prompt is answered');
    await act(async () => { root.unmount(); });
    assert.equal(isGroupInvitationPromptBusy(), false);
  });
});

test('an account without invitations lets first-run help show after the check', async () => {
  await withPromptDom(async (mount) => {
    const { client } = browserClient(() => []);
    await mount(createElement(GroupInvitationPromptHost, { deepLink: noDeepLink, visible: true, client, loadToken }));
    await waitForReactCondition(() => !isGroupInvitationPromptBusy(), 'help should not wait without an invitation');
  });
});
