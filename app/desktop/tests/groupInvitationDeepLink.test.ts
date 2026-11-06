import assert from 'node:assert/strict';
import { test } from 'node:test';

import { browserPathAfterGroupInvitation, groupInvitationTokenFromUrl } from '../src/features/cloud/groupInvitationDeepLink';

const TOKEN = `kordi_gi_${'a'.repeat(43)}`;

test('group invitation deep links accept only the configured Kordi invitation shape', () => {
  assert.equal(groupInvitationTokenFromUrl(TOKEN), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`kordi://group-invite/${TOKEN}`), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`https://kordi.ai/g/${TOKEN}`), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`kordi://other/${TOKEN}`), null);
  assert.equal(groupInvitationTokenFromUrl('kordi://group-invite/acct_secret'), null);
  assert.equal(groupInvitationTokenFromUrl(`https://evil.example/g/${TOKEN}`), null);
});

test('browser invitations accept one valid token only on the same-origin app route', () => {
  const origin = 'https://example.test';
  assert.equal(groupInvitationTokenFromUrl(`${origin}/app?groupInvite=${TOKEN}`, origin), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`${origin}/app/chats?groupInvite=${TOKEN}`, origin), TOKEN);
  assert.equal(groupInvitationTokenFromUrl(`https://other.test/app?groupInvite=${TOKEN}`, origin), null);
  assert.equal(groupInvitationTokenFromUrl(`${origin}/application?groupInvite=${TOKEN}`, origin), null);
  assert.equal(groupInvitationTokenFromUrl(`${origin}/app?groupInvite=${TOKEN}&groupInvite=${TOKEN}`, origin), null);
  assert.equal(groupInvitationTokenFromUrl(`${origin}/app?groupInvite=invalid`, origin), null);
  assert.equal(groupInvitationTokenFromUrl(`${origin}/app?groupInvite=${TOKEN}`, null), null);
});

test('handling a browser invitation preserves the conversation and unrelated URL state', () => {
  assert.equal(browserPathAfterGroupInvitation(`https://example.test/app/chats/room?view=thread&groupInvite=${TOKEN}#message`, TOKEN), '/app/chats/room?view=thread#message');
  assert.equal(browserPathAfterGroupInvitation(`https://example.test/app?groupInvite=${TOKEN}`, null), null);
  assert.equal(browserPathAfterGroupInvitation(`https://example.test/app?groupInvite=${TOKEN}`, `kordi_gi_${'b'.repeat(43)}`), null);
});
