import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';

test('cloud support contact maps to a locked hosted agent contact', () => {
  const contact = cloudContactToContact({
    contactId: 'cloud-system:kordi-support',
    contactKind: 'system_agent',
    accountId: 'acct_support_owner',
    displayName: 'Kordi Support',
    subtitle: 'Ask questions or suggest improvements',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-06-26T00:00:00Z',
    locked: true,
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });

  assert.equal(contact.id, 'cloud-system:kordi-support');
  assert.equal(contact.name, 'Kordi Support');
  assert.equal(contact.entityType, 'agent');
  assert.equal(contact.bridgePeerNodeId, 'acct_support_owner');
  assert.equal(contact.bridgePeerRuntime, 'agent');
  assert.equal(contact.locked, true);
  assert.equal(contact.systemContact, true);
  assert.equal(contact.targetCloudAgentId, 'cloud_agent_kordi_support');
  assert.equal(contact.targetCloudAgentOwnerAccountId, 'acct_support_owner');
});
