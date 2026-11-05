import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emptyBrowserCanonicalState } from '@web/runtime/browserCanonicalProjection';
import { runBrowserCanonicalCommand } from '@web/runtime/browserCanonicalStorage';
import { scopedCloudGroupCanonicalPersistence } from '@/features/cloud/cloudGroupCanonicalPersistence';
import { applyCloudGroupSessionControl } from '@/features/cloud/cloudGroupSessionControl';
import { __setSessionBackendForTests, saveSession } from '@/features/cloud/session';
import { account, agentAvatar, member, profile } from '../../../desktop/tests/helpers/cloudGroupAgentReply';
import type { CloudAuthClient } from '@/features/cloud/authClient';

test('group replay preserves its source scope through a delayed profile fetch', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const viewer = account('acct_owner', 'Owner', agentAvatar('acct_owner'));
  const peer = account('acct_peer', 'Peer', agentAvatar('acct_peer'));
  const session = { accountId: viewer.accountId, organizationId: 'old-team', token: 'fixture', expiresAt: '2099-01-01T00:00:00Z' };
  __setSessionBackendForTests({ load: async () => session, save: async () => {}, clear: async () => {} });
  let currentOrganization = 'old-team';
  let started!: () => void;
  let respond!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<void>(resolve => { respond = resolve; });
  const state = emptyBrowserCanonicalState(viewer.accountId);
  let published = false;
  mockIPC((command, payload) => runBrowserCanonicalCommand(viewer.accountId, currentOrganization, command, payload ?? {}));
  try {
    const pending = applyCloudGroupSessionControl({
      persistence: scopedCloudGroupCanonicalPersistence(viewer.accountId, currentOrganization),
      cloudMessage: { messageId: 'wire-old', fromAccountId: peer.accountId, toAccountId: viewer.accountId,
        body: '', createdAt: '2026-11-01T00:00:00Z', direction: 'incoming', deliveredAt: null, readAt: null },
      envelope: { kind: 'group-message', groupId: 'old-group', groupTitle: 'Old team',
        createdByAccountId: peer.accountId, actor: member(peer, 'admin'),
        participants: [member(viewer, 'person'), member(peer, 'admin')] },
      historyReplay: true,
      runtime: { account: viewer, sessionPreparationCache: new Map(), profileCache: new Map(),
        client: { getProfile: async () => { started(); await response; return profile(peer, false); } } as unknown as CloudAuthClient },
      canonical: { getState: () => state, setState: () => { published = true; } },
      stateOps: { objectContent: () => ({}), cleanText: value => value ?? '',
        resolveAdminSnapshot: () => { throw new Error('must reject before resolving admins'); },
        resolveSessionTitle: () => null, upsertIdentity: value => value, mergeOpenSession: value => value },
    });
    await requested;
    currentOrganization = 'new-team';
    await saveSession({ ...session, organizationId: currentOrganization });
    respond();
    await assert.rejects(pending, /organization changed/);
    assert.equal(published, false);
  } finally {
    clearMocks(); __setSessionBackendForTests(null);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
