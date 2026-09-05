import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAgentDisplayName, firstPersonPossessiveLabel, possessiveScopedLabel, publicScopedAgentMentionHandle } from '../src/lib/identityLabels';
import { cloudDefaultAgentPresentation } from '../src/features/cloud/cloudAgentIdentity';
import type { CloudAccount } from '../src/features/cloud/authClient';

test('default agent names are owner-scoped while handles stay compact and IDs survive renames', () => {
  const account = { accountId: 'acct_owner', displayName: 'Test 111' } as CloudAccount;
  const original = cloudDefaultAgentPresentation(account);
  const renamed = cloudDefaultAgentPresentation(account, 'Review & Plan');
  assert.equal(original.name, "Test 111's Kordi");
  assert.equal(publicScopedAgentMentionHandle(account.displayName, original.name), 'KordiTest111');
  assert.equal(renamed.name, 'Review & Plan');
  assert.equal(renamed.id, original.id);
  assert.equal(original.id, 'cloud-agent:acct_owner');
  assert.equal(defaultAgentDisplayName('Peer', 'Scout'), 'Scout');
  assert.equal(defaultAgentDisplayName('Test 222', 'Kordi'), "Test 222's Kordi");
  assert.equal(publicScopedAgentMentionHandle("O'Neil 🦀", "O'Neil 🦀's Kordi"), 'KordiONeil');
  assert.equal(publicScopedAgentMentionHandle('\u674e \u5c0f\u660e', 'Kordi'), 'Kordi\u674e\u5c0f\u660e');
});

test('first-person labels keep already scoped remote agent names', () => {
  assert.equal(firstPersonPossessiveLabel("Testuser2's Kordi", 'Me'), "Testuser2's Kordi");
  assert.equal(possessiveScopedLabel('Me', "Testuser2's Kordi", true), "Testuser2's Kordi");
});

test('public agent handles lead with the editable agent name without possessive grammar', () => {
  assert.equal(publicScopedAgentMentionHandle('Alex Morgan', 'Scout'), 'ScoutAlexMorgan');
  assert.equal(publicScopedAgentMentionHandle('Alex Morgan', 'Kordi'), 'KordiAlexMorgan');
});

test('first-person labels still scope unscoped local agent names', () => {
  assert.equal(firstPersonPossessiveLabel('Kordi', 'Me'), 'My Kordi');
  assert.equal(possessiveScopedLabel('Me', 'Kordi', true), 'My Kordi');
});
