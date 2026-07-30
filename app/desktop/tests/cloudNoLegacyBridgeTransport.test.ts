import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  assertCloudAccountId,
  cloudAccountIdOrNull,
  isCloudAccountId,
  isCloudHostId,
  rejectNonCloudCollaborationTargets,
} from '../src/features/cloud/cloudTransportGuards';
import { readKordiAppModelImplementationSource } from './helpers/appModelSource';

const repoRoot = resolve(import.meta.dirname, '..');

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

test('cloud transport guards accept only Cloud host and acct ids', () => {
  assert.equal(isCloudHostId('cloud'), true);
  assert.equal(isCloudHostId('host-local'), false);
  assert.equal(isCloudAccountId('acct_123'), true);
  assert.equal(isCloudAccountId('kh_123'), false);
  assert.equal(isCloudAccountId('node_123'), false);
  assert.equal(cloudAccountIdOrNull(' acct_abc '), 'acct_abc');
  assert.equal(cloudAccountIdOrNull(' kh_abc '), null);
  assert.equal(assertCloudAccountId('acct_abc'), 'acct_abc');
  assert.throws(() => assertCloudAccountId('kh_abc'), /invalid_cloud_account_id/);
});

test('cloud transport guards reject non-cloud group targets', () => {
  assert.deepEqual(rejectNonCloudCollaborationTargets([
    { hostId: 'cloud', nodeId: 'acct_a' },
    { hostId: 'cloud', nodeId: 'acct_b' },
  ]), ['acct_a', 'acct_b']);

  assert.throws(() => rejectNonCloudCollaborationTargets([
    { hostId: 'cloud', nodeId: 'acct_a' },
    { hostId: 'local-host', nodeId: 'kh_local' },
  ]), /non_cloud_target_in_cloud_edition/);
});

