import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldAppendOptimisticCollaborationMessage } from '../src/features/chat/messageActions/collaborationSendLifecycle';
import { cloudSessionIdForCollaborationSend } from '../src/features/cloud/cloudCollaborationState';
import { resolvedCloudConversationIdForCollaborationSend } from '../src/features/chat/messageActions/directHostedAgentTarget';

test('direct Cloud contact sends use an optimistic row so attachments preview immediately', () => {
  assert.equal(shouldAppendOptimisticCollaborationMessage('bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldAppendOptimisticCollaborationMessage('bridge:local:node_peer:person'), true);
});

test('direct Cloud contact sends include stable Cloud session id', () => {
  assert.equal(
    cloudSessionIdForCollaborationSend('acct_me', 'acct_peer', 'bridge:cloud:acct_peer:person'),
    'session:direct-person:acct_me:acct_peer',
  );
  assert.equal(
    cloudSessionIdForCollaborationSend('acct_peer', 'acct_me', 'bridge:cloud:acct_me:person'),
    'session:direct-person:acct_me:acct_peer',
  );
});

test('legacy support selection sends through its scoped system-agent conversation', () => {
  const canonicalSessionId =
    'session:direct-system-agent:acct_me:cloud_agent_kordi_support';
  assert.equal(
    resolvedCloudConversationIdForCollaborationSend(
      'cloud:conversation:acct_kordi_support:agent',
      canonicalSessionId,
    ),
    'cloud:conversation:acct_kordi_support:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
  );
  assert.equal(
    resolvedCloudConversationIdForCollaborationSend(
      'cloud:conversation:acct_kordi_support:agent',
      canonicalSessionId,
      'cloud',
      'acct_real_support_owner',
      'kordi-desktop',
    ),
    'cloud:conversation:acct_real_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
  );
  assert.equal(
    resolvedCloudConversationIdForCollaborationSend(
      'cloud:conversation:acct_peer:person',
      'session:direct-person:acct_me:acct_peer',
    ),
    'cloud:conversation:acct_peer:person',
  );
});

test('canonical Cloud contact selection resolves back to a sendable conversation', () => {
  assert.equal(
    resolvedCloudConversationIdForCollaborationSend(
      'session:direct-person:acct_me:acct_peer',
      'session:direct-person:acct_me:acct_peer',
      'cloud',
      'acct_peer',
      'person',
    ),
    'cloud:conversation:acct_peer:person',
  );
});

test('canonical non-Cloud targets are never converted into Cloud sends', () => {
  assert.equal(
    resolvedCloudConversationIdForCollaborationSend(
      'session:direct-person:local_me:local_peer',
      'session:direct-person:local_me:local_peer',
      'local-bridge',
      'node_peer',
      'person',
    ),
    'session:direct-person:local_me:local_peer',
  );
});
