import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  canonicalMessageAction,
  canonicalMessageActionSourceReference,
} from '../src/features/canonical/readModel/messageActionMapping';
import { persistedMessageActionSource } from '../src/features/chat/messageActionMetadata';
import { cloudDirectMessageAction, encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudMessageActionFromRecord } from '../src/features/cloud/cloudMessageActionCodec';
import { collaborationMessageActionSourceReference } from '../src/features/collaboration/messageActionPresentation';
import { SourceMessageQuote } from '../src/kordi-app/components/transcriptReplyAttribution';

// The server rewrites a deleted source to this shape: an empty preview, no
// mentions, no attachments, and `sourceDeleted: true`.
function deletedSourceAction(kind: 'quote' | 'thread' = 'quote', marker: Record<string, unknown> = { sourceDeleted: true }) {
  return {
    schemaVersion: 1,
    kind,
    source: {
      sourceSessionId: 'session:direct-person:acct_a:acct_b',
      sourceMessageId: 'message-source',
      sourceMessageKind: 'text',
      senderLabel: 'Alex',
      textPreview: '',
      attachmentCount: 0,
      createdAtMs: 1,
      timeLabel: '10:42',
      ...marker,
    },
  };
}

test('sourceDeleted decodes only when it is true', () => {
  assert.equal(cloudMessageActionFromRecord(deletedSourceAction())?.source.sourceDeleted, true);
  assert.equal(canonicalMessageAction(deletedSourceAction())?.source.sourceDeleted, true);
  for (const marker of [{}, { sourceDeleted: false }, { sourceDeleted: 'true' }, { sourceDeleted: 1 }]) {
    const decoded = cloudMessageActionFromRecord(deletedSourceAction('quote', marker));
    const canonical = canonicalMessageAction(deletedSourceAction('quote', marker));
    assert.ok(decoded && canonical);
    assert.equal('sourceDeleted' in decoded.source, false);
    assert.equal('sourceDeleted' in canonical.source, false);
  }
  const decoded = cloudMessageActionFromRecord(deletedSourceAction());
  assert.ok(decoded);
  assert.equal(persistedMessageActionSource(decoded.source).sourceDeleted, true);
});

test('deleted quote sources reach the transcript reference from every read path', () => {
  const groupAction = cloudMessageActionFromRecord(deletedSourceAction());
  assert.equal(collaborationMessageActionSourceReference(groupAction)?.deleted, true);
  const canonical = canonicalMessageActionSourceReference(canonicalMessageAction(deletedSourceAction()));
  assert.equal(canonical?.deleted, true);
  assert.equal(canonical?.text, '');
  const directBody = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: 'Reply', messageAction: deletedSourceAction() as never,
  });
  const direct = canonicalMessageActionSourceReference(canonicalMessageAction(cloudDirectMessageAction(directBody)));
  assert.equal(direct?.deleted, true);
  assert.equal(canonicalMessageActionSourceReference(canonicalMessageAction(deletedSourceAction('thread'))), null);
  assert.equal(collaborationMessageActionSourceReference(cloudMessageActionFromRecord(deletedSourceAction('quote', {})))?.deleted, undefined);
});

test('a deleted quote source renders a non-interactive notice', () => {
  const deleted = renderToStaticMarkup(createElement(SourceMessageQuote, {
    sourceMessage: { messageId: 'message-source', senderLabel: 'Alex', text: '', deleted: true },
    side: 'peer',
  }));
  assert.doesNotMatch(deleted, /<button/);
  assert.match(deleted, /^<span class="app-source-message-quote" data-quote-side="peer" data-quote-deleted="true"/);
  assert.match(deleted, /title="Alex: Original message was deleted"/);
  assert.match(deleted, /Alex: <\/span><span class="app-source-message-quote-deleted">Original message was deleted<\/span>/);

  const live = renderToStaticMarkup(createElement(SourceMessageQuote, {
    sourceMessage: { messageId: 'message-source', senderLabel: 'Alex', text: 'Still here' },
  }));
  assert.match(live, /^<button type="button" class="app-source-message-quote"/);
  assert.doesNotMatch(live, /Original message was deleted/);
});
