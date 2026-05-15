import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  assertCloudAccountId,
  cloudAccountIdOrNull,
  isCloudAccountId,
  isCloudHostId,
  rejectNonCloudBridgeTargets,
} from '../src/features/cloud/cloudTransportGuards';

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
  assert.deepEqual(rejectNonCloudBridgeTargets([
    { hostId: 'cloud', nodeId: 'acct_a' },
    { hostId: 'cloud', nodeId: 'acct_b' },
  ]), ['acct_a', 'acct_b']);

  assert.throws(() => rejectNonCloudBridgeTargets([
    { hostId: 'cloud', nodeId: 'acct_a' },
    { hostId: 'local-host', nodeId: 'kh_local' },
  ]), /non_cloud_target_in_cloud_edition/);
});

test('cloud state hook no longer accepts base desktop bridge state', () => {
  const source = readSource('src/features/cloud/useCloudBridgeState.ts');
  assert.doesNotMatch(source, /baseBridgeState/);
  assert.doesNotMatch(source, /mergeCloudBridgeState\(baseBridgeState/);
});

test('cloud app model removes old bridge state hook from main-cloud', () => {
  const source = readSource('src/app/useKordiAppModel.ts');
  assert.doesNotMatch(source, /useBridgeState/);
  assert.doesNotMatch(source, /useBridgeOrchestration/);
  assert.doesNotMatch(source, /baseBridgeState:\s*baseDesktopBridgeState/);
  assert.doesNotMatch(source, /enabled:\s*kordiEdition\s*!==\s*'cloud'/);
  const composerCall = source.slice(source.indexOf('useComposerController({'), source.indexOf('  });', source.indexOf('useComposerController({')));
  assert.doesNotMatch(composerCall, /isCloudEdition/);
});

test('main-cloud composer actions do not call old bridge communication commands', () => {
  for (const file of [
    'src/features/chat/messageActions/chatMessages.ts',
    'src/features/chat/messageActions/projectMessages.ts',
  ]) {
    const source = readSource(file);
    assert.doesNotMatch(source, /createDesktopBridgeOutreach/);
    assert.doesNotMatch(source, /sendDesktopBridgeMessage/);
    assert.doesNotMatch(source, /openDesktopBridgeConversation/);
    assert.doesNotMatch(source, /isCloudEdition/);
    assert.doesNotMatch(source, /nonCloudGroupTargets/);
  }
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
  assert.doesNotMatch(source, /schedule_bridge_realtime_refresh\(app_handle, "app-resumed"\)/);
  assert.doesNotMatch(source, /schedule_bridge_realtime_refresh\(app_handle, "window-focused"\)/);
});
