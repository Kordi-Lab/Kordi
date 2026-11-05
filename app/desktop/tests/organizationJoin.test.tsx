import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrganizationJoinDialog, type OrganizationJoinActions } from '../src/features/organizations/OrganizationJoinDialog';
import {
  fetchJoinableOrganizations,
  normalizeJoinableOrganizations,
  sendOrganizationEmailCode,
  submitOrganizationJoinRequest,
  type JoinableOrganization,
  type JoinableOrganizations,
} from '../src/features/organizations/organizationJoinClient';
import {
  organizationJoinDismissedKey,
  promptableOrganizations,
  readDismissedJoinIds,
  rememberDismissedJoinIds,
} from '../src/features/organizations/organizationJoinPrompt';
import type { OrganizationStorage } from '../src/features/organizations/organizationStore';

const harbor: JoinableOrganization = {
  id: 'harbor', organizationId: 'org_harbor', name: 'Harbor Research', memberCount: 128,
  canJoin: true, canRequest: true, requested: false, joinRequestFields: [],
};
const maple: JoinableOrganization = {
  id: 'maple', organizationId: 'org_maple', name: 'Maple Lab', memberCount: 1,
  canJoin: false, canRequest: true, requested: false,
  joinRequestFields: [{ key: 'team', label: 'Team', required: true, maxLength: 80 }],
};
const cedar: JoinableOrganization = {
  id: 'cedar', organizationId: 'org_cedar', name: 'cedar studio', memberCount: 9,
  canJoin: false, canRequest: false, requested: true, joinRequestFields: [],
};
const data = (organizations: JoinableOrganization[]): JoinableOrganizations => ({
  email: 'pat@example.test', emailDomain: 'example.test', organizations,
});
const actions: OrganizationJoinActions = {
  sendCode: async () => 'ver_test',
  verifyCode: async () => {},
  request: async () => {},
};

function memoryStorage(): OrganizationStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

test('the joinable list keeps entries with a way in and maps the join options', () => {
  const body = {
    email: 'pat@example.test',
    emailDomain: 'example.test',
    organizations: [
      { id: 'harbor', organizationId: 'org_harbor', name: 'Harbor Research', memberCount: 128,
        joinOptions: { emailCode: true, joinRequest: true }, requested: false, joinRequestFields: [] },
      { id: 'maple', organizationId: 'org_maple', name: 'Maple Lab', memberCount: 1,
        joinOptions: { emailCode: false, joinRequest: true }, requested: false,
        joinRequestFields: [{ key: 'team', label: 'Team', required: true, maxLength: 80 }, { label: 'No key' }] },
      { id: 'cedar', name: 'Cedar Studio', joinOptions: { emailCode: true }, requested: true },
      { id: 'closed', name: 'Closed', joinOptions: { emailCode: false, joinRequest: false } },
      { id: 'harbor', name: 'Duplicate', joinOptions: { emailCode: true } },
      { name: 'No id', joinOptions: { emailCode: true } },
    ],
  };
  const result = normalizeJoinableOrganizations(body);
  assert.equal(result.emailDomain, 'example.test');
  assert.deepEqual(result.organizations.map((item) => item.id), ['harbor', 'maple', 'cedar']);
  assert.deepEqual(result.organizations[1].joinRequestFields, maple.joinRequestFields);
  assert.equal(result.organizations[2].canJoin, false, 'a requested organization offers no other path');
  assert.deepEqual(normalizeJoinableOrganizations(null), { email: null, emailDomain: null, organizations: [] });
});

test('the client calls the account routes with the bearer token', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/email-code')) return new Response(JSON.stringify({ verificationId: 'ver_1' }), { status: 200 });
    if (url.endsWith('/join-requests')) {
      return new Response(JSON.stringify({ errorCode: 'join_request_exists', message: 'Already sent.' }), { status: 409 });
    }
    return new Response(JSON.stringify({ email: null, emailDomain: null, organizations: [] }), { status: 200 });
  }) as typeof fetch;
  const options = { baseUrl: 'http://127.0.0.1:1', fetchImpl, token: 'tok_a' };
  await fetchJoinableOrganizations(options);
  assert.equal(await sendOrganizationEmailCode(harbor, 'pat@example.test', options), 'ver_1');
  await assert.rejects(submitOrganizationJoinRequest(maple, { team: 'Design' }, options), /Already sent\./);
  assert.deepEqual(calls.map((call) => [call.init?.method, call.url.replace('http://127.0.0.1:1', '')]), [
    ['GET', '/v1/cloud/account/joinable-organizations'],
    ['POST', '/v1/cloud/account/organizations/harbor/email-code'],
    ['POST', '/v1/cloud/account/organizations/maple/join-requests'],
  ]);
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer tok_a');
  assert.equal(calls[1].init?.body, JSON.stringify({ email: 'pat@example.test' }));
  assert.equal(calls[2].init?.body, JSON.stringify({ fields: { team: 'Design' } }));
});

test('the dialog opens by itself only for organizations not requested or dismissed', () => {
  const storage = memoryStorage();
  assert.deepEqual(promptableOrganizations(data([harbor, maple, cedar]), readDismissedJoinIds('acct_a', storage)), [harbor, maple]);
  rememberDismissedJoinIds('acct_a', ['harbor', 'maple', 'cedar'], storage);
  assert.equal(storage.values.get(organizationJoinDismissedKey('acct_a')), '["harbor","maple","cedar"]');
  assert.deepEqual(promptableOrganizations(data([harbor, maple, cedar]), readDismissedJoinIds('acct_a', storage)), []);
  assert.deepEqual(promptableOrganizations(data([harbor]), readDismissedJoinIds('acct_b', storage)), [harbor], 'per account');
  storage.values.set(organizationJoinDismissedKey('acct_a'), 'not json');
  assert.equal(readDismissedJoinIds('acct_a', storage).size, 0);
  assert.deepEqual(promptableOrganizations(null, new Set()), []);
});

test('rows show a letter avatar, the member count and one action', () => {
  const markup = renderToStaticMarkup(
    <OrganizationJoinDialog data={data([harbor, maple, cedar])} actions={actions} onClose={() => {}} />,
  );
  assert.match(markup, />Find your organization</);
  assert.match(markup, />Matching your example\.test email\.</);
  assert.match(markup, /aria-label="Search organizations"/);
  const rows = [...markup.matchAll(/data-organization-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, ['harbor', 'maple', 'cedar']);
  assert.match(markup, /aria-hidden="true">H<\/span><span class="org-join-text"><strong>Harbor Research<\/strong><small>128 members<\/small>/);
  assert.match(markup, />C<\/span>/, 'the first letter of the real name, uppercase');
  assert.match(markup, /<small>1 member<\/small>/);
  assert.match(markup, /org-join-action-join"[^>]*>Join</);
  assert.match(markup, /org-join-action-request"[^>]*>Request to join</);
  assert.match(markup, /org-join-action-done" disabled="">Requested</);
  assert.doesNotMatch(markup, /uppercase|Create/);
});

test('empty, unverified and loading states are the title and one line', () => {
  const lines = [
    [data([]), 'No organizations use example.test yet.'],
    [{ email: null, emailDomain: null, organizations: [] }, 'Verify your email to find your organization.'],
    [null, 'Loading…'],
  ] as const;
  for (const [value, line] of lines) {
    const markup = renderToStaticMarkup(<OrganizationJoinDialog data={value} actions={actions} onClose={() => {}} />);
    assert.ok(markup.includes(`>${line}</p>`), markup);
    assert.doesNotMatch(markup, /Search organizations|<button[^>]*>(Create|Join)/);
  }
});
