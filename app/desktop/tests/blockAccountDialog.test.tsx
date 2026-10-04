import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudAuthError } from '../src/features/cloud/authClient';
import { BlockAccountDialog } from '../src/features/safety/BlockAccountDialog';
import { BLOCK_EXPLANATION } from '../src/features/safety/safetyCopy';
import { mountInDom } from './helpers/safetyDom';

const target = { accountId: 'acct_bea', name: 'Bea' };

test('the block dialog explains every consequence and offers a report instead', () => {
  const markup = renderToStaticMarkup(createElement(BlockAccountDialog, {
    mode: 'block',
    target,
    onConfirm: async () => undefined,
    onDismiss: () => undefined,
    onReport: () => undefined,
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /aria-labelledby="[^"]+"/);
  assert.match(markup, />Block Bea\?</);
  for (const line of BLOCK_EXPLANATION) {
    assert.ok(markup.includes(line.replace(/'/g, '&#x27;')), line);
  }
  assert.match(markup, />Report Bea…</);
  assert.match(markup, />Cancel</);
  assert.match(markup, />Block</);
  assert.match(markup, /aria-live="polite"/);
  assert.doesNotMatch(markup, /deleted/i);
});

test('the unblock dialog says contacts are not restored', () => {
  const markup = renderToStaticMarkup(createElement(BlockAccountDialog, {
    mode: 'unblock',
    target,
    onConfirm: async () => undefined,
    onDismiss: () => undefined,
  }));

  assert.match(markup, />Unblock Bea\?</);
  assert.match(markup, /be able to send you a contact request again/);
  assert.match(markup, /won&#x27;t be added back to your contacts/);
  assert.match(markup, />Unblock</);
  assert.doesNotMatch(markup, /Report Bea/);
});

test('blocking confirms once and announces the result', async () => {
  const dom = await mountInDom();
  let confirmed = 0;
  let dismissed = 0;
  try {
    await dom.render(createElement(BlockAccountDialog, {
      mode: 'block',
      target,
      onConfirm: async () => { confirmed += 1; },
      onDismiss: () => { dismissed += 1; },
    }));
    await dom.click(dom.findButton('Block'));

    assert.equal(confirmed, 1);
    assert.match(dom.text(), /Bea is blocked\./);
    assert.ok(dom.document.querySelector('[role="status"]'));
    await dom.click(dom.findButton('Done'));
    assert.equal(dismissed, 1);
  } finally {
    await dom.cleanup();
  }
});

test('a failed block keeps the dialog open with the right message', async () => {
  const dom = await mountInDom();
  let attempt = 0;
  try {
    await dom.render(createElement(BlockAccountDialog, {
      mode: 'block',
      target,
      onConfirm: async () => {
        attempt += 1;
        if (attempt === 1) throw new CloudAuthError('network_error', 'offline', 0);
        throw new CloudAuthError('cannot_block_service', 'Kordi service accounts cannot be blocked.', 400);
      },
      onDismiss: () => undefined,
    }));
    await dom.click(dom.findButton('Block'));
    assert.match(dom.text(), /Couldn't block Bea\. Check your connection and try again\./);
    assert.ok(dom.findButton('Block'), 'the person can try again');

    await dom.click(dom.findButton('Block'));
    assert.match(dom.text(), /Kordi service accounts can't be blocked\./);
  } finally {
    await dom.cleanup();
  }
});

test('Escape cancels the dialog', async () => {
  const dom = await mountInDom();
  let dismissed = 0;
  try {
    await dom.render(createElement(BlockAccountDialog, {
      mode: 'unblock',
      target,
      onConfirm: async () => undefined,
      onDismiss: () => { dismissed += 1; },
    }));
    await dom.keydown('Escape');
    assert.equal(dismissed, 1);
  } finally {
    await dom.cleanup();
  }
});

const me = {
  accountId: 'acct_me',
  kordiId: '482731906',
  displayName: 'Me',
  primaryEmail: 'me@example.test',
  avatarUrl: null,
  avatar: {
    entityType: 'human',
    entityId: 'acct_me',
    source: 'generated',
    style: 'lorelei',
    seed: 'me_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 1,
    updatedAt: '2026-10-01T00:00:00Z',
  },
  nodeId: null,
  passwordSet: true,
} as const;

const bea = { accountId: 'acct_bea', kordiId: '123456789', displayName: 'Bea', avatarUrl: null, blockedAt: '2026-10-01T00:00:00Z' };

async function renderProvider(blocksResponse: (blocked: typeof bea[]) => Response) {
  const { SafetyActionsProvider } = await import('../src/features/safety/SafetyActionsContext');
  const { useSafetyActions } = await import('../src/features/safety/safetyActions');
  const { __setSessionBackendForTests } = await import('../src/features/cloud/session');
  const { __resetCloudBlocksForTests } = await import('../src/features/safety/useCloudBlocks');
  const { stubCloudNetwork } = await import('./helpers/safetyDom');
  __resetCloudBlocksForTests();
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: 'acct_me', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  const blocked: typeof bea[] = [];
  const network = stubCloudNetwork(({ method, path }) => {
    if (path === '/v1/cloud/blocks' && method === 'GET') return blocksResponse(blocked);
    if (path === '/v1/cloud/blocks/acct_bea' && method === 'PUT') {
      blocked.splice(0, blocked.length, bea);
      return Response.json({ block: bea, removedContact: true });
    }
    if (path === '/v1/cloud/contacts') return Response.json({ contacts: [] });
    if (path === '/v1/cloud/contacts/requests') return Response.json({ requests: [] });
    return new Response('', { status: 404 });
  });
  function Consumer() {
    const safety = useSafetyActions();
    return createElement('div', null,
      createElement('span', { id: 'state' }, `${safety.safetyFeaturesAvailable ? 'available' : 'hidden'}:${[...safety.blockedAccountIds].join(',')}`),
      createElement('button', { type: 'button', onClick: () => safety.openBlock({ accountId: 'acct_bea', name: 'Bea' }) }, 'open block'));
  }
  const dom = await mountInDom();
  await dom.render(createElement(SafetyActionsProvider, { account: me, children: createElement(Consumer) }));
  return {
    dom,
    network,
    state: () => dom.document.querySelector('#state')?.textContent ?? '',
    async cleanup() {
      await dom.cleanup();
      network.restore();
      __setSessionBackendForTests(null);
      __resetCloudBlocksForTests();
    },
  };
}

test('the safety provider blocks through the hosted route and remembers the block', async () => {
  const view = await renderProvider((blocked) => Response.json({ blocks: blocked }));
  try {
    assert.equal(view.state(), 'available:');
    await view.dom.click(view.dom.findButton('open block'));
    assert.match(view.dom.text(), /Block Bea\?/);
    await view.dom.click(view.dom.findButton('Block'));

    assert.ok(view.network.requests.some((request) => request.method === 'PUT' && request.path === '/v1/cloud/blocks/acct_bea'));
    assert.match(view.dom.text(), /Bea is blocked\./);
    assert.equal(view.state(), 'available:acct_bea');
  } finally {
    await view.cleanup();
  }
});

test('the safety provider hides every action against a server without blocking', async () => {
  const view = await renderProvider(() => new Response('', { status: 404 }));
  try {
    assert.equal(view.state(), 'hidden:');
    await view.dom.click(view.dom.findButton('open block'));
    assert.doesNotMatch(view.dom.text(), /Block Bea\?/);
    assert.ok(view.network.requests.some((request) => request.path === '/v1/cloud/contacts'), 'contacts still load');
  } finally {
    await view.cleanup();
  }
});
