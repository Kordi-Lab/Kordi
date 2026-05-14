import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudContactsPanel } from '../src/features/cloud/CloudContactsPanel';
import type { CloudAccount } from '../src/features/cloud/authClient';

test('CloudContactsPanel self card uses the provider image avatar instead of a generated pixel fallback', () => {
  const account: CloudAccount = {
    accountId: 'acct_provider',
    displayName: 'Provider User',
    primaryEmail: 'provider@example.com',
    avatarUrl: 'https://lh3.googleusercontent.com/a/provider-avatar',
    nodeId: 'node-provider',
    passwordSet: false,
  };

  const markup = renderToStaticMarkup(createElement(CloudContactsPanel, {
    account,
    onClose: () => {},
  }));

  const selfAvatarMarkup = markup.slice(markup.indexOf('aria-label="Provider User avatar"'), markup.indexOf('aria-label="Provider User avatar"') + 500);
  assert.match(selfAvatarMarkup, /src="https:\/\/lh3\.googleusercontent\.com\/a\/provider-avatar"/);
  assert.doesNotMatch(selfAvatarMarkup, /shape-rendering="crispEdges"/);
});
