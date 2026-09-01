import assert from 'node:assert/strict';
import test from 'node:test';

import { firstPersonPossessiveLabel, possessiveScopedLabel, publicScopedAgentMentionHandle } from '../src/lib/identityLabels';

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
