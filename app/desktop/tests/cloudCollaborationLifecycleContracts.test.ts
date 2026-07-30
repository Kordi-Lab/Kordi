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

test('Cloud cache stays interactive without becoming authoritative', () => {
  const source = collaborationSource();

  assert.match(
    source,
    /let next = currentAccountMessagesByPeer;[\s\S]*removeCloudSessionMessages\(account\.accountId, next, sessionId\)/,
  );
  assert.match(
    source,
    /initialMessagesSettled \? routed : suppressCloudCollaborationUnreadCounts\(routed\)/,
  );
  assert.match(source, /defaultCloudMessageCache\(\)/);
  assert.match(source, /cloudMessageCache\.load\(accountId\)\.then/);
  assert.match(
    source,
    /hydratedMessagesCacheAccountRef\.current === account\.accountId/,
  );
  assert.doesNotMatch(
    source,
    /loadCachedCloudMessagesByPeer|saveCachedCloudMessagesByPeer/,
  );
  assert.match(
    source,
    /loadCloudSessionVisibility\(account\?\.accountId\)/,
  );
  assert.match(
    source,
    /if \(!account \|\| messagesCacheAccountRef\.current !== account\.accountId\) return;[\s\S]*saveCloudSessionVisibility/,
  );
  assert.match(source, /messagesByPeer: visibleMessagesByPeer,/);
  assert.match(
    source,
    /useCloudGroupReplay\(\{[\s\S]*enabled: Boolean\([\s\S]*canonicalSessionState\?\.profile\.humanIdentityId[\s\S]*setCanonicalSessionState[\s\S]*initialMessagesSettled/,
  );
});

test('Cloud group control replay uses bounded coordinator retries', () => {
  const source = collaborationSource();
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
    source,
    /cloudGroupReplayCoordinator\.changeAccount\(accountId\)/,
  );
  assert.match(replayEffect, /coordinator\.request\(/);
  assert.match(
    replayEffect,
    /entries: messageIndex\.replayRows\.map/,
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
