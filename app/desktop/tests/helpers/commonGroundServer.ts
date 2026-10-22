// Shared fixtures for the Grounding tests: a recording fetch with a route table and small view builders.

import { createCommonGroundClient } from '../../src/features/commonGround/client';
import type { CgOwnerView, CgPerson, CgProfile, CgRelationship, CgRoom } from '../../src/features/commonGround/types';

/** Every `design` value the server accepts: six kind designs, then ten plain colours. */
export const SERVER_DESIGNS = [
  'work', 'health', 'daily', 'workshop', 'research', 'custom',
  'ocean', 'sky', 'rose', 'coral', 'amber', 'forest', 'lavender', 'graphite', 'mint', 'olive',
] as const;

export type Call = { url: string; method: string; body: unknown; auth: string | null };
export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that records calls and answers from a route table, in order per route. */
export function mockServer(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get('authorization') });
    const key = `${method} ${url.replace('https://cloud.test/v1/cloud/common-ground/', '')}`;
    const queue = queues.get(key);
    const reply = queue && (queue.length > 1 ? queue.shift()! : queue[0]);
    if (!reply) return new Response('', { status: 404 });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  const client = createCommonGroundClient({ baseUrl: () => 'https://cloud.test', fetchImpl: () => fetchImpl, token: async () => 'tok' });
  return { calls, client };
}

export const person = (accountId: string, relationship?: CgRelationship): CgPerson => ({ accountId, name: accountId, avatarUrl: null, relationship });
export const rel = (patch: Partial<CgRelationship> = {}): CgRelationship => ({ contact: false, request: null, requestId: null, conversationId: null, ...patch });
export const card = { workingOn: ['Agent memory'], interests: [], canHelp: [], lookingFor: [], hidden: [], revision: 2, builtAt: '2026-10-20T00:00:00Z' };
export const owner = (patch: Partial<CgOwnerView> = {}): CgOwnerView => ({ card, sharing: true, build: { status: 'idle', errorCode: null }, ...patch });
export const profile = (profileId: string, kind: CgProfile['kind'], name: string, hasCard: boolean, patch: Partial<CgProfile> = {}): CgProfile => (
  { profileId, kind, name, design: null, icon: null, focus: null, position: 0, hasCard, sharing: true, builtAt: null, topicCount: hasCard ? 5 : 0, ...patch }
);
export const room = (code: string, patch: Partial<CgRoom> = {}): CgRoom => (
  { roomId: `room_${code}`, code, name: '', openedByYou: false, expiresAt: '', open: true, members: [], ...patch }
);
