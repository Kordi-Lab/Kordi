import { useCallback, useEffect, useRef, useState } from 'react';

import { normalizeAiAccess } from '@/features/cloud/agentTrustClient';
import type { AiAccessChange, ChatSyncAiAccess } from '@/features/cloud/agentTrustTypes';
import { agentTrustErrorCode, defaultAgentTrustApi, type AgentTrustApi } from './agentTrustApi';
import { onAiAccessUpdated } from './agentTrustEvents';

export type ConversationAiAccessState = {
  /** `unavailable` when the server has no AI access settings for this chat. */
  status: 'loading' | 'ready' | 'unavailable';
  access: ChatSyncAiAccess | null;
  pending: boolean;
  error: string | null;
};

/** Inline error text for a failed AI access change. */
export function aiAccessErrorText(error: unknown): string {
  const code = agentTrustErrorCode(error);
  if (code === 'PIP_UNAVAILABLE') return 'PiP isn\'t available on this server.';
  if (code === 'CHAT_FORBIDDEN') return 'Only group owners and admins can change this.';
  return 'Couldn\'t update AI access. Try again.';
}

/**
 * A conversation's AI access settings: read on mount, again whenever sync
 * announces a change for this session, and replaced by the server's answer
 * after a change. State belongs to one session id; switching sessions shows
 * `loading` until the new answer arrives.
 */
export function useConversationAiAccess(sessionId: string | null | undefined, api: AgentTrustApi = defaultAgentTrustApi()) {
  const normalizedSessionId = sessionId?.trim() || null;
  const [state, setState] = useState<SessionState | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!normalizedSessionId) return;
    const current = ++generation.current;
    try {
      const session = await api.session();
      if (!session) throw new Error('Not signed in.');
      const access = await api.calls.aiAccess(session.token, normalizedSessionId);
      if (current !== generation.current) return;
      setState((previous) => ({
        ...forSession(previous, normalizedSessionId), status: access ? 'ready' : 'unavailable', access,
      }));
    } catch {
      if (current !== generation.current) return;
      // Older servers have no AI access settings; never show stale controls.
      setState((previous) => {
        const base = forSession(previous, normalizedSessionId);
        return { ...base, status: base.access ? 'ready' : 'unavailable' };
      });
    }
  }, [api, normalizedSessionId]);

  useEffect(() => {
    void refresh();
    return onAiAccessUpdated((detail) => {
      if (detail.sessionId === normalizedSessionId || detail.conversationId === normalizedSessionId) void refresh();
    });
  }, [normalizedSessionId, refresh]);

  const update = useCallback(async (change: AiAccessChange): Promise<boolean> => {
    if (!normalizedSessionId) return false;
    setState((previous) => ({ ...forSession(previous, normalizedSessionId), pending: true, error: null }));
    try {
      const session = await api.session();
      if (!session) throw new Error('Not signed in.');
      const conversation = await api.calls.updateAiAccess(session.token, normalizedSessionId, change);
      generation.current += 1;
      const access = normalizeAiAccess(conversation.ai_access);
      setState((previous) => {
        const base = forSession(previous, normalizedSessionId);
        return {
          ...base,
          status: access ? 'ready' : base.status,
          access: access ?? base.access,
          pending: false,
          error: null,
        };
      });
      return true;
    } catch (error) {
      setState((previous) => ({ ...forSession(previous, normalizedSessionId), pending: false, error: aiAccessErrorText(error) }));
      return false;
    }
  }, [api, normalizedSessionId]);

  const view: ConversationAiAccessState = !normalizedSessionId
    ? { status: 'unavailable', access: null, pending: false, error: null }
    : forSession(state, normalizedSessionId);
  const { status, access, pending, error } = view;
  return { status, access, pending, error, refresh, update };
}

type SessionState = ConversationAiAccessState & { sessionId: string };

function forSession(state: SessionState | null, sessionId: string): SessionState {
  return state?.sessionId === sessionId
    ? state
    : { sessionId, status: 'loading', access: null, pending: false, error: null };
}
