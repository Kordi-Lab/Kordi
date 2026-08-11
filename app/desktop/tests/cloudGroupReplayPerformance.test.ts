import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const cloudCanonicalStateMergeSource = () => readFileSync(new URL('../src/features/cloud/cloudCanonicalStateMerge.ts', import.meta.url), 'utf8');
const cloudGroupMessageControlSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupMessageControl.ts', import.meta.url), 'utf8');
const cloudGroupSessionControlSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupSessionControl.ts', import.meta.url), 'utf8');
const cloudGroupControlApplicationSource = () => readFileSync(new URL('../src/features/cloud/useCloudGroupControlApplication.ts', import.meta.url), 'utf8');
const cloudGroupReplaySource = () => readFileSync(new URL('../src/features/cloud/useCloudGroupReplay.ts', import.meta.url), 'utf8');
const legacyGroupTitleRecoverySource = () => readFileSync(new URL('../src/features/cloud/useLegacyCloudGroupTitleNoticeRecovery.ts', import.meta.url), 'utf8');
const groupMemberRolesSource = () => readFileSync(
  new URL('../src/app/useKordiGroupMemberRoles.ts', import.meta.url),
  'utf8',
);

test('cloud group replay persists messages with compact canonical writes instead of full state reloads', () => {
  const replayBlock = cloudGroupMessageControlSource();

  assert.match(replayBlock, /const persistedMessage = await upsertCanonicalMessageFast\(messageRequest\)/, 'all replay messages should use compact idempotent upsert');
  assert.doesNotMatch(replayBlock, /appendCanonicalMessageFast\(messageRequest\)/, 'replay must not race another writer through the append-only path');
  assert.doesNotMatch(replayBlock, /await upsertCanonicalMessage\(messageRequest\)/, 'replay must not request full canonical state for upserts');
  assert.doesNotMatch(replayBlock, /await appendCanonicalMessage\(messageRequest\)/, 'replay must not request full canonical state for appends');
});

test('cloud group replay prepares identities and sessions with compact canonical writes', () => {
  const replaySetupBlock = cloudGroupSessionControlSource();

  assert.match(replaySetupBlock, /upsertCanonicalIdentityFast\(request\)/, 'participant identities should use compact upsert');
  assert.match(replaySetupBlock, /openOrCreateCanonicalSessionFast\(/, 'group session open should use compact open');
  assert.match(replaySetupBlock, /for \(const memberLeave of envelope\.memberLeaves \?\? \[\]\)/, 'group replay should apply explicit member removals');
  assert.match(replaySetupBlock, /if \(!isStillActive\) continue/, 'replayed member removals should be idempotent');
  assert.match(replaySetupBlock, /removeCanonicalSessionParticipant\(\{/, 'group replay should persist removed participants as left');
  assert.doesNotMatch(replaySetupBlock, /await upsertCanonicalIdentity\(request\)/, 'participant identity sync must not reload full canonical state per participant');
  assert.doesNotMatch(replaySetupBlock, /await openOrCreateCanonicalSession\(/, 'group replay must not reload full canonical state when opening existing group sessions');
});

test('cloud group replay publishes one coherent React snapshot after each drain', () => {
  const applicationSource = cloudGroupControlApplicationSource();
  const replaySource = cloudGroupReplaySource();

  assert.match(
    applicationSource,
    /canonicalStateRef\.current = nextState/,
    'individual replay rows should advance the synchronous working snapshot',
  );
  assert.match(
    replaySource,
    /await coordinator\.request\([\s\S]*onApplied: flushIfCurrent/,
    'React state should publish from every successful replay batch, including retries',
  );
  assert.doesNotMatch(
    replaySource,
    /cache\.lastReplaySignature = replaySignature;[\s\S]{0,120}await coordinator\.request/,
    'a replay must not be acknowledged before its coordinator request runs',
  );
});

test('cloud group replay skips durable message history before entering the coordinator', () => {
  const replaySource = cloudGroupReplaySource();

  assert.match(
    replaySource,
    /fetchExistingCanonicalMessageSources\(uncheckedSources\)/,
    'the native source index should classify durable rows in one IPC request',
  );
  assert.match(
    replaySource,
    /cloudGroupReplayRowsAfterDurableHistory/,
    'durable message rows should be filtered before sequential replay',
  );
});

test('cloud group replay does not restart native lookups when callback identities change', () => {
  const replaySource = cloudGroupReplaySource();
  const dependencyList = replaySource.slice(
    replaySource.lastIndexOf('}, ['),
    replaySource.lastIndexOf(']);') + 3,
  );

  assert.match(
    replaySource,
    /const applyControlRef = useRef\(applyControl\)[\s\S]*applyControlRef\.current = applyControl/,
    'the replay effect should read the latest row callback without depending on its identity',
  );
  assert.match(
    replaySource,
    /inFlightBySource: Map<string, Promise<void>>[\s\S]*await Promise\.all\(pendingLookups\)/,
    'overlapping data refreshes should share an in-flight durability lookup',
  );
  assert.doesNotMatch(dependencyList, /applyControl|flushCanonicalState|reportWarning/);
  assert.match(dependencyList, /coordinator[\s\S]*contextKey[\s\S]*enabled[\s\S]*messageIndex/);
});

test('legacy group-title repair is local-only and cannot reintroduce v1 transport', () => {
  const replaySource = cloudGroupReplaySource();
  const recoverySource = legacyGroupTitleRecoverySource();

  assert.doesNotMatch(replaySource, /lookupMessageBodies|listLegacyCloudGroupTitleNoticeIds/);
  assert.match(recoverySource, /recoveryRef\.current\?\.contextKey === contextKey/);
  assert.match(recoverySource, /completedContextKeyRef\.current === contextKey/);
  assert.doesNotMatch(recoverySource, /lookupMessageBodies|\/v1\/cloud\/messages|loadSession/);
  assert.match(recoverySource, /canonicalStateRef\.current \?\? current/);
  assert.match(recoverySource, /canonicalStateRef\.current = next/);
});

test('group member removal publishes the current membership and a durable leave event', () => {
  const source = groupMemberRolesSource();
  const removalStart = source.indexOf('const removeGroupMember = useCallback');
  const removalEnd = source.indexOf('const setGroupAdmin = useCallback', removalStart);
  assert.notEqual(removalStart, -1, 'expected group member removal handler');
  assert.notEqual(removalEnd, -1, 'expected group admin handler after group removal');
  const removalBlock = source.slice(removalStart, removalEnd);

  assert.match(removalBlock, /const previousTargets = buildChatGroupCollaborationUpdateTargets/, 'removed members must remain delivery targets for the removal control');
  assert.match(removalBlock, /kind: 'group-update'/, 'member removals should publish a group update');
  assert.match(removalBlock, /memberLeaves: \[removalEvent\]/, 'member removals should carry an explicit leave event');
});

test('cloud compact session merge replaces the native participant list for that group', () => {
  const source = cloudCanonicalStateMergeSource();
  const mergeStart = source.indexOf(
    'export function mergeOpenCanonicalSessionFastResultIntoLocalState',
  );
  assert.notEqual(mergeStart, -1, 'expected Cloud compact session merge helper');
  const mergeBlock = source.slice(mergeStart);

  assert.match(
    mergeBlock,
    /participant\.sessionId !== result\.session\.id/,
    'Cloud compact session merge must replace all stale local participants for the native group session',
  );
});
