import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/sessionReadModel';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { CloudAccount } from '../src/features/cloud/authClient';
import {
  cloudCollaborationConversationId,
  cloudDirectPersonSessionId,
  cloudMessageToCollaborationMessage,
} from '../src/features/cloud/cloudCollaborationState';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { MessageContextMenuContent } from '../src/kordi-app/components/messageContextMenuContent';

test('direct read receipts survive Cloud mapping, canonical hydration, and menu rendering', () => {
  const account: CloudAccount = {
    accountId: 'acct_me', displayName: 'Me', primaryEmail: 'me@example.com',
    avatar: {
      entityType: 'human', entityId: 'acct_me', source: 'generated', style: 'lorelei',
      seed: 'me', rendererVersion: 'test', uploadedAsset: null, version: 1,
      updatedAt: '2026-08-29T00:00:00Z',
    },
    nodeId: 'node_me', passwordSet: true,
  };
  const contact = cloudContactToContact({
    accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null,
    nodeId: 'node_peer', createdAt: '2026-08-29T00:00:00Z',
  });
  const sessionId = cloudDirectPersonSessionId(account.accountId, 'acct_peer');
  const collaborationMessage = cloudMessageToCollaborationMessage(account, {
    messageId: 'msg_read', fromAccountId: account.accountId, toAccountId: 'acct_peer',
    body: 'hello', createdAt: '2026-08-29T00:00:00Z',
    deliveredAt: '2026-08-29T00:00:01Z', readAt: '2026-08-29T00:00:02Z',
    direction: 'outgoing', sessionId,
  }, contact);
  const view = mapCollaborationConversationToViewModel({
    id: cloudCollaborationConversationId('acct_peer', 'person'),
    canonicalSessionId: sessionId,
    peerNodeId: 'acct_peer', peerRuntime: 'person', peerDisplayName: contact.name,
    peerOwnerName: contact.owner, messages: [collaborationMessage],
    unreadCount: 0, updatedAtMs: 1,
  }, undefined, 'Kordi');
  const message = view.messages[0]!;
  const canonicalWithoutReceipt = {
    ...message,
    id: 'canonical_msg_read',
    entryId: 'canonical_entry_read',
    readReceiptSummary: null,
  };
  const hydrated = mergeCanonicalHistoryIntoRuntime([canonicalWithoutReceipt], [message]);
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: hydrated[0]!,
  }));

  assert.equal(collaborationMessage.deliveryState, 'read');
  assert.equal(hydrated[0]?.readReceiptSummary?.participants[0]?.name, 'Peer Person');
  assert.match(markup, /data-message-context-menu-seen-row="true"/);
  assert.match(markup, /1 Seen/);
  assert.match(markup, /title="Seen by Peer Person"/);
});
