import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import {
  contactPermissionsVersionFromCapabilities,
  fetchContactPermissions,
  updateContactPermissions,
} from '../src/features/cloud/contactPermissionsClient';
import { normalizeContactProfile, type CloudContactPermissionFlags, type CloudContactProfile } from '../src/features/cloud/contactProfileClient';
import type { ContactPermissionsHost, ContactProfileHost } from '../src/kordi-app/contacts/contactProfileHost';
import { ContactsPage } from '../src/kordi-app/pages';
import { contact, contactsPageProps } from './helpers/contactsPageFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';

const priya = contact({
  id: 'cloud:acct_priya', name: 'Priya', subtitle: '@482731906', detail: '@482731906',
  sourceHostId: 'cloud', sourceParticipantId: 'acct_priya', sourceHumanId: 'acct_priya',
});

function personProfile(extra: Record<string, unknown> = {}): CloudContactProfile {
  return normalizeContactProfile({
    accountId: 'acct_priya', kordiId: '482731906', displayName: 'Priya', kind: 'person',
    shared: { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [] },
    ...extra,
  })!;
}

type RequestCall = { path: string; method: string; headers: Record<string, string>; body: string | undefined };

function recordingRequest(response: unknown, calls: RequestCall[]) {
  return async <T,>(path: string, init: RequestInit) => {
    calls.push({ path, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    return response as T;
  };
}

test('the capability flag gates the permissions route', () => {
  assert.equal(contactPermissionsVersionFromCapabilities(null), null);
  assert.equal(contactPermissionsVersionFromCapabilities({}), null);
  assert.equal(contactPermissionsVersionFromCapabilities({ contactPermissionsVersion: 0 }), null);
  assert.equal(contactPermissionsVersionFromCapabilities({ contactPermissionsVersion: 1 }), 1);
});

test('fetchContactPermissions reads the permissions route and normalizes the body', async () => {
  const calls: RequestCall[] = [];
  const result = await fetchContactPermissions('acct_priya', {
    token: async () => 'tok',
    request: recordingRequest({ accountId: 'acct_priya', agentAccess: false, cardAccess: true, updatedAt: null }, calls),
  });
  assert.deepEqual(result, { accountId: 'acct_priya', agentAccess: false, cardAccess: true, updatedAt: null });
  assert.equal(calls[0].path, '/v1/cloud/contacts/acct_priya/permissions');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.equal(calls[0].body, undefined);
  await assert.rejects(fetchContactPermissions('acct_priya', { token: async () => 'tok', request: recordingRequest({ agentAccess: 'no' }, []) }));
  await assert.rejects(fetchContactPermissions('acct_priya', { token: async () => null }));
});

test('updateContactPermissions sends only the changed keys as JSON', async () => {
  const calls: RequestCall[] = [];
  const result = await updateContactPermissions('acct_priya', { cardAccess: false }, {
    token: async () => 'tok',
    request: recordingRequest({ accountId: 'acct_priya', agentAccess: true, cardAccess: false, updatedAt: '2026-11-05T10:00:00Z' }, calls),
  });
  assert.equal(calls[0].path, '/v1/cloud/contacts/acct_priya/permissions');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body ?? ''), { cardAccess: false });
  assert.equal(result.updatedAt, '2026-11-05T10:00:00Z');
  assert.equal(result.cardAccess, false);
});

test('profile permissions are optional and only kept for other people', () => {
  assert.deepEqual(personProfile({ permissions: { agentAccess: false, cardAccess: true } }).permissions, { agentAccess: false, cardAccess: true });
  assert.equal(personProfile().permissions, null);
  assert.equal(personProfile({ permissions: { agentAccess: 'yes', cardAccess: true } }).permissions, null);
  assert.equal(personProfile({ isSelf: true, permissions: { agentAccess: true, cardAccess: true } }).permissions, null);
  assert.equal(personProfile({ kind: 'agent', permissions: { agentAccess: true, cardAccess: true } }).permissions, null);
});

