import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { DirectConversationConsentNotice } from '../src/features/safety/DirectConversationConsentNotice';
import {
  directConversationConsentState,
  directPersonPeerAccountId,
  type DirectConsentInputs,
} from '../src/features/safety/directConversationConsent';
import { SafetyActionsContext, UNAVAILABLE_SAFETY_ACTIONS, type SafetyActions } from '../src/features/safety/safetyActions';
import { __resetCloudBlocksForTests } from '../src/features/safety/useCloudBlocks';
import { useDirectConversationConsent } from '../src/features/safety/useDirectConversationConsent';
import type { Contact, ContactRequest } from '../src/kordi-app/types';
import { mountInDom, stubCloudNetwork } from './helpers/safetyDom';

const SESSION = 'session:direct-person:acct_bea:acct_me';

function inputs(overrides: {
  contacts?: Partial<DirectConsentInputs['contacts']>;
  blocks?: Partial<DirectConsentInputs['blocks']>;
} = {}): DirectConsentInputs {
  return {
    peerAccountId: 'acct_bea',
    contacts: { contacts: [], requests: [], initialLoadSettled: true, loading: false, error: null, ...overrides.contacts },
    blocks: { blocks: [], loaded: true, available: true, error: null, ...overrides.blocks },
  };
}

const beaContact = { id: 'cloud:acct_bea', sourceParticipantId: 'acct_bea', sourceHumanId: 'acct_bea' } as Contact;
const request = (direction: 'incoming' | 'outgoing'): ContactRequest => ({
  id: 'cloud:req_1',
  initials: 'B',
  title: 'Bea',
  detail: '',
  time: '',
  sourceRequestId: 'req_1',
  requesterNodeId: direction === 'incoming' ? 'acct_bea' : 'acct_me',
  targetNodeId: direction === 'incoming' ? 'acct_me' : 'acct_bea',
  status: 'pending',
  direction,
});
const block = { accountId: 'acct_bea', kordiId: '123456789', displayName: 'Bea', avatarUrl: null, blockedAt: '2026-10-01T00:00:00Z' };

test('the peer is read from person-to-person chats only', () => {
  assert.equal(directPersonPeerAccountId({ id: 'x', canonicalSessionId: SESSION }, 'acct_me'), 'acct_bea');
  assert.equal(directPersonPeerAccountId({ id: `cloud:conversation:acct_bea:person:session:${encodeURIComponent(SESSION)}` }, 'acct_me'), 'acct_bea');
  assert.equal(directPersonPeerAccountId({ id: 'x', canonicalSessionId: SESSION }, 'acct_other'), null, 'not your chat');
  assert.equal(directPersonPeerAccountId({ id: 'x', canonicalSessionId: 'session:group:abc' }, 'acct_me'), null);
  assert.equal(directPersonPeerAccountId({ id: 'x', canonicalSessionId: 'session:direct-system-agent:acct_me' }, 'acct_me'), null);
  assert.equal(directPersonPeerAccountId({ id: 'x', canonicalSessionId: 'session:direct-person:acct_kordi_support:acct_me' }, 'acct_me'), null);
});

test('the five consent states come from the contact and block lists', () => {
  assert.equal(directConversationConsentState(inputs({ contacts: { contacts: [beaContact] } }))?.kind, 'contact');
  assert.equal(directConversationConsentState(inputs({ contacts: { contacts: [beaContact] }, blocks: { blocks: [block] } }))?.kind, 'blocked');
  assert.deepEqual(directConversationConsentState(inputs({ contacts: { requests: [request('incoming')] } })), { peerAccountId: 'acct_bea', kind: 'incoming', requestId: 'req_1' });
  assert.deepEqual(directConversationConsentState(inputs({ contacts: { requests: [request('outgoing')] } })), { peerAccountId: 'acct_bea', kind: 'outgoing', requestId: 'req_1' });
  assert.equal(directConversationConsentState(inputs())?.kind, 'none');
});

test('nothing is shown before both lists load or after a failed refresh', () => {
  assert.equal(directConversationConsentState(inputs({ contacts: { initialLoadSettled: false } })), null);
  assert.equal(directConversationConsentState(inputs({ contacts: { loading: true } })), null);
  assert.equal(directConversationConsentState(inputs({ contacts: { error: 'offline' } })), null);
  assert.equal(directConversationConsentState(inputs({ blocks: { loaded: false } })), null);
  assert.equal(directConversationConsentState(inputs({ blocks: { available: false } })), null);
  assert.equal(directConversationConsentState(inputs({ blocks: { error: 'offline' } })), null);
});

