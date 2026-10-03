import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentActionDecision, PendingAgentAction } from '@/features/cloud/agentTrustTypes';
import { agentTrustErrorCode, defaultAgentTrustApi, type AgentTrustApi } from './agentTrustApi';
import { onAgentActionUpdated } from './agentTrustEvents';
import { pendingActionAnnouncement, pendingActionCopy, pendingActionErrorText } from './pendingActionCopy';

/** Actions that need a person only arise in chats shared with other people. */
const SHARED_SESSION_PREFIXES = ['session:group:', 'session:direct-person:'];
/** setTimeout's largest delay. */
const MAX_TIMER_MS = 2_147_483_647;

export function sessionCanHavePendingActions(sessionId: string | null | undefined): sessionId is string {
  const id = sessionId?.trim() ?? '';
  return SHARED_SESSION_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export type PendingActionsAnnouncement = { id: number; text: string };

export type PendingAgentActionsState = {
  /** False for chats that cannot have actions; nothing is loaded for them. */
  enabled: boolean;
  actions: PendingAgentAction[];
  /** The action whose decision is being saved. */
  decidingId: string | null;
  error: string | null;
  /** The latest polite announcement; `id` changes even when the text repeats. */
  announcement: PendingActionsAnnouncement | null;
};

type SessionState = Omit<PendingAgentActionsState, 'enabled'> & { sessionId: string };

function forSession(state: SessionState | null, sessionId: string): SessionState {
  return state?.sessionId === sessionId
    ? state
    : { sessionId, actions: [], decidingId: null, error: null, announcement: null };
}

function belongsTo(action: PendingAgentAction, sessionId: string): boolean {
  return !action.sessionId || action.sessionId === sessionId || action.conversationId === sessionId;
}

function isOpenFor(action: PendingAgentAction, sessionId: string, nowMs: number): boolean {
  if (action.status !== 'pending' || !belongsTo(action, sessionId)) return false;
  const expiresAt = Date.parse(action.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > nowMs;
}

/** What a screen reader hears when new actions arrive. */
export function newPendingActionsAnnouncement(actions: readonly PendingAgentAction[]): string {
  const [first] = actions;
  if (!first) return '';
  if (actions.length === 1) return `Waiting for you: ${pendingActionCopy(first).title}`;
  return `${actions.length} requests are waiting for you.`;
}

let announcementCounter = 0;
function announce(text: string): PendingActionsAnnouncement {
  announcementCounter += 1;
  return { id: announcementCounter, text };
}

/**
 * Actions waiting for the signed-in person in one shared chat: read when the
 * chat opens, when the window regains focus, when sync announces a change,
 * and when the earliest shown action expires. New actions are announced once.
 */
export function usePendingAgentActions(sessionId: string | null | undefined, api: AgentTrustApi = defaultAgentTrustApi()) {
  const normalizedSessionId = sessionCanHavePendingActions(sessionId) ? sessionId.trim() : null;
  const [state, setState] = useState<SessionState | null>(null);
  const generation = useRef(0);
  const announced = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!normalizedSessionId) return;
    const current = ++generation.current;
    try {
      const session = await api.session();
      if (!session) return;
      const loaded = await api.calls.listAgentActions(session.token, normalizedSessionId);
      if (current !== generation.current) return;
      const nowMs = Date.now();
      const actions = loaded.filter((action) => isOpenFor(action, normalizedSessionId, nowMs));
      const fresh = actions.filter((action) => !announced.current.has(action.actionId));
      fresh.forEach((action) => announced.current.add(action.actionId));
      setState((previous) => {
        const base = forSession(previous, normalizedSessionId);
        return {
          ...base,
          actions,
          announcement: fresh.length ? announce(newPendingActionsAnnouncement(fresh)) : base.announcement,
        };
      });
    } catch {
      // Older servers have no actions that need a person; keep what is shown.
    }
  }, [api, normalizedSessionId]);

  useEffect(() => {
    if (!normalizedSessionId || typeof window === 'undefined') return undefined;
    void refresh();
    const handleFocus = () => { void refresh(); };
    window.addEventListener('focus', handleFocus);
    const stopListening = onAgentActionUpdated(({ action }) => {
      if (!action || belongsTo(action, normalizedSessionId)) void refresh();
    });
    return () => {
      window.removeEventListener('focus', handleFocus);
      stopListening();
    };
  }, [normalizedSessionId, refresh]);

  const view = normalizedSessionId ? forSession(state, normalizedSessionId) : null;
  const nextExpiryMs = (view?.actions ?? []).reduce<number | null>((earliest, action) => {
    const expiresAt = Date.parse(action.expiresAt);
    if (!Number.isFinite(expiresAt)) return earliest;
    return earliest === null ? expiresAt : Math.min(earliest, expiresAt);
  }, null);

  useEffect(() => {
    if (nextExpiryMs === null || typeof window === 'undefined') return undefined;
    const delay = Math.min(Math.max(0, nextExpiryMs - Date.now()) + 1_000, MAX_TIMER_MS);
    const timer = window.setTimeout(() => { void refresh(); }, delay);
    return () => window.clearTimeout(timer);
  }, [nextExpiryMs, refresh]);

  const decide = useCallback(async (action: PendingAgentAction, decision: AgentActionDecision): Promise<boolean> => {
    if (!normalizedSessionId) return false;
    setState((previous) => ({
      ...forSession(previous, normalizedSessionId), decidingId: action.actionId, error: null,
    }));
    try {
      const session = await api.session();
      if (!session) throw new Error('Not signed in.');
      await api.calls.decideAgentAction(session.token, action.actionId, decision);
      // A list read that started before the decision may still show it.
      generation.current += 1;
      setState((previous) => {
        const base = forSession(previous, normalizedSessionId);
        return {
          ...base,
          actions: base.actions.filter((item) => item.actionId !== action.actionId),
          decidingId: null,
          error: null,
          announcement: announce(pendingActionAnnouncement(action, decision)),
        };
      });
      void refresh();
      return true;
    } catch (error) {
      const code = agentTrustErrorCode(error);
      setState((previous) => ({
        ...forSession(previous, normalizedSessionId), decidingId: null, error: pendingActionErrorText(code),
      }));
      // The action may be gone or changed; show what is still waiting.
      if (code === 'agent_action_closed' || code === 'plan_changed' || code === 'agent_action_not_found') {
        void refresh();
      }
      return false;
    }
  }, [api, normalizedSessionId, refresh]);

  const dismissError = useCallback(() => {
    if (!normalizedSessionId) return;
    setState((previous) => ({ ...forSession(previous, normalizedSessionId), error: null }));
  }, [normalizedSessionId]);

  const result: PendingAgentActionsState = view
    ? { enabled: true, actions: view.actions, decidingId: view.decidingId, error: view.error, announcement: view.announcement }
    : { enabled: false, actions: [], decidingId: null, error: null, announcement: null };
  return { ...result, refresh, decide, dismissError };
}
