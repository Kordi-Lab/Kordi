import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { chatDocumentArtifacts } from '../src/features/documents/chatDocuments';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

// Issue 1808: the server posts a document an agent created for a group as the
// agent's message. Members see it in the transcript and in Artifacts.
const agentIdentity = {
  id: 'agent:cloud:acct_owner',
  kind: 'agent',
  displayName: 'Synthetic Agent',
  ownerIdentityId: 'human:acct_owner',
} as CanonicalIdentity;

const documentMessage = {
  id: 'msg:cloud-agent-document:att_agentdoc_1',
  sessionId: 'session:group:g1',
  senderIdentityId: agentIdentity.id,
  senderRole: 'external-agent',
  messageKind: 'agent-turn',
  contentText: '',
  content: {
    sender: 'Synthetic Agent',
    deliveryState: 'complete',
    cloudGroupMessageId: 'msg:cloud-agent-document:att_agentdoc_1',
    attachments: [{
      attachmentId: 'att_agentdoc_1', name: 'Launch plan.md', kind: 'file', mimeType: 'text/markdown', sizeBytes: 32,
    }],
  },
  parentMessageId: null,
  status: 'received',
  sequenceNum: 3,
  createdAtMs: 3,
  updatedAtMs: 3,
  sourceTransport: 'cloud-group-agent',
  sourceEventId: 'cloud-group-agent:msg:cloud-agent-document:att_agentdoc_1',
} as unknown as CanonicalSessionMessage;

test('an agent document message lists its document in the group Artifacts', () => {
  const message = mapCanonicalMessage(
    documentMessage,
    new Map([[agentIdentity.id, agentIdentity]]),
    'human:acct_member',
  );
  assert.ok(message);
  assert.equal(message.attachments?.[0]?.attachmentId, 'att_agentdoc_1');
  const artifacts = chatDocumentArtifacts([message]);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].attachmentId, 'att_agentdoc_1');
  assert.equal(artifacts[0].name, 'Launch plan.md');
  assert.equal(artifacts[0].category, 'artifact');
});

test('an agent turn shows its document card in the transcript', () => {
  const message = mapCanonicalMessage(
    documentMessage,
    new Map([[agentIdentity.id, agentIdentity]]),
    'human:acct_member',
  );
  assert.ok(message?.turn);
  const html = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
  assert.match(html, /Launch plan\.md/);
  assert.doesNotMatch(html, /\/Users\//);
});

test("the owner's stored agent reply gains the document the server attached", async () => {
  const { mergedGroupMessageAttachments } = await import('../src/features/cloud/cloudGroupReplyAttachments');
  const document = { attachmentId: 'att_agentdoc_1', name: 'launch-plan.md', kind: 'file' as const, mimeType: 'text/markdown' };
  // The Mac stored its reply before the server added the document.
  assert.deepEqual(mergedGroupMessageAttachments([], [document], true), [document]);
  // A person's message never gains attachments this way, and nothing new means no update.
  assert.equal(mergedGroupMessageAttachments([], [document], false), null);
  assert.equal(mergedGroupMessageAttachments([document], [document], true), null);
  // A cached copy still fills in its local path.
  const cached = { ...document, localPath: '/tmp/cache/launch-plan.md' };
  assert.deepEqual(mergedGroupMessageAttachments([document], [cached], false), [{ ...document, localPath: cached.localPath }]);
});
