import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { KORDI_PIP_AVATAR_URL, KORDI_SYSTEM_AVATAR_URL } from '../src/features/pip/pipIdentity';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

const pip: CanonicalIdentity = {
  id: 'human:acct_kordi_pip', kind: 'human', displayName: 'PiP', source: 'bridge', sourceHostId: 'cloud',
  sourceIdentityId: 'acct_kordi_pip', humanId: 'acct_kordi_pip', profileImageUrl: KORDI_PIP_AVATAR_URL,
  createdAtMs: 1, updatedAtMs: 1,
} as CanonicalIdentity;

function pipMessage(messageKind: string, text: string): CanonicalSessionMessage {
  return {
    id: `group-message:${messageKind}`,
    sessionId: 'session:group:one',
    senderIdentityId: pip.id,
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

test('system notices show as System with the gray bird and no PiP tag', () => {
  const text = 'Welcome to the group.\nAlex joined. Ask me to plan something together.';
  const message = mapCanonicalMessage(pipMessage('system-notice', text), new Map([[pip.id, pip]]), 'human:me');
  assert.ok(message);
  assert.equal(message.role, 'person');
  assert.equal(message.sender, 'System');
  assert.equal(message.senderProfileImageUrl, KORDI_SYSTEM_AVATAR_URL);
  assert.equal(message.showSenderMeta, true);
  assert.equal(message.text, text);

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenSenderProfile: () => {} }));
  assert.match(markup, />System</);
  assert.match(markup, /kordi-system-avatar\.svg/);
  assert.doesNotMatch(markup, /Built-in agent|kordi-pip-avatar\.svg|PiP/);
  assert.doesNotMatch(markup, /aria-label="Open System profile"/);
  assert.doesNotMatch(markup, /app-system-notice-row/);
});

test('ordinary PiP messages keep the PiP identity', () => {
  const message = mapCanonicalMessage(pipMessage('text', 'Here is the plan.'), new Map([[pip.id, pip]]), 'human:me');
  assert.ok(message);
  assert.equal(message.sender, 'PiP');
  assert.equal(message.senderProfileImageUrl, KORDI_PIP_AVATAR_URL);
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenSenderProfile: () => {} }));
  assert.match(markup, /Built-in agent/);
  assert.match(markup, /aria-label="Open PiP profile"/);
});
