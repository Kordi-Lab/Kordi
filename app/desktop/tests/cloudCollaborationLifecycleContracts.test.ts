import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const collaborationSource = () => readFileSync(
  new URL(
    '../src/features/cloud/useCloudCollaborationState.ts',
    import.meta.url,
  ),
  'utf8',
);

const accountLifecycleSource = () => readFileSync(
  new URL(
    '../src/features/cloud/useCloudAccountLifecycleState.ts',
    import.meta.url,
  ),
  'utf8',
);

const readModelSource = () => readFileSync(
  new URL(
    '../src/features/cloud/useCloudCollaborationReadModel.ts',
    import.meta.url,
  ),
  'utf8',
);

const recoveredReplaySource = () => readFileSync(
  new URL(
    '../src/features/cloud/useRecoveredCloudGroupReplay.ts',
    import.meta.url,
  ),
  'utf8',
);

test('Cloud cache stays interactive without becoming authoritative', () => {
  const source = `${collaborationSource()}\n${readModelSource()}`;
  const lifecycleSource = accountLifecycleSource();

  assert.match(
    source,
    /let next = messagesByPeer;[\s\S]*removeCloudSessionMessages\([\s\S]*account\.accountId,[\s\S]*next,[\s\S]*sessionId/,
  );
  assert.match(
    source,
    /return initialMessagesSettled\s*\?\s*routed\s*:\s*suppressCloudCollaborationUnreadCounts\(routed\)/,
  );
  assert.match(source, /defaultCloudMessageCache\(\)/);
  assert.match(
    lifecycleSource,
    /messageCache\.load\(accountId\)[\s\S]*?\.then/,
  );
  assert.match(
    lifecycleSource,
    /hydratedCacheAccountRef\.current === account\.accountId/,
  );
  assert.doesNotMatch(
    source,
    /loadCachedCloudMessagesByPeer|saveCachedCloudMessagesByPeer/,
  );
  assert.match(
    lifecycleSource,
    /loadCloudSessionVisibility\(account\?\.accountId\)/,
  );
  assert.match(
    lifecycleSource,
    /!account[\s\S]*messagesCacheAccountRef\.current !== account\.accountId[\s\S]*saveCloudSessionVisibility/,
  );
  assert.match(source, /messagesByPeer: visibleMessagesByPeer,/);
  assert.match(
    source,
    /useRecoveredCloudGroupReplay\(\{[\s\S]*canonicalSessionState\?\.profile\.humanIdentityId[\s\S]*setCanonicalSessionState[\s\S]*initialMessagesSettled/,
  );
  assert.match(
    recoveredReplaySource(),
    /useCloudAgentTurnRecovery\(\{[\s\S]*initialMessagesSettled[\s\S]*useCloudGroupReplay\(\{[\s\S]*recoverySettled/,
  );
  assert.match(
    recoveredReplaySource(),
    /processedRequestIdsRef,\s*reportWarning,\s*\}\);[\s\S]*messageIndex,\s*applyControl,\s*flushCanonicalState,\s*reportWarning,\s*\}\);/,
    'recovery and replay must pass stable callbacks through during history hydration',
  );
});

test('Cloud group control replay uses bounded coordinator retries', () => {
  const source = collaborationSource();
  const lifecycleSource = accountLifecycleSource();
  const replayEffect = readFileSync(
    new URL(
      '../src/features/cloud/useCloudGroupReplay.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(
    source,
    /new CloudGroupReplayCoordinator<IndexedCloudGroupRow>/,
  );
  assert.match(
    lifecycleSource,
    /groupReplayCoordinator\.changeAccount\(accountId\)/,
  );
  assert.match(replayEffect, /coordinator\.request\(/);
  assert.match(
    replayEffect,
    /entries: replayRows\.map/,
  );
  assert.match(
    replayEffect,
    /fetchExistingCanonicalMessageSources\(uncheckedSources\)/,
  );
  assert.doesNotMatch(
    replayEffect,
    /processedCloudGroupControlIdsRef/,
  );
});

test('Cloud unread reconciliation waits for authoritative sync', () => {
  const source = readFileSync(
    new URL(
      '../src/features/cloud/useCloudCanonicalReconciliation.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const unreadStart = source.indexOf(
    'const unreadBySessionId = cloudGroupUnreadCountsBySessionId({',
  );
  assert.notEqual(
    unreadStart,
    -1,
    'expected Cloud group unread reconciliation effect',
  );
  const guardStart = source.lastIndexOf('if (', unreadStart);
  assert.notEqual(
    guardStart,
    -1,
    'expected Cloud group unread effect guard',
  );
  const guard = source.slice(guardStart, unreadStart);

  assert.match(
    guard,
    /!canonicalState[\s\S]*!authoritative[\s\S]*!unreadContextKey/,
    'cached messages must not persist unread badges before sync',
  );
  assert.match(
    source,
    /setPublishedContextKey\([\s\S]*unreadContextKey/,
  );
});
