import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cloudGroupHumanAgentTarget, cloudGroupMessageWithAgentTarget } from '../src/features/cloud/cloudGroupAgentTarget';
import { cloudGroupMessageTargetsLocalAgent } from '../src/features/cloud/cloudGroupAgentPolicy';
import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/cloudAgentFallbackClaims';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import type { CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/cloudContactMapping';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';

type Fixture = { name: string; participants: CloudGroupControlEnvelope['participants']; message: NonNullable<CloudGroupControlEnvelope['message']>; expected: { ownerAccountId: string; agentId: string } | null };
const shared: { participants: Fixture['participants']; cases: Fixture[] } = JSON.parse(readFileSync(new URL('../../../shared/agent-targeting/group-cases.json', import.meta.url), 'utf8'));
const cases = shared.cases.map((fixture) => ({ ...fixture, participants: fixture.participants ?? shared.participants }));
for (const fixture of cases) {
  test(`shared group target contract: ${fixture.name}`, () => {
    assert.deepEqual(cloudGroupHumanAgentTarget(fixture.message, fixture.participants), fixture.expected);
    for (const participant of fixture.participants) {
      const account: CloudAccount = { accountId: participant.accountId, displayName: participant.displayName, nodeId: null, primaryEmail: null, avatarUrl: null, avatar: cloudAccountAvatarFixture, passwordSet: true,
        defaultAgent: { agentId: `cloud-agent:${participant.accountId}`, displayName: 'Kordi', avatar: cloudAccountAvatarFixture, avatarUrl: null } };
      assert.equal(cloudGroupMessageTargetsLocalAgent(fixture.message, account, fixture.participants), fixture.expected?.ownerAccountId === participant.accountId);
    }
    const normalized = cloudGroupMessageWithAgentTarget(fixture.message, fixture.participants);
    if (fixture.expected) {
      assert.equal(normalized.targetCloudAgentId, fixture.expected.agentId);
      assert.equal(normalized.targetCloudAgentOwnerAccountId, fixture.expected.ownerAccountId);
    }
  });
}

test('one legacy group send never creates claims for unrelated Kordi contacts', () => {
  const fixture = cases[0];
  const sender = fixture.participants[0];
  const account: CloudAccount = { accountId: sender.accountId, displayName: sender.displayName, nodeId: null, primaryEmail: null, avatarUrl: null, avatar: cloudAccountAvatarFixture, passwordSet: true };
  const contacts = fixture.participants.slice(1).map((p) => ({ ...cloudContactToContact({ ...p, nodeId: null, avatarUrl: null, createdAt: '2026-01-01T00:00:00Z' }), targetCloudAgentId: 'cloud-local-agent', targetCloudAgentName: 'Kordi' }));
  for (const message of [fixture.message, { ...fixture.message, targetCloudAgentId: 'cloud-agent:acct_one', targetCloudAgentOwnerAccountId: 'acct_one' }]) {
    const body = encodeCloudGroupControl({ kind: 'group-message', groupId: 'session:group:targeting', groupTitle: null, createdByAccountId: sender.accountId, actor: sender, participants: fixture.participants, message });
    const messagesByPeer = Object.fromEntries(contacts.map((contact) => [contact.sourceParticipantId!, [{ messageId: `wire-${contact.sourceParticipantId}`, fromAccountId: account.accountId, toAccountId: contact.sourceParticipantId!, body, direction: 'outgoing', createdAt: new Date().toISOString(), deliveredAt: null, readAt: null } satisfies CloudMessage]]));
    const claims = cloudFallbackRunClaimsForMessages({ account, contacts, messagesByPeer });
    assert.deepEqual(claims.map((c) => c.ownerAccountId), message.targetCloudAgentOwnerAccountId ? ['acct_one'] : []);
  }
});
