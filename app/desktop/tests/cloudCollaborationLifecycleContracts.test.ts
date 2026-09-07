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

const messageStoreSource = () => readFileSync(
  new URL(
    '../src/features/cloud/useCloudCollaborationMessageStore.ts',
    import.meta.url,
  ),
  'utf8',
);

const selfAgentSyncSource = () => readFileSync(
  new URL(
    '../src/features/cloud/useCloudSelfAgentCanonicalSync.ts',
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
    /cloudMessagesUseBrowserCache\(\)[\s\S]*messageCache\.load\(accountId\)[\s\S]*messageCache\.remove\(accountId\)/,
    'native chat must remove rather than merge the pre-cutover browser cache',
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
    /useRecoveredCloudGroupReplay\(\{[\s\S]*canonicalSessionState\?\.profile\.humanIdentityId[\s\S]*setCanonicalSessionState[\s\S]*initialMessagesSettled,/,
  );
  assert.match(
    source,
    /useCloudSelfAgentCanonicalSync\(\{[\s\S]*initialMessagesSettled: recoveryMessagesReady/,
    'agent shells may use the compact cache before native history recovery',
  );
  const recoveredReplay = recoveredReplaySource();
  assert.match(recoveredReplay, /useCloudAgentTurnRecovery\(\{[\s\S]*initialMessagesSettled/);
  assert.match(
    recoveredReplay,
    /const replayEnabled = Boolean\([\s\S]*&& initialMessagesSettled[\s\S]*nativeShell \|\| recoverySettled/,
    'native group recovery must wait until reliable chat bootstrap is durable',
  );
  assert.match(recoveredReplay, /useLegacyCloudGroupTitleNoticeRecovery\(\{\s*enabled: backgroundReplayEnabled/);
  assert.match(recoveredReplay, /useCloudGroupReplay\(\{\s*enabled: backgroundReplayEnabled/);
  assert.match(
    recoveredReplay,
    /useCloudAgentTurnRecovery\(\{[\s\S]*processedRequestIdsRef,\s*reportWarning,\s*\}\);/,
    'interrupted-turn recovery must receive stable hydration callbacks',
  );
  assert.match(
    recoveredReplay,
    /useCloudGroupReplay\(\{[\s\S]*messageIndex,\s*canonicalStateRef,\s*applyControl,\s*flushCanonicalState,\s*onNativeHistorySettled,\s*onSessionSettled,\s*onSettled,\s*reportWarning,\s*\}\);/,
    'current group replay must receive stable callbacks after recovery settles',
  );
  const messageStore = messageStoreSource();
  assert.match(
    messageStore,
    /onNativeGroupRecoverySettled[\s\S]*complete: true/,
    'only the complete native scan may end initial projection tracking',
  );
  assert.match(
    messageStore,
    /if \(!nativeShell \|\| groupProjectionRecoveryComplete\) return EMPTY_SESSION_IDS/,
    'realtime groups after initial recovery must not re-enter cold loading',
  );
  assert.match(
    messageStore,
    /for \(const sessionId of index\.groupRowsBySessionId\.keys\(\)\)[\s\S]*!settledGroupSessionIds\.has\(sessionId\)/,
    'initial projection readiness must settle independently per group session',
  );
  const selfAgentSync = selfAgentSyncSource();
  assert.ok(
    selfAgentSync.indexOf('const headPlan =')
      < selfAgentSync.indexOf('if (!nativeHistory.recovered)'),
    'compact agent session heads must materialize before full native recovery',
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
    /cloudGroupTerminalRepairReplayRows\(/,
  );
  assert.match(
    replayEffect,
    /key: cloudGroupTerminalRepairReplayKey\(row\)/,
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
    'patchCanonicalCloudUnreadCounts(',
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
    /!canonicalState[\s\S]*!authoritative[\s\S]*!unreadBySessionId[\s\S]*!unreadContextKey/,
    'cached messages must not persist unread badges before sync',
  );
  assert.match(
    source,
    /setPublishedContextKey\([\s\S]*unreadContextKey/,
  );
});

test('Cloud receipt reconciliation follows paged canonical history', () => {
  const source = readFileSync(
    new URL(
      '../src/features/cloud/useCloudCanonicalReconciliation.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const receiptEffect = source.slice(
    source.indexOf('patchCanonicalDeliverySummaries('),
    source.indexOf('const activeConversationIds = ['),
  );

  assert.match(receiptEffect, /canonicalState\?\.messages\.length/);
});
