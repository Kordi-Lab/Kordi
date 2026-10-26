import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { planCloudSelfAgentSessionReconciliation } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { publishCloudAgentIdentityMarkers } from '../src/features/cloud/cloudSelfAgentSessionIdentity';
import { joinPersonalAgents } from '../src/features/personalAgent/personalAgentEntries';
import { planPersonalAgentSessions } from '../src/features/personalAgent/personalAgentSessions';
import { setPersonalAgentEntries } from '../src/features/personalAgent/personalAgentStore';
import type { Agent, CanonicalSessionState } from '../src/kordi-app/types';

const ACCOUNT = 'acct_alex';
const DEFAULT_ID = `cloud-agent:${ACCOUNT}`;
const KORDI_SESSION = `session:self-agent:${ACCOUNT}:personal:${DEFAULT_ID}`;
const RESEARCH_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_research`;
const ORDINARY_SESSION = 'session:direct-agent:ordinary-research-chat';

const kordi = { id: 'desktop:local-agent', name: "Alex's Kordi", role: 'Assistant', isOwned: true, systemPrompt: '', loadedTools: [], loadedSkills: [], loadedPlugins: [], contactId: 'desktop:local-agent' } as unknown as Agent;
const research = { id: 'cloud-agent:cloud_agent_research', name: 'Research agent', role: 'Research', isOwned: true, cloudAgentId: 'cloud_agent_research', systemPrompt: 'Read.', loadedTools: [], loadedSkills: [], loadedPlugins: [], contactId: 'cloud-agent:cloud_agent_research' } as unknown as Agent;
const entries = joinPersonalAgents([
  { agentId: DEFAULT_ID, conversationId: 'conv-kordi', sessionId: KORDI_SESSION, proactive: true },
  { agentId: 'cloud_agent_research', conversationId: 'conv-research', sessionId: RESEARCH_SESSION, proactive: true },
], [kordi, research], ACCOUNT);

const identities = [
  { id: 'human:alex', kind: 'human', displayName: 'Alex' },
  { id: 'agent:local', kind: 'agent', displayName: "Alex's Kordi", ownerIdentityId: 'human:alex' },
  // The cloud mirror's identity for the default agent, which a mirrored personal session keeps.
  { id: `agent:cloud-self:${ACCOUNT}`, kind: 'agent', agentId: DEFAULT_ID, displayName: "Alex's Kordi", ownerIdentityId: 'human:alex', metadata: { cloudSelfAgent: true, accountId: ACCOUNT } },
];

function baseState(sessions: unknown[]) {
  return { profile: { humanIdentityId: 'human:alex', activeAgentIdentityId: 'agent:local' }, identities, sessions, participants: [], messages: [], contextSnapshots: [] } as unknown as CanonicalSessionState;
}

function remote(sessionId: string): ChatSyncConversation {
  return { id: `conv:${sessionId}`, kind: 'ai', legacy_session_id: sessionId, latest_message_sequence: 0, created_at: '2026-10-25T00:00:00Z' } as unknown as ChatSyncConversation;
}

test('preparing personal sessions publishes no identity marker; an ordinary agent chat keeps its marker', async () => {
  // The sessions exactly as this Mac prepares them, plus the default one as the cloud mirror files it.
  const prepared = planPersonalAgentSessions(entries, [kordi, research], baseState([]));
  const identityRequests = prepared.flatMap((plan) => plan.identity ? [{ ...plan.identity, metadata: { ...(plan.identity.metadata as Record<string, unknown>), isOwned: true } }] : []);
  const factory = prepared.find((plan) => plan.session.id === RESEARCH_SESSION)!.session;
  const mirroredDefault = {
    id: KORDI_SESSION, kind: 'self-agent', title: "Alex's Kordi", status: 'active', createdByIdentityId: 'human:alex',
    primaryIdentityId: `agent:cloud-self:${ACCOUNT}`, metadata: { cloudSelfAgentSession: true, personalAgent: { agentId: DEFAULT_ID } },
  };
  // An ordinary chat started with the same Factory agent.
  const ordinary = { ...factory, id: ORDINARY_SESSION, metadata: { ...(factory.metadata as Record<string, unknown>), personalAgent: undefined } };
  const state = {
    ...baseState([mirroredDefault, factory, ordinary]),
    identities: [...identities, ...identityRequests],
  } as unknown as CanonicalSessionState;
  const conversations = [remote(KORDI_SESSION), remote(RESEARCH_SESSION), remote(ORDINARY_SESSION)];

  for (const listed of [false, true]) {
    setPersonalAgentEntries(listed ? entries : [], listed);
    try {
      const plans = planCloudSelfAgentSessionReconciliation(state, conversations);
      assert.equal(plans.some((plan) => plan.sessionId === KORDI_SESSION || plan.sessionId === RESEARCH_SESSION), false, `listed=${listed}`);
      // The existing behavior for an ordinary chat with an owned agent is unchanged.
      assert.deepEqual(plans.find((plan) => plan.sessionId === ORDINARY_SESSION)?.targetAgentId, 'cloud_agent_research');

      const sent: Array<{ sessionId?: string }> = [];
      await publishCloudAgentIdentityMarkers({
        accountId: ACCOUNT, token: 'token', ledger: {}, plans: plans.filter((plan) => plan.sessionId !== ORDINARY_SESSION),
        client: { sendMessage: async (_token, _peer, _body, options) => { sent.push(options ?? {}); return { messageId: 'm' } as never; } },
      });
      assert.deepEqual(sent, [], `listed=${listed}`);
    } finally {
      setPersonalAgentEntries([], false);
    }
  }
});
