import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { mergeCanonicalIdentity, mergeOpenCanonicalSessionResult } from '@/app/canonicalSessionStateMutations';
import { loadSession } from '@/features/cloud/session';
import type { Agent, CanonicalSessionState } from '@/kordi-app/types';
import { openOrCreateCanonicalSessionFast, upsertCanonicalIdentityFast } from '@/lib/desktop';
import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';
import { loadChatSyncConversations } from '@/lib/desktopChatSync';
import { listPersonalAgentSessions, personalAgentSessionsFromSnapshots, type PersonalAgentSession } from './personalAgentClient';
import { joinPersonalAgents } from './personalAgentEntries';
import { planPersonalAgentSessions, type PersonalAgentSessionPlan } from './personalAgentSessions';
import { setPersonalAgentEntries } from './personalAgentStore';

const RETRY_MS = 30_000;

type Options = {
  accountId: string | null;
  agents: readonly Agent[];
  canonicalState: CanonicalSessionState | null;
  setCanonicalState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  /** Local sessions are created only in the desktop shell, once the canonical catalog has loaded. */
  canCreateSessions: boolean;
  reportWarning?: (message: string, error: unknown) => void;
  list?: (token: string) => Promise<PersonalAgentSession[]>;
  /** Cached chat-sync snapshots, which name personal sessions before the list loads. */
  loadCachedConversations?: (accountId: string) => Promise<ChatSyncConversation[]>;
  createSession?: (plan: PersonalAgentSessionPlan) => Promise<(state: CanonicalSessionState) => CanonicalSessionState>;
};

async function createLocalSession(plan: PersonalAgentSessionPlan) {
  const identity = plan.identity ? await upsertCanonicalIdentityFast(plan.identity) : null;
  const opened = await openOrCreateCanonicalSessionFast(plan.session);
  return (state: CanonicalSessionState) => mergeOpenCanonicalSessionResult(identity ? mergeCanonicalIdentity(state, identity) : state, opened);
}

/**
 * Loads the owner's personal agents on sign-in and whenever their agents
 * change, publishes them for the sidebar and header, and makes sure each has
 * its local session on this Mac.
 */
export function usePersonalAgentSync({
  accountId, agents, canonicalState, setCanonicalState, canCreateSessions, reportWarning,
  list = listPersonalAgentSessions, createSession = createLocalSession, loadCachedConversations = loadChatSyncConversations,
}: Options) {
  const [loaded, setLoaded] = useState<{ accountId: string; sessions: PersonalAgentSession[] } | null>(null);
  const [cached, setCached] = useState<{ accountId: string; sessions: PersonalAgentSession[] } | null>(null);
  const ownedAgentKey = useMemo(() => agents
    .filter((agent) => agent.isOwned && agent.cloudAgentId)
    .map((agent) => agent.cloudAgentId)
    .sort()
    .join(','), [agents]);
  const latest = useRef({ list, reportWarning, loadCachedConversations });
  useEffect(() => { latest.current = { list, reportWarning, loadCachedConversations }; }, [list, loadCachedConversations, reportWarning]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    latest.current.loadCachedConversations(accountId).then(
      (conversations) => { if (!cancelled) setCached({ accountId, sessions: personalAgentSessionsFromSnapshots(conversations) }); },
      () => undefined,
    );
    void (async () => {
      const session = await loadSession();
      if (!session?.token || session.accountId !== accountId) return;
      const sessions = await latest.current.list(session.token);
      if (!cancelled) setLoaded({ accountId, sessions });
    })().catch((error: unknown) => latest.current.reportWarning?.('[personal-agent] could not load personal agents', error));
    return () => { cancelled = true; };
  }, [accountId, ownedAgentKey]);

  const entries = useMemo(() => {
    if (!accountId) return [];
    const sessions = loaded?.accountId === accountId ? loaded.sessions : cached?.accountId === accountId ? cached.sessions : [];
    return joinPersonalAgents(sessions, agents, accountId);
  }, [accountId, agents, cached, loaded]);
  useEffect(() => { setPersonalAgentEntries(entries); }, [entries]);
  useEffect(() => () => setPersonalAgentEntries([]), []);

  const pending = useRef(new Set<string>());
  useEffect(() => {
    if (!canCreateSessions) return;
    for (const plan of planPersonalAgentSessions(entries, agents, canonicalState)) {
      const key = `${plan.session.id}\u0000${plan.session.primaryIdentityId ?? ''}`;
      if (pending.current.has(key)) continue;
      pending.current.add(key);
      createSession(plan).then(
        (merge) => {
          setCanonicalState((current) => (current ? merge(current) : current));
          pending.current.delete(key);
        },
        (error: unknown) => {
          latest.current.reportWarning?.('[personal-agent] could not prepare a personal session', error);
          setTimeout(() => pending.current.delete(key), RETRY_MS);
        },
      );
    }
  }, [agents, canCreateSessions, canonicalState, createSession, entries, setCanonicalState]);

  return entries;
}
