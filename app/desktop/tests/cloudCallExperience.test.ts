import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { callWindowSizeForVideo } from '../src/features/cloud/callWindow';
import { normalizeCloudCall } from '../src/features/cloud/cloudCalls';
import { isIncomingCallInvitation } from '../src/features/cloud/cloudCallState';
import { callUsesAdaptiveVideo } from '../src/features/cloud/useCloudCallMedia';

test('direct calls keep the high video layer while meetings remain adaptive', () => {
  assert.equal(callUsesAdaptiveVideo('voice'), false);
  assert.equal(callUsesAdaptiveVideo('video'), false);
  assert.equal(callUsesAdaptiveVideo('meeting'), true);
});

test('direct remote video preserves the complete camera frame', () => {
  const css = readFileSync(new URL('../src/styles/shell-calls-stage.css', import.meta.url), 'utf8');
  assert.match(css, /\.app-call-remote-video video\s*\{[^}]*object-fit:\s*contain;/s);
});

test('the macOS call window follows the remote camera orientation', () => {
  assert.deepEqual(callWindowSizeForVideo(1_080, 1_920), {
    width: 620,
    height: 720,
    aspectRatio: 0.5625,
  });
  assert.deepEqual(callWindowSizeForVideo(1_920, 1_080), {
    width: 960,
    height: 720,
    aspectRatio: 16 / 9,
  });
});

test('folding hides the native window and anchors its preview at the top right', () => {
  const source = readFileSync(new URL('../src/CallWindow.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/shell-calls-status.css', import.meta.url), 'utf8');
  const capability = readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8');
  assert.match(source, /window\.hide\(\)/);
  assert.match(css, /\.app-call-card-detached\s*\{[^}]*position:\s*fixed;[^}]*top:\s*18px;[^}]*right:\s*18px;/s);
  assert.match(capability, /core:window:allow-hide/);
});

test('the native call window paints its dark surface before web content loads', () => {
  const source = readFileSync(new URL('../src/features/cloud/callWindow.ts', import.meta.url), 'utf8');
  assert.match(source, /transparent:\s*true/);
  assert.match(source, /backgroundColor:\s*'#1b1f23'/);
});

test('only unanswered calls from another account are incoming invitations', () => {
  const incoming = normalizeCloudCall({
    id: 'call-id',
    conversation_id: 'conversation-id',
    kind: 'video',
    state: 'ringing',
    created_by_account_id: 'acct_peer',
    created_at: '2026-08-15T09:00:00Z',
    answered_at: null,
    ended_at: null,
    participants: [
      { account_id: 'acct_peer', state: 'joined' },
      { account_id: 'acct_me', state: 'invited' },
    ],
  });
  assert.ok(incoming);
  assert.equal(isIncomingCallInvitation(incoming, 'acct_me'), true);
  assert.equal(isIncomingCallInvitation({
    ...incoming,
    createdByAccountId: 'acct_me',
  }, 'acct_me'), false);
  assert.equal(isIncomingCallInvitation({
    ...incoming,
    state: 'active',
    answeredAt: '2026-08-15T09:00:01Z',
  }, 'acct_me'), false);
  assert.equal(isIncomingCallInvitation({
    ...incoming,
    state: 'ended',
    endedAt: '2026-08-15T09:01:00Z',
  }, 'acct_me'), false);
});
