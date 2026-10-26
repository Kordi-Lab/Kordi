import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, isValidElement } from 'react';

import { CloudAuthClient, type CloudAccount, type CloudAuthCapabilities } from '../src/features/cloud/authClient';
import { clearCloudAuthCapabilitiesCacheForTests } from '../src/features/cloud/cloudAuthCapabilities';
import { CommonGroundLazyPanel } from '../src/features/commonGround/CommonGroundLazyPanel';
import type { CgHost } from '../src/features/commonGround/host';
import { useCommonGroundEntry } from '../src/features/commonGround/useCommonGroundEntry';
import { ContactsPage } from '../src/kordi-app/contacts/ContactsPage';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { contactsPageProps } from './helpers/contactsPageFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const account: CloudAccount = {
  accountId: 'acct_grounding', displayName: 'Alex', primaryEmail: null,
  avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: null, passwordSet: true,
};
const unsupported: CloudAuthCapabilities = { password: true, oauthProviders: [] };

function Harness({ signedIn = true, search = '' }: { signedIn?: boolean; search?: string }) {
  const props = contactsPageProps({ activeContact: null, contactSearch: search });
  const entry = useCommonGroundEntry(props, {
    account: signedIn ? account : null,
    cloud: { contacts: [], acceptRequest: async () => undefined, refresh: async () => undefined },
  });
  // Exercise entry gating without mounting the wallet's separate API/polling lifecycle.
  const detail = entry.leadingDetail;
  const ready = isValidElement<{ host: CgHost }>(detail) && detail.type === CommonGroundLazyPanel;
  return <ContactsPage {...props} {...entry} leadingDetail={ready
    ? <div data-testid="wallet" data-profiles={String(detail.props.host.profiles)} />
    : detail} />;
}

function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  assert.ok(found, `Expected button: ${text}`);
  return found;
}

test('Grounding stays reachable with no contacts through loading, failure, unsupported service and recovery', async (t) => {
  clearCloudAuthCapabilitiesCacheForTests();
  let reject!: (error: Error) => void;
  const first = new Promise<CloudAuthCapabilities>((_resolve, fail) => { reject = fail; });
  let calls = 0;
  t.mock.method(CloudAuthClient.prototype, 'capabilities', () => {
    calls += 1;
    if (calls === 1) return first;
    return Promise.resolve(calls === 2 ? unsupported : { ...unsupported, commonGroundVersion: 3 });
  });
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(<Harness />);
      assert.equal(calls, 1);
      assert.ok(button(host, 'Grounding'));
      await act(async () => button(host, 'Grounding').click());
      assert.match(host.textContent ?? '', /Opening Grounding/);
      assert.equal(host.querySelector('[data-testid="wallet"]'), null);

      await act(async () => reject(new Error('Offline')));
      assert.match(host.querySelector('[role="alert"]')?.textContent ?? '', /Could not connect/);
      assert.equal(button(host, 'Grounding').getAttribute('aria-current'), 'true');

      await mount(<Harness search="Nobody matches" />);
      assert.ok(button(host, 'Grounding'), 'contact search cannot filter out Grounding');
      await act(async () => button(host, 'Try again').click());
      assert.equal(calls, 2);
      assert.match(host.textContent ?? '', /not available on this server yet/);
      assert.equal(host.querySelector('[data-testid="wallet"]'), null, 'unsupported servers cannot mount the wallet');

      await act(async () => button(host, 'Try again').click());
      assert.equal(calls, 3, 'retry must bypass a cached successful capability response');
      assert.equal(host.querySelector('[data-testid="wallet"]')?.getAttribute('data-profiles'), 'true');
      assert.equal(button(host, 'Grounding').getAttribute('aria-current'), 'true');

      await mount(<Harness signedIn={false} />);
      assert.equal(host.querySelector('.app-common-ground-row'), null);
      assert.equal(host.querySelector('[data-testid="wallet"]'), null);
    });
  } finally {
    clearCloudAuthCapabilitiesCacheForTests();
  }
});

test('signed-out Contacts does not request Grounding capabilities', async (t) => {
  clearCloudAuthCapabilitiesCacheForTests();
  const request = t.mock.method(CloudAuthClient.prototype, 'capabilities', async () => unsupported);
  await withJsdomRoot(async (mount) => {
    const host = await mount(<Harness signedIn={false} />);
    assert.equal(host.querySelector('.app-common-ground-row'), null);
    assert.equal(request.mock.callCount(), 0);
  });
});
