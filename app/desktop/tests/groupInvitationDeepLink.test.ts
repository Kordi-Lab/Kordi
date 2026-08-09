import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupInvitationTokenFromUrl } from '../src/features/cloud/groupInvitationDeepLink';

const TOKEN = `kordi_gi_${'a'.repeat(43)}`;

test('group invitation deep links accept only the configured Kordi invitation shape', () => {
  assert.equal(groupInvitationTokenFromUrl(TOKEN), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`kordi://group-invite/${TOKEN}`), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`https://kordi.ai/g/${TOKEN}`), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`kordi://other/${TOKEN}`), null);
  assert.equal(groupInvitationTokenFromUrl('kordi://group-invite/acct_secret'), null);
  assert.equal(groupInvitationTokenFromUrl(`https://evil.example/g/${TOKEN}`), null);
});
