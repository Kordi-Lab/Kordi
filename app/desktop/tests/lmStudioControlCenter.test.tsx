import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  lmStudioDisplayError,
  lmStudioNeedsInstallRefresh,
  lmStudioPageEndAction,
  lmStudioRuntimeActions,
  lmStudioSetupActions,
} from '../src/kordi-app/auth/LmStudioModelControlCenter';

test('lmStudioRuntimeActions keeps chat entry out of the middle runtime controls', () => {
  const actions = lmStudioRuntimeActions({
    activeRunningModelId: 'google/gemma-4-e4b',
    serverRunning: true,
    isSavingConnection: false,
    activeAction: null,
    canEnterChat: true,
  });

  assert.deepEqual(actions.map((action) => action.id), ['refresh', 'stop-model', 'stop-server']);
});

test('lmStudioPageEndAction offers Save & enter chat for a running model', () => {
  const action = lmStudioPageEndAction({
    activeRunningModelId: 'google/gemma-4-e4b',
    canEnterChat: true,
  });

  assert.equal(action?.id, 'save-enter-chat');
  assert.equal(action?.label, 'Save & enter chat');
});

test('lmStudioDisplayError turns invalid passkey stack dumps into repair guidance', () => {
  const raw = '`lms ls --json` failed: [LMStudioClient][Repository][ClientPort][WsClientTransport:AuthenticatedWsClientTransport] WebSocket error: Error: Failed to authenticate: Invalid passkey for lms CLI client. Please make sure you are using the lms shipped with LM Studio. at <anonymous> (/$bunfs/root/lms:106549:35) Error: WebSocket connection closed';

  const message = lmStudioDisplayError(new Error(raw), 'Unable to read installed LM Studio models.');

  assert.equal(lmStudioNeedsInstallRefresh(raw), true);
  assert.match(message, /LM Studio rejected the lms CLI passkey/);
  assert.equal(lmStudioNeedsInstallRefresh(message), true);
  assert.match(message, /Repair lms install/);
  assert.doesNotMatch(message, /\$bunfs\/root/);
});

test('lmStudioSetupActions exposes repair install when passkey is invalid', () => {
  const actions = lmStudioSetupActions({ hasInvalidPasskeyError: true, isConfirmingRefreshInstall: false });

  assert.deepEqual(actions.map((action) => action.id), ['check-setup', 'open-app', 'add-cli-path', 'refresh-install', 'details']);
  assert.equal(actions.find((action) => action.id === 'refresh-install')?.label, 'Repair lms install');
});