test('cloud state hook no longer accepts base desktop bridge state', () => {
  const source = readSource('src/features/cloud/useCloudCollaborationState.ts');
  assert.doesNotMatch(source, /baseBridgeState/);
  assert.doesNotMatch(source, /mergeCloudCollaborationState\(baseBridgeState/);
});

test('active Cloud collaboration models use neutral fields and target kinds', () => {
  for (const file of [
    'src/kordi-app/types.ts',
    'src/features/cloud/cloudCollaborationState.ts',
    'src/features/cloud/useCloudCollaborationState.ts',
    'src/features/chat/messageActions/mentions.ts',
  ]) {
    const source = readSource(file);
    assert.doesNotMatch(
      source,
      /\bbridge(?:HostId|PeerNodeId|PeerRuntime|HumanId|AgentId|ContactStatus|ContactRequestDirection|NodeId|ConversationId|RequestId|Target)\b/,
      file,
    );
    assert.doesNotMatch(source, /targetKind:\s*'bridge-(?:agent|person)'/, file);
  }

  const compatibilitySource = readSource('src/features/collaboration/legacyBridgeCompatibility.ts');
  assert.match(compatibilitySource, /bridgeHostId/);
  assert.match(compatibilitySource, /bridgeNodeId/);
  assert.match(compatibilitySource, /bridgeConversationId/);
  assert.match(compatibilitySource, /bridgeRequestId/);
});

test('cloud app model removes old bridge state hook from main-cloud', () => {
  const source = readKordiAppModelImplementationSource();
  assert.doesNotMatch(source, /useBridgeState/);
  assert.doesNotMatch(source, /useBridgeOrchestration/);
  assert.doesNotMatch(source, /baseBridgeState:\s*baseDesktopCollaborationState/);
  assert.doesNotMatch(source, /enabled:\s*kordiEdition\s*!==\s*'cloud'/);
  const composerCall = source.slice(source.indexOf('useComposerController({'), source.indexOf('  });', source.indexOf('useComposerController({')));
  assert.doesNotMatch(composerCall, /isCloudEdition/);
});

test('main-cloud cloud bridge selection does not call old local bridge read command', () => {
  const source = readSource('src/features/chat/useDesktopSessionController.ts');
  assert.match(source, /sessionId\.startsWith\('bridge:'\)/);
  assert.doesNotMatch(source, /markDesktopCollaborationConversationRead/);
  assert.doesNotMatch(source, /mergeDesktopCollaborationState/);
});

test('main-cloud composer actions do not call old bridge communication commands', () => {
  for (const file of [
    'src/features/chat/messageActions/chatMessages.ts',
    'src/features/chat/messageActions/projectMessages.ts',
  ]) {
    const source = readSource(file);
    assert.doesNotMatch(source, /createDesktopCollaborationOutreach/);
    assert.doesNotMatch(source, /sendDesktopCollaborationMessage/);
    assert.doesNotMatch(source, /openDesktopCollaborationConversation/);
    assert.doesNotMatch(source, /isCloudEdition/);
    assert.doesNotMatch(source, /nonCloudGroupTargets/);
  }
});

test('main-cloud desktop runtime does not install old bridge reach_out transport', () => {
  const chatSource = readSource('src-tauri/src/chat/session_preparation.rs');
  assert.doesNotMatch(chatSource, /set_reach_out_runtime\(Some/);
  assert.doesNotMatch(chatSource, /desktop_bridge_reach_out_impl/);
  assert.doesNotMatch(chatSource, /desktop_bridge_outreach_prompt_context/);

  assert.equal(existsSync(resolve(repoRoot, 'src-tauri/src/bridge')), false);
});

test('main-cloud tauri runtime does not register live desktop bridge communication commands', () => {
  const source = readSource('src-tauri/src/lib.rs');
  const handlerStart = source.indexOf('tauri::generate_handler![');
  assert.notEqual(handlerStart, -1);
  const handlerEnd = source.indexOf('])', handlerStart);
  const handlerBlock = source.slice(handlerStart, handlerEnd);
  for (const command of [
    'desktop_bridge_state',
    'desktop_bridge_send_message',
    'desktop_bridge_create_outreach',
    'desktop_bridge_poll_mailbox',
    'desktop_bridge_refresh_realtime_connections',
    'desktop_bridge_send_presence',
    'desktop_bridge_start_local_server',
    'desktop_bridge_stop_local_server',
  ]) {
    assert.doesNotMatch(handlerBlock, new RegExp(`bridge::${command}`), command);
  }
  assert.doesNotMatch(source, /mod bridge;/);
  assert.doesNotMatch(source, /DesktopCollaborationManager/);
  assert.doesNotMatch(source, /schedule_bridge_realtime_refresh\(app_handle, "app-resumed"\)/);
  assert.doesNotMatch(source, /schedule_bridge_realtime_refresh\(app_handle, "window-focused"\)/);
});

test('cloud-specific tests do not use desktop bridge transport fixtures', () => {
  const cloudTestFiles = [
    'tests/cloudGroupAuthorityState.test.tsx',
    'tests/cloudForwardedMessageState.test.tsx',
    'tests/cloudCollaborationIdentityState.test.tsx',
    'tests/cloudSelfAgentConversationRestore.test.tsx',
    'tests/cloudSelfAgentForkRestore.test.tsx',
    'tests/cloudSelfAgentForkMaterialization.test.tsx',
    'tests/cloudSelfAgentForwardSync.test.tsx',
    'tests/cloudGroupParticipantState.test.tsx',
    'tests/cloudCollaborationUnreadState.test.tsx',
    'tests/cloudAgentDirectExecutionState.test.tsx',
    'tests/cloudAgentPendingState.test.tsx',
    'tests/cloudAgentFallbackClaims.test.tsx',
    'tests/cloudAgentGroupFallback.test.tsx',
    'tests/cloudGroupMembershipAndEnvelopes.test.tsx',
    'tests/cloudGroupParticipantsAndTitles.test.tsx',
    'tests/cloudGroupTitleAndJoinNotices.test.tsx',
    'tests/cloudGroupAgentResponses.test.tsx',
    'tests/cloudGroupUnread.test.tsx',
    'tests/cloudGroupDeliveryAndProfiles.test.tsx',
    'tests/cloudDirectContactSend.test.ts',
    'tests/cloudContactRouting.test.tsx',
  ];
  for (const file of cloudTestFiles) {
    assert.doesNotMatch(readSource(file), /desktop-bridge-(parent|outreach|session-relay|ui)/, file);
  }
});