function notice(kind: 'blocked' | 'incoming' | 'outgoing' | 'none') {
  return renderToStaticMarkup(createElement(DirectConversationConsentNotice, {
    id: 'notice', kind, name: 'Bea', busy: false, error: null,
    onUnblock: () => undefined, onAccept: () => undefined, onDecline: () => undefined,
    onBlock: () => undefined, onSendRequest: () => undefined, onWithdraw: () => undefined,
  }));
}

test('each notice explains the state and offers the next step', () => {
  const blocked = notice('blocked');
  assert.match(blocked, /role="status"/);
  assert.match(blocked, /You blocked Bea\. Unblock them to send messages\./);
  assert.match(blocked, />Unblock</);

  const incoming = notice('incoming');
  assert.match(incoming, /Bea wants to connect\. Accept their request to reply\./);
  assert.match(incoming, />Accept<.*>Decline<.*>Block</s);

  const outgoing = notice('outgoing');
  assert.match(outgoing, /Your contact request is waiting for Bea to accept\./);
  assert.match(outgoing, />Withdraw request</);

  const none = notice('none');
  assert.match(none, /You and Bea aren&#x27;t contacts, so you can&#x27;t send messages here\./);
  assert.match(none, />Send contact request<.*>Block</s);
});

test('the composer refuses sends while the notice is shown and describes the send button with it', () => {
  const composer = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  assert.match(composer, /useDirectConversationConsent\(conversation, cloudAccountId\)/);
  assert.match(composer, /routeAccountUnavailable \|\| consent\.blocksSend \? undefined : sendMessage/);
  assert.match(composer, /\{consent\.notice\}/);
  assert.match(composer, /describedBy=\{consent\.noticeId\}/);
  const voiceControls = readFileSync(new URL('../src/pages/chatsPage.voiceControls.tsx', import.meta.url), 'utf8');
  assert.match(voiceControls, /aria-describedby=\{describedBy\}/);
});

test('a chat with a non-contact shows the notice and sends a contact request from it', async () => {
  __resetCloudBlocksForTests();
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: 'acct_me', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  const sent: unknown[] = [];
  const outgoing = {
    requestId: 'req_9', fromAccountId: 'acct_me', toAccountId: 'acct_bea', status: 'pending', direction: 'outgoing',
    message: null, createdAt: '2026-10-01T00:00:00Z', decidedAt: null, counterpart: null,
  };
  const network = stubCloudNetwork(({ method, path }) => {
    if (path === '/v1/cloud/blocks') return Response.json({ blocks: [] });
    if (path === '/v1/cloud/contacts') return Response.json({ contacts: [] });
    if (path === '/v1/cloud/contacts/requests' && method === 'GET') return Response.json({ requests: sent });
    if (path === '/v1/cloud/contacts/requests' && method === 'POST') {
      sent.push(outgoing);
      return Response.json({ request: outgoing }, { status: 201 });
    }
    return new Response('', { status: 404 });
  });
  const safety: SafetyActions = {
    ...UNAVAILABLE_SAFETY_ACTIONS,
    account: { accountId: 'acct_me' } as SafetyActions['account'],
    safetyFeaturesAvailable: true,
  };
  function Composer() {
    const consent = useDirectConversationConsent({ id: SESSION, canonicalSessionId: SESSION, name: 'Bea' }, 'acct_me');
    return createElement('div', null, consent.notice, createElement('span', { id: 'blocks-send' }, String(consent.blocksSend)));
  }
  const dom = await mountInDom();
  try {
    await dom.render(createElement(SafetyActionsContext.Provider, { value: safety }, createElement(Composer)));
    assert.equal(dom.document.querySelector('#blocks-send')?.textContent, 'true');
    assert.match(dom.text(), /You and Bea aren't contacts/);
    await dom.click(dom.findButton('Send contact request'));
    assert.ok(network.requests.some((item) => item.method === 'POST' && item.path === '/v1/cloud/contacts/requests'));
    assert.match(dom.text(), /Your contact request is waiting for Bea to accept\./);
  } finally {
    await dom.cleanup();
    network.restore();
    __setSessionBackendForTests(null);
    __resetCloudBlocksForTests();
  }
});
