import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { mergeCanonicalIdentity, mergeOpenCanonicalSessionResult } from '@/app/canonicalSessionStateMutations';
import { loadSession } from '@/features/cloud/session';
import type { Agent, CanonicalSessionState } from '@/kordi-app/types';
import { openOrCreateCanonicalSessionFast, upsertCanonicalIdentityFast } from '@/lib/desktop';
import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';
import { loadChatSyncConversations } from '@/lib/desktopChatSync';
import { listPersonalAgentSessions, markerlessSnapshotSessionIds, personalAgentSessionsFromSnapshots, type PersonalAgentSession } from './personalAgentClient';
import { joinPersonalAgents, personalAgentMarker } from './personalAgentEntries';
import { planPersonalAgentMarkerRemovals, planPersonalAgentSessions, type PersonalAgentSessionPlan } from './personalAgentSessions';
import { loadUntilSuccess } from './personalAgentListRetry';
import { setPersonalAgentEntries, subscribePersonalAgentsRefresh } from './personalAgentStore';

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
  /** Waits between list retries; tests shorten them. */
  retryDelaysMs?: readonly number[];
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
  list = listPersonalAgentSessions, createSession = createLocalSession, loadCachedConversations = loadChatSyncConversations, retryDelaysMs,
}: Options) {
  const [loaded, setLoaded] = useState<{ accountId: string; sessions: PersonalAgentSession[] } | null>(null);
  const [cached, setCached] = useState<{ accountId: string; sessions: PersonalAgentSession[]; markerless: Set<string> } | null>(null);
  // A Factory agent's Proactive change reloads the list at once: the agent
  // list refreshes after its update, which changes this key.
  const ownedAgentKey = useMemo(() => agents
    .filter((agent) => agent.isOwned && agent.cloudAgentId)
    .map((agent) => `${agent.cloudAgentId}:${agent.cloudAgentPersonalAgent?.proactive === true}`)
    .sort()
    .join(','), [agents]);
  // The default agent's Proactive change asks for a reload explicitly.
  const [refreshCount, setRefreshCount] = useState(0);
  useEffect(() => subscribePersonalAgentsRefresh(() => setRefreshCount((count) => count + 1)), []);
  const latest = useRef({ list, reportWarning, loadCachedConversations, retryDelaysMs });
  useEffect(() => { latest.current = { list, reportWarning, loadCachedConversations, retryDelaysMs }; }, [list, loadCachedConversations, reportWarning, retryDelaysMs]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    latest.current.loadCachedConversations(accountId).then(
      (conversations) => {
        if (!cancelled) setCached({ accountId, sessions: personalAgentSessionsFromSnapshots(conversations), markerless: markerlessSnapshotSessionIds(conversations) });
      },
      () => undefined,
    );
    const stop = loadUntilSuccess(async () => {
      const session = await loadSession();
      if (!session?.token || session.accountId !== accountId) return false;
      const sessions = await latest.current.list(session.token);
      if (!cancelled) setLoaded({ accountId, sessions });
      return true;
    }, {
      onError: (error) => latest.current.reportWarning?.('[personal-agent] could not load personal agents', error),
      ...(latest.current.retryDelaysMs ? { delaysMs: latest.current.retryDelaysMs } : {}),
    });
    return () => { cancelled = true; stop(); };
  }, [accountId, ownedAgentKey, refreshCount]);

  // The last loaded list is the source; while none has loaded, the cached snapshots.
  // A failed request keeps the previous source, so it never strips anything.
  const listLoaded = Boolean(accountId && loaded?.accountId === accountId);
  const snapshotLoaded = Boolean(accountId && cached?.accountId === accountId);
  const entries = useMemo(() => {
    if (!accountId) return [];
    const sessions = listLoaded ? loaded!.sessions : snapshotLoaded ? cached!.sessions : [];
    return joinPersonalAgents(sessions, agents, accountId);
  }, [accountId, agents, cached, listLoaded, loaded, snapshotLoaded]);
  useEffect(() => { setPersonalAgentEntries(entries, listLoaded || snapshotLoaded); }, [entries, listLoaded, snapshotLoaded]);
  useEffect(() => () => setPersonalAgentEntries([], false), []);

  const pending = useRef(new Set<string>());
  useEffect(() => {
    if (!canCreateSessions) return;
    const removals = listLoaded || snapshotLoaded ? planPersonalAgentMarkerRemovals(canonicalState, {
      listedSessionIds: listLoaded ? new Set(entries.map((entry) => entry.sessionId)) : null,
      markerlessSnapshotSessionIds: cached?.markerless ?? new Set(),
    }) : [];
    for (const plan of [...planPersonalAgentSessions(entries, agents, canonicalState), ...removals]) {
      const key = `${plan.session.id}\u0000${plan.session.primaryIdentityId ?? ''}\u0000${personalAgentMarker(plan.session.metadata) ?? 'strip'}`;
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
  }, [agents, cached, canCreateSessions, canonicalState, createSession, entries, listLoaded, setCanonicalState, snapshotLoaded]);

  return entries;
}
