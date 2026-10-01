import { useEffect, useRef, useState } from 'react';

import type { ReplyDisclosure, ReplyDisclosureRequest } from '@/features/cloud/agentTrustTypes';
import { agentTrustErrorStatus, defaultAgentTrustApi, type AgentTrustApi } from './agentTrustApi';

export type ReplyDisclosureState =
  | { status: 'loading'; disclosure: null }
  | { status: 'ready'; disclosure: ReplyDisclosure }
  | { status: 'missing'; disclosure: null }
  | { status: 'error'; disclosure: null };

type Pending = { reply: ReplyDisclosureRequest; resolve: (value: ReplyDisclosure | null) => void; reject: (error: unknown) => void };

const MAX_BATCH = 50;
const cache = new Map<string, Promise<ReplyDisclosure | null>>();
const queues = new Map<string, { api: AgentTrustApi; sessionId: string; pending: Pending[] }>();

function cacheKey(sessionId: string, reply: ReplyDisclosureRequest) {
  return [sessionId, reply.ownerAccountId, reply.requestId].join('\u0000');
}

async function flush(queueKey: string) {
  const queue = queues.get(queueKey);
  queues.delete(queueKey);
  if (!queue) return;
  for (let start = 0; start < queue.pending.length; start += MAX_BATCH) {
    const batch = queue.pending.slice(start, start + MAX_BATCH);
    try {
      const session = await queue.api.session();
      if (!session) throw new Error('Not signed in.');
      const disclosures = await queue.api.calls.replyDisclosures(
        session.token, queue.sessionId, batch.map((item) => item.reply),
      );
      const byKey = new Map(disclosures.map((item) => [item.key, item]));
      batch.forEach((item) => item.resolve(byKey.get(item.reply.key) ?? null));
    } catch (error) {
      // Not a member, or the server has no record: the reply has no details.
      if (agentTrustErrorStatus(error) === 404) batch.forEach((item) => item.resolve(null));
      else batch.forEach((item) => item.reject(error));
    }
  }
}

/**
 * Looks up one reply. Lookups made in the same tick for one conversation go
 * to the server together; answers are cached per run, failures are not.
 */
export function loadReplyDisclosure(
  sessionId: string,
  reply: ReplyDisclosureRequest,
  api: AgentTrustApi = defaultAgentTrustApi(),
): Promise<ReplyDisclosure | null> {
  const key = cacheKey(sessionId, reply);
  const cached = cache.get(key);
  if (cached) return cached.then((value) => (value ? { ...value, key: reply.key } : null));
  const request = new Promise<ReplyDisclosure | null>((resolve, reject) => {
    const queued = queues.get(sessionId);
    if (queued) {
      queued.pending.push({ reply, resolve, reject });
      return;
    }
    queues.set(sessionId, { api, sessionId, pending: [{ reply, resolve, reject }] });
    queueMicrotask(() => { void flush(sessionId); });
  });
  cache.set(key, request);
  request.then((value) => { if (!value) cache.delete(key); }, () => cache.delete(key));
  return request;
}

/** Forgets cached disclosures. Tests and sign-out use this. */
export function clearReplyDisclosureCache() {
  cache.clear();
  queues.clear();
}

/** The disclosure for one reply; `missing` when it cannot be looked up. */
export function useReplyDisclosure(
  request: { sessionId: string; reply: ReplyDisclosureRequest } | null,
  api: AgentTrustApi = defaultAgentTrustApi(),
): ReplyDisclosureState & { retry: () => void } {
  const [state, setState] = useState<ReplyDisclosureState>(
    request ? { status: 'loading', disclosure: null } : { status: 'missing', disclosure: null },
  );
  const [attempt, setAttempt] = useState(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  const sessionId = request?.sessionId ?? null;
  const replyKey = request?.reply.key ?? null;
  const requestId = request?.reply.requestId ?? null;
  const ownerAccountId = request?.reply.ownerAccountId ?? null;

  useEffect(() => {
    if (!sessionId || !replyKey || !requestId || !ownerAccountId) {
      setState({ status: 'missing', disclosure: null });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading', disclosure: null });
    loadReplyDisclosure(sessionId, { key: replyKey, requestId, ownerAccountId }, apiRef.current).then(
      (disclosure) => {
        if (cancelled) return;
        setState(disclosure ? { status: 'ready', disclosure } : { status: 'missing', disclosure: null });
      },
      () => { if (!cancelled) setState({ status: 'error', disclosure: null }); },
    );
    return () => { cancelled = true; };
  }, [attempt, ownerAccountId, replyKey, requestId, sessionId]);

  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
