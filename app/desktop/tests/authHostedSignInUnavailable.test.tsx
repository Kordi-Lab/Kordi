import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import React, { act } from 'react';

import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';
import { SIGN_IN_UNAVAILABLE_MESSAGE } from '../src/features/cloud/ompAvailability';
import { providerLoginErrorFromResponse, type ProviderLoginClient } from '../src/features/cloud/providerLogin';
import { AuthCustomApiSetup } from '../src/kordi-app/auth/AuthCustomApiSetup';
import { AuthLoginPage } from '../src/kordi-app/auth/AuthLoginPage';
import { AuthProviderDetail } from '../src/kordi-app/auth/AuthProviderDetail';
import { AuthRouteTest } from '../src/kordi-app/auth/AuthRouteTest';
import { buildAddMethods, type AuthAddMethod } from '../src/kordi-app/auth/authAddMethods';
import type { AuthDisplayProvider } from '../src/kordi-app/auth/model';
import { buildOmpDisplayProviders, loadPinnedOmpCatalog } from '../src/kordi-app/auth/ompCatalog';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

// A server without hosted sign-in (404, or 503 provider_auth_not_configured)
// keeps the actions that need it off with no notice, tooltip or helper line.
const removedNotice = /OMP is not available|not available on this backend|need a newer server/;

const catalog = await loadPinnedOmpCatalog();
const providers = buildOmpDisplayProviders({ authPath: '', hasAnyAuth: true, providers: [] }, [hosted('groq', 'Work')], catalog.providers).providers;

function hosted(provider: string, label: string): CloudProviderAuthSnapshot {
  return {
    snapshotId: `snap_${label.toLowerCase()}`, provider, authChoice: `cloud-login:${label.toLowerCase()}`,
    label, modelHint: null, createdAt: '2026-01-01T00:00:00Z', revokedAt: null,
  };
}

function provider(id: string): AuthDisplayProvider {
  const found = providers.find((item) => item.id === id);
  assert.ok(found, `${id} is missing`);
  return found;
}

function hostedMethod(kind: AuthAddMethod['kind']): AuthAddMethod {
  for (const item of providers) {
    const method = buildAddMethods(item, []).find((candidate) => candidate.kind === kind && candidate.hosted);
    if (method) return method;
  }
  throw new Error(`No hosted ${kind} method in the pinned catalog.`);
}

function refusingClient(): ProviderLoginClient & { starts: number } {
  const client = {
    starts: 0,
    async start() {
      client.starts += 1;
      throw providerLoginErrorFromResponse(404, null);
    },
    poll: async () => { throw new Error('not started'); },
    submit: async () => null,
    cancel: async () => null,
  };
  return client;
}

function button(host: HTMLElement, name: string) {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
  assert.ok(found, `${name} button is missing`);
  return found;
}

function assertNoNotice(host: HTMLElement) {
  assert.doesNotMatch(host.textContent ?? '', removedNotice);
  assert.equal(host.querySelector('[role="note"]'), null, 'no notice paragraph');
  assert.equal(host.querySelector('[data-auth-page-notice]'), null, 'no page notice');
  for (const item of host.querySelectorAll('[title]')) {
    assert.doesNotMatch(item.getAttribute('title') ?? '', removedNotice);
  }
}

const loginProps = { suggestedAccountName: 'Work', openExternal: () => undefined, onCompleted: () => undefined, onDone: () => undefined, onBack: () => undefined };

test('a login page on a server without hosted sign-in keeps its action off, with no notice or tooltip', async () => {
  await withJsdomRoot(async (mount) => {
    for (const [kind, name] of [['api-key', 'Save'], ['browser', 'Sign in']] as const) {
      const host = await mount(<AuthLoginPage key={kind} {...loginProps} method={hostedMethod(kind)} client={refusingClient()} ompUnavailable />);
      const action = button(host, name);
      assert.equal(action.disabled, true, `${kind} action stays off`);
      assert.equal(action.hasAttribute('title'), false, `${kind} action has no explanation`);
      assert.equal(host.querySelector('[role="alert"]'), null, `${kind} shows no error before an attempt`);
      assertNoNotice(host);
    }
  });
});

test('a sign-in refused because the server has no hosted sign-in shows one short line and turns the action off', async () => {
  await withJsdomRoot(async (mount) => {
    const client = refusingClient();
    let reported = 0;
    const host = await mount(<AuthLoginPage {...loginProps} method={hostedMethod('browser')} client={client} onOmpUnavailable={() => { reported += 1; }} />);
    const start = button(host, 'Sign in');
    assert.equal(start.disabled, false);
    await act(async () => { start.click(); });
    await waitForReactCondition(() => host.querySelector('[role="alert"]') !== null, 'the refused start shows its line');
    const alerts = [...host.querySelectorAll('[role="alert"]')].map((item) => item.textContent);
    assert.deepEqual(alerts, [SIGN_IN_UNAVAILABLE_MESSAGE]);
    assert.equal(button(host, 'Sign in').disabled, true);
    assert.equal(client.starts, 1);
    assert.equal(reported, 1);
    assert.equal(host.textContent?.includes('Try again'), false, 'no retry for an action that stays off');
    assertNoNotice(host);
  });
});

test('route tests and Custom API keys stay off without a reason line or tooltip', async () => {
  await withJsdomRoot(async (mount) => {
    const routeHost = await mount(<AuthRouteTest provider={provider('groq')} onTestRoute={async () => { throw new Error('not reached'); }} disabled />);
    const run = button(routeHost, 'Run test');
    assert.equal(run.disabled, true);
    assert.equal(run.hasAttribute('title'), false);
    assertNoNotice(routeHost);

    const customHost = await mount(<AuthCustomApiSetup disabled />);
    const save = button(customHost, 'Save key');
    assert.equal(save.disabled, true);
    assert.equal(save.hasAttribute('title'), false);
    assertNoNotice(customHost);
  });
});

test('the provider page on a server without hosted sign-in keeps saved accounts and shows no notice', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(
      <AuthProviderDetail
        provider={provider('groq')}
        rawProviders={[]}
        error={null}
        onOpenLogin={() => undefined}
        onSelectAuthChoice={() => undefined}
        onRemoveAuthProfile={() => undefined}
        onLogoutProvider={() => undefined}
        onRefreshAuth={() => undefined}
        onTestRoute={async () => { throw new Error('not reached'); }}
        ompUnavailable
      />,
    );
    assert.match(host.textContent ?? '', /Work/, 'the saved account still shows');
    assert.match(host.textContent ?? '', /Add account/);
    assert.equal(button(host, 'Run test').disabled, true);
    assertNoNotice(host);
  });
});

test('the removed sentence appears nowhere in the Mac app source', () => {
  const root = new URL('../src', import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length > 100);
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), removedNotice, file);
});
