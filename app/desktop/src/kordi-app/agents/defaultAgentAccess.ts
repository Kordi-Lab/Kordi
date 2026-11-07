import { useCallback, useEffect, useState } from 'react';
import { getAgentAccess, setAgentAccess } from '@/features/cloud/agentAccessClient';
import type { CloudAgentAccessScope } from '@/features/cloud/cloudAgentsClient';
import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import { defaultAgentProactiveId } from '@/features/cloud/proactiveClient';
import { loadSession } from '@/features/cloud/session';
import type { Agent } from '../types';

/** The Factory draft's access value for a scope. */
export function builderAccessValue(scope: CloudAgentAccessScope) {
  return scope === 'private' ? 'only-me' : 'participant-conversations';
}

/** A Factory draft's scope: only an explicit "only-me" is private. */
export function builderAccessScope(access: string | undefined): CloudAgentAccessScope {
  return access === 'only-me' ? 'private' : 'participant_conversations';
}

/**
 * The agent as the Factory shows it: a scope published in this session wins,
 * then the default agent's stored Access, then its own.
 */
export function withPublishedAccess(
  agent: Agent | undefined,
  publishedById: Record<string, CloudAgentAccessScope>,
  defaultAccess: CloudAgentAccessScope | null,
): Agent | undefined {
  if (!agent) return agent;
  const scope = publishedById[agent.id]
    ?? (defaultAccess && !agent.cloudAgentId && usesDefaultLocalAgentSession(agent) ? defaultAccess : undefined);
  return scope ? { ...agent, cloudAgentAccessScope: scope } : agent;
}

/**
 * The owner's default agent keeps its Access on the server under
 * `cloud-agent:<accountId>`, like a Factory agent. `published` stays null
 * while signed out or before the fetch lands; the Factory then shows the
 * default, "People in my chats can mention it".
 */
export function useDefaultAgentAccess(cloudAccountId?: string | null) {
  const [published, setPublished] = useState<{ accountId: string; scope: CloudAgentAccessScope } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token || !session.accountId) return null;
      const scope = await getAgentAccess(session.token, defaultAgentProactiveId(session.accountId));
      return { accountId: session.accountId, scope };
    })().then((next) => { if (!cancelled) setPublished(next); }, () => { if (!cancelled) setPublished(null); });
    return () => { cancelled = true; };
  }, [cloudAccountId]);
  const publish = useCallback(async (scope: CloudAgentAccessScope) => {
    const session = await loadSession();
    if (!session?.token || !session.accountId) throw new Error('Sign in to change access.');
    const saved = await setAgentAccess(session.token, defaultAgentProactiveId(session.accountId), scope);
    setPublished({ accountId: session.accountId, scope: saved });
  }, []);
  const current = published && (!cloudAccountId || published.accountId === cloudAccountId) ? published.scope : null;
  return { published: current, publish };
}
