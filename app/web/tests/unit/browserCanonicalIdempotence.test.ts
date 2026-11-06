import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBrowserCanonicalCommand } from '@web/runtime/browserCanonicalCommands';
import { browserCanonicalCommandChanged } from '@web/runtime/browserCanonicalChanges';
import { emptyBrowserCanonicalState, openBrowserCanonicalSession, upsertBrowserIdentity,
  upsertBrowserMessage } from '@web/runtime/browserCanonicalProjection';

function state() {
  const value = emptyBrowserCanonicalState('owner', 100);
  openBrowserCanonicalSession(value, { id: 'chat', kind: 'group', createdByIdentityId: 'human:owner',
    participantIdentityIds: ['human:peer'], title: 'Team' }, 100);
  return value;
}
const message = { id: 'one', sessionId: 'chat', senderIdentityId: 'human:peer', senderRole: 'person' as const,
  messageKind: 'text', contentText: 'Hello', createdAtMs: 150, sourceTransport: 'cloud-group', sourceEventId: 'cloud-group:one' };

test('replaying an identical group row leaves the browser projection untouched', () => {
  const value = state();
  upsertBrowserIdentity(value, { id: 'human:peer', kind: 'human', displayName: 'Peer', humanId: 'peer' }, 200);
  upsertBrowserMessage(value, message, 200);
  // The first reopen normalizes the stored metadata; later replays are no-ops.
  openBrowserCanonicalSession(value, { id: 'chat', kind: 'group', createdByIdentityId: 'human:owner',
    participantIdentityIds: ['human:peer'], title: 'Team' }, 200);
  const before = { identities: value.identities, sessions: value.sessions, participants: value.participants,
    messages: value.messages, session: value.sessions[0] };
  const identity = upsertBrowserIdentity(value, { id: 'human:peer', kind: 'human', displayName: 'Peer', humanId: 'peer' }, 900);
  const opened = openBrowserCanonicalSession(value, { id: 'chat', kind: 'group', createdByIdentityId: 'human:owner',
    participantIdentityIds: ['human:peer'], title: 'Team' }, 900);
  const replayed = upsertBrowserMessage(value, message, 900);
  assert.equal(value.identities, before.identities);
  assert.equal(value.sessions, before.sessions);
  assert.equal(value.participants, before.participants);
  assert.equal(value.messages, before.messages);
  assert.equal(identity.updatedAtMs, 200);
  assert.equal(opened.session, before.session);
  assert.equal(replayed.updatedAtMs, 200);
  assert.equal(value.sessions[0].updatedAtMs, before.session.updatedAtMs);
});

test('a real change is still written and reported', () => {
  const value = state();
  upsertBrowserMessage(value, message, 200);
  const edited = upsertBrowserMessage(value, { ...message, contentText: 'Edited' }, 300);
  assert.equal(edited.contentText, 'Edited');
  assert.equal(edited.updatedAtMs, 300);
  const renamed = upsertBrowserIdentity(value, { id: 'human:peer', kind: 'human', displayName: 'Renamed', humanId: 'peer' }, 300);
  assert.equal(renamed.displayName, 'Renamed');
  openBrowserCanonicalSession(value, { id: 'chat', kind: 'group', createdByIdentityId: 'human:owner',
    participantIdentityIds: ['human:third'], title: 'Team' }, 300);
  assert.ok(value.participants.some(row => row.identityId === 'human:third'));
});

test('only commands that changed the stored projection announce a change', () => {
  const value = state();
  const run = (command: string, args: Record<string, unknown>) => browserCanonicalCommandChanged(value, command,
    () => applyBrowserCanonicalCommand(value, command, args, 500)).changed;
  assert.equal(run('desktop_canonical_upsert_message_fast', { request: message }), true);
  assert.equal(run('desktop_canonical_upsert_message_fast', { request: message }), false);
  assert.equal(run('desktop_canonical_upsert_identity_fast', { request: { id: 'human:peer', kind: 'human', displayName: 'Peer' } }), true);
  assert.equal(run('desktop_canonical_upsert_identity_fast', { request: { id: 'human:peer', kind: 'human', displayName: 'Peer' } }), false);
  assert.equal(run('desktop_canonical_rename_session', { request: { sessionId: 'chat', title: 'Renamed' } }), true);
});