type PermissionCalls = { loads: string[]; saves: Array<{ accountId: string; patch: Partial<CloudContactPermissionFlags> }> };

function hostWith(profile: CloudContactProfile, permissions?: ContactPermissionsHost): ContactProfileHost {
  return {
    accountIdFor: (picked) => picked.sourceParticipantId ?? null,
    load: async () => profile,
    permissions,
  };
}

function permissionsHost(calls: PermissionCalls, options: { stored?: CloudContactPermissionFlags; fail?: boolean } = {}): ContactPermissionsHost {
  let stored = options.stored ?? { agentAccess: true, cardAccess: true };
  return {
    load: async (accountId) => { calls.loads.push(accountId); return stored; },
    save: async (accountId, patch) => {
      calls.saves.push({ accountId, patch });
      if (options.fail) throw new Error('Could not save permissions.');
      stored = { ...stored, ...patch };
      return stored;
    },
  };
}

async function mount(host: ContactProfileHost) {
  const installed = installDom();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => {
    root.render(createElement(ContactsPage, contactsPageProps({ contactOverlayMode: 'contact', activeContact: priya, contactProfileHost: host })));
  });
  await settle();
  await settle();
  return {
    host: element,
    settle,
    switches: () => [...element.querySelectorAll('[role="switch"]')].map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-checked')]),
    click: (label: string) => act(async () => {
      const target = element.querySelector(`[role="switch"][aria-label="${label}"]`);
      assert.ok(target, `${label} switch should exist`);
      target.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true }));
    }),
    async cleanup() {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

test('the section shows both switches from the profile flags and saves a toggle', async () => {
  const calls: PermissionCalls = { loads: [], saves: [] };
  const page = await mount(hostWith(personProfile({ permissions: { agentAccess: false, cardAccess: true } }), permissionsHost(calls)));
  try {
    assert.match(page.host.textContent ?? '', /Permissions/);
    assert.ok(!page.host.querySelector('.uppercase'), 'no all-caps headings');
    assert.deepEqual(page.switches(), [['Use my agent', 'false'], ['See my card', 'true']]);
    assert.deepEqual(calls.loads, [], 'profile flags skip the extra request');
    await page.click('See my card');
    await page.settle();
    assert.deepEqual(calls.saves, [{ accountId: 'acct_priya', patch: { cardAccess: false } }]);
    assert.deepEqual(page.switches(), [['Use my agent', 'false'], ['See my card', 'false']]);
  } finally {
    await page.cleanup();
  }
});

test('a failed save reverts the switch and shows the error', async () => {
  const calls: PermissionCalls = { loads: [], saves: [] };
  const page = await mount(hostWith(personProfile(), permissionsHost(calls, { fail: true })));
  try {
    assert.deepEqual(calls.loads, ['acct_priya'], 'older profiles fall back to the permissions route');
    assert.deepEqual(page.switches(), [['Use my agent', 'true'], ['See my card', 'true']]);
    await page.click('Use my agent');
    await page.settle();
    assert.deepEqual(calls.saves, [{ accountId: 'acct_priya', patch: { agentAccess: false } }]);
    assert.deepEqual(page.switches(), [['Use my agent', 'true'], ['See my card', 'true']]);
    assert.match(page.host.textContent ?? '', /Could not save permissions\./);
  } finally {
    await page.cleanup();
  }
});

test('the section stays hidden without the capability, for yourself, and for agents', async () => {
  for (const host of [
    hostWith(personProfile({ permissions: { agentAccess: true, cardAccess: true } })),
    hostWith(personProfile({ isSelf: true }), permissionsHost({ loads: [], saves: [] })),
    hostWith(personProfile({ kind: 'agent' }), permissionsHost({ loads: [], saves: [] })),
  ]) {
    const page = await mount(host);
    try {
      assert.deepEqual(page.switches(), []);
      assert.doesNotMatch(page.host.textContent ?? '', /Permissions/);
    } finally {
      await page.cleanup();
    }
  }
});
