import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cloudSessionIdFromConversationId } from '@/features/collaboration/conversationIds';
import { loadSession } from '@/features/cloud/session';
import { decideProactiveProposal, listPendingProactiveProposals, type ProactiveDecision } from '@/features/cloud/proactiveClient';
import { proactiveProposalExpired, proactiveProposalWithUpdate, type ProactiveProposal } from '@/features/cloud/proactiveOffer';
import type { Conversation } from '@/kordi-app/types';
import { conversationIsGroupChat } from '@/pages/chatsPage.model';
import { subscribeProactiveProposalChanges, type ProactiveProposalChange } from './proactiveProposalEvents';

/** The ids one open conversation is known by: its session ids and, when known, its cloud conversation id. */
export type ProactiveConversationKey = {
  accountId: string | null;
  /** Only cloud groups get proactive offers; one-to-one chats never ask for them. */
  isGroup: boolean;
  sessionIds: readonly string[];
  conversationId: string | null;
};

export type ProactiveConversation = Pick<Conversation, 'id' | 'canonicalSessionId' | 'messages' | 'participantSpaceId' | 'directness'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a cloud conversation id the list route accepts as a filter. */
export function isCloudConversationUuid(value: string | null | undefined): value is string {
  return Boolean(value && UUID_PATTERN.test(value));
}

/** The session ids and cloud conversation id the open conversation is known by. */
export function proactiveConversationKey(
  conversation: ProactiveConversation,
  accountId: string | null | undefined,
): ProactiveConversationKey {
  const sessionIds = [conversation.canonicalSessionId, conversation.id, cloudSessionIdFromConversationId(conversation.id)]
    .map((value) => value?.trim() ?? '')
    .filter((value, index, all) => value && all.indexOf(value) === index);
  const messages = conversation.messages ?? [];
  let conversationId: string | null = null;
  for (let index = messages.length - 1; index >= 0 && !conversationId; index -= 1) {
    conversationId = messages[index]?.reactionConversationId?.trim() || null;
  }
  const isGroup = conversationIsGroupChat(conversation) || conversation.id.startsWith('session:group:');
  return { accountId: accountId?.trim() || null, isGroup, sessionIds, conversationId };
}

/** How long an expired or failed offer stays on screen before it hides. */
export const PROACTIVE_SETTLED_LINGER_MS = 4_000;
const MAX_TIMER_MS = 2_147_483_647;

type Matcher = (target: { sessionId: string | null; conversationId: string | null }) => boolean;

function matcherFor(key: ProactiveConversationKey): Matcher {
  const sessions = new Set(key.sessionIds.filter(Boolean));
  return (target) => Boolean(
    (target.sessionId && sessions.has(target.sessionId))
    || (key.conversationId && target.conversationId === key.conversationId),
  );
}

function hiddenAtOnce(status: ProactiveProposal['status']) {
  return status === 'done' || status === 'declined';
}

function lingers(status: ProactiveProposal['status']) {
  return status === 'expired' || status === 'failed';
}

async function sessionToken(accountId: string): Promise<string | null> {
  const session = await loadSession().catch(() => null);
  return session?.token && session.accountId === accountId ? session.token : null;
}

/**
 * The open conversation's pending proactive offers, for the owner of the
 * agents that made them. Loads when the conversation opens, follows
 * `proactive.proposal_changed` hints, and hides offers once they settle.
 */
export function useProactiveProposals(key: ProactiveConversationKey, nowOverride?: number) {
  const { accountId, conversationId, isGroup } = key;
  const sessionKey = key.sessionIds.join('\n');
  const matches = useMemo(
    () => matcherFor({ accountId, isGroup, conversationId, sessionIds: sessionKey ? sessionKey.split('\n') : [] }),
    [accountId, isGroup, conversationId, sessionKey],
  );
  const [proposals, setProposals] = useState<ProactiveProposal[]>([]);
  const latest = useRef<ProactiveProposal[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const commit = useCallback((next: ProactiveProposal[]) => {
    latest.current = next;
    setProposals(next);
  }, []);
  const remove = useCallback((proposalId: string) => {
    commit(latest.current.filter((item) => item.proposalId !== proposalId));
  }, [commit]);

  const removeLater = useCallback((proposalId: string, delayMs: number) => {
    const previous = timers.current.get(proposalId);
    if (previous) clearTimeout(previous);
    timers.current.set(proposalId, setTimeout(() => {
      timers.current.delete(proposalId);
      remove(proposalId);
    }, Math.min(Math.max(0, delayMs), MAX_TIMER_MS)));
  }, [remove]);

  const applyUpdate = useCallback((proposalId: string, update: unknown) => {
    const item = latest.current.find((candidate) => candidate.proposalId === proposalId);
    if (!item) return;
    const next = proactiveProposalWithUpdate(item, update);
    if (hiddenAtOnce(next.status)) {
      remove(proposalId);
      return;
    }
    commit(latest.current.map((candidate) => candidate.proposalId === proposalId ? next : candidate));
    if (lingers(next.status)) removeLater(proposalId, PROACTIVE_SETTLED_LINGER_MS);
  }, [commit, remove, removeLater]);

  const load = useCallback(async (isCurrent: () => boolean) => {
    if (!accountId || !isGroup || (!sessionKey && !conversationId)) {
      commit([]);
      return;
    }
    const token = await sessionToken(accountId);
    if (!token) {
      if (isCurrent()) commit([]);
      return;
    }
    // A session-id fallback is not a cloud conversation id; the server rejects it,
    // so ask for all pending offers and filter by session below.
    const filter = isCloudConversationUuid(conversationId) ? conversationId : null;
    const list = await listPendingProactiveProposals(token, filter).catch(() => null);
    if (!list || !isCurrent()) return;
    const now = nowOverride ?? Date.now();
    const working = latest.current.filter((item) => item.status !== 'pending' && matches(item));
    const fresh = list.filter((item) => item.status === 'pending' && matches(item) && !proactiveProposalExpired(item, now)
      && !working.some((other) => other.proposalId === item.proposalId));
    commit([...working, ...fresh]);
    for (const item of fresh) {
      if (item.expiresAt) removeLater(item.proposalId, Date.parse(item.expiresAt) - now);
    }
  }, [accountId, isGroup, conversationId, sessionKey, matches, commit, removeLater, nowOverride]);

  useEffect(() => {
    let current = true;
    const isCurrent = () => current;
    if (latest.current.some((item) => !matches(item))) commit(latest.current.filter(matches));
    void load(isCurrent);
    const unsubscribe = subscribeProactiveProposalChanges((change: ProactiveProposalChange) => {
      if (latest.current.some((item) => item.proposalId === change.proposalId)) applyUpdate(change.proposalId, change.payload);
      else if (change.status === 'pending' && matches(change)) void load(isCurrent);
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [load, matches, applyUpdate, commit]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const decide = useCallback(async (proposal: ProactiveProposal, decision: ProactiveDecision) => {
    const token = accountId ? await sessionToken(accountId) : null;
    if (!token) throw new Error('Sign in to respond.');
    const result = await decideProactiveProposal(token, proposal.agentId, proposal.proposalId, decision);
    applyUpdate(proposal.proposalId, { status: decision === 'allow' ? 'approved' : 'declined' });
    applyUpdate(proposal.proposalId, result);
    return result;
  }, [accountId, applyUpdate]);

  return { proposals, decide };
}
