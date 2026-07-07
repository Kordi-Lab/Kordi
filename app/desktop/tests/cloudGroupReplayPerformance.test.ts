import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const cloudBridgeStateSource = () => readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');

test('cloud group replay persists messages with compact canonical writes instead of full state reloads', () => {
  const source = cloudBridgeStateSource();
  const replayStart = source.indexOf('const messageRequest = {');
  const replayEnd = source.indexOf('const groupMessageIsOwn = envelope.message.senderAccountId === account.accountId;', replayStart);
  assert.notEqual(replayStart, -1, 'expected cloud group replay message request block');
  assert.notEqual(replayEnd, -1, 'expected cloud group replay block end');
  const replayBlock = source.slice(replayStart, replayEnd);

  assert.match(replayBlock, /upsertCanonicalMessageFast\(messageRequest\)/, 'stable-slot updates should use compact upsert');
  assert.match(replayBlock, /appendCanonicalMessageFast\(messageRequest\)/, 'new replay messages should use compact append');
  assert.doesNotMatch(replayBlock, /await upsertCanonicalMessage\(messageRequest\)/, 'replay must not request full canonical state for upserts');
  assert.doesNotMatch(replayBlock, /await appendCanonicalMessage\(messageRequest\)/, 'replay must not request full canonical state for appends');
});

test('cloud group replay prepares identities and sessions with compact canonical writes', () => {
  const source = cloudBridgeStateSource();
  const replayStart = source.indexOf('const participantByAccount = new Map<string, CloudGroupParticipant>();');
  const replayEnd = source.indexOf('if (envelope.kind !== \'group-message\' || !envelope.message)', replayStart);
  assert.notEqual(replayStart, -1, 'expected cloud group participant preparation block');
  assert.notEqual(replayEnd, -1, 'expected cloud group preparation block end');
  const replaySetupBlock = source.slice(replayStart, replayEnd);

  assert.match(replaySetupBlock, /upsertCanonicalIdentityFast\(request\)/, 'participant identities should use compact upsert');
  assert.match(replaySetupBlock, /openOrCreateCanonicalSessionFast\(/, 'group session open should use compact open');
  assert.doesNotMatch(replaySetupBlock, /await upsertCanonicalIdentity\(request\)/, 'participant identity sync must not reload full canonical state per participant');
  assert.doesNotMatch(replaySetupBlock, /await openOrCreateCanonicalSession\(/, 'group replay must not reload full canonical state when opening existing group sessions');
});

test('cloud compact session merge replaces the native participant list for that group', () => {
  const source = cloudBridgeStateSource();
  const mergeStart = source.indexOf('function mergeOpenCanonicalSessionFastResultIntoLocalState');
  const mergeEnd = source.indexOf('export const CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE', mergeStart);
  assert.notEqual(mergeStart, -1, 'expected Cloud compact session merge helper');
  assert.notEqual(mergeEnd, -1, 'expected Cloud compact session merge helper end');
  const mergeBlock = source.slice(mergeStart, mergeEnd);

  assert.match(
    mergeBlock,
    /participant\.sessionId !== result\.session\.id/,
    'Cloud compact session merge must replace all stale local participants for the native group session',
  );
});
