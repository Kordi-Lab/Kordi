import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { KORDI_SYSTEM_AVATAR_URL } from '../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

// The stored ids, and the display name on identities stored before the rename, keep the old name.
const systemAgent: CanonicalIdentity = {
  id: 'human:acct_kordi_pip', kind: 'human', displayName: 'PiP', source: 'bridge', sourceHostId: 'cloud',
  sourceIdentityId: 'acct_kordi_pip', humanId: 'acct_kordi_pip', profileImageUrl: KORDI_SYSTEM_AVATAR_URL,
  createdAtMs: 1, updatedAtMs: 1,
} as CanonicalIdentity;

function systemAgentMessage(messageKind: string, text: string): CanonicalSessionMessage {
  return {
    id: `group-message:${messageKind}`,
    sessionId: 'session:group:one',
    senderIdentityId: systemAgent.id,
    senderRole: 'person',
    messageKind,
    contentText: text,
    content: { schema: 1, blocks: [{ type: 'text', text }] },
    status: 'received',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    sourceTransport: 'cloud-group',
  };
}

test('system notices show as System with the gray bird and no tag', () => {
  const text = 'Welcome to the group.\nAlex joined. Ask me to plan something together.';
  const message = mapCanonicalMessage(systemAgentMessage('system-notice', text), new Map([[systemAgent.id, systemAgent]]), 'human:me');
  assert.ok(message);
  assert.equal(message.role, 'person');
  assert.equal(message.sender, 'System');
  assert.equal(message.senderProfileImageUrl, KORDI_SYSTEM_AVATAR_URL);
  assert.equal(message.showSenderMeta, true);
  assert.equal(message.text, text);

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenSenderProfile: () => {} }));
  assert.match(markup, />System</);
  assert.match(markup, /kordi-system-avatar\.svg/);
  assert.doesNotMatch(markup, /Built-in agent|PiP/);
  assert.doesNotMatch(markup, /aria-label="Open System profile"/);
  assert.doesNotMatch(markup, /app-system-notice-row/);
});

test('plan agent messages show as System too', () => {
  // An identity stored before the server rename still carries the old name and no picture.
  const legacy = { ...systemAgent, displayName: 'PiP', profileImageUrl: undefined } as CanonicalIdentity;
  const message = mapCanonicalMessage(systemAgentMessage('text', 'Here is the plan.'), new Map([[systemAgent.id, legacy]]), 'human:me');
  assert.ok(message);
  assert.equal(message.sender, 'System');
  assert.equal(message.senderProfileImageUrl, KORDI_SYSTEM_AVATAR_URL);
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenSenderProfile: () => {} }));
  assert.match(markup, />System</);
  assert.doesNotMatch(markup, /Built-in agent|PiP|aria-label="Open System profile"/);
});
