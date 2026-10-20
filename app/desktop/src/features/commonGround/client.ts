// Typed calls for `/v1/cloud/common-ground`. Errors keep the server's own
// `errorCode`, the HTTP status, a 429 `Retry-After`, and the body (a 409 can
// carry the current relationship).

import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { cloudFetchImpl } from '@/features/cloud/cloudTransport';
import { loadSession } from '@/features/cloud/session';
import type {
  CgBuildRequest, CgCreatedGroup, CgGroup, CgMatch, CgMeetInput, CgOwnerView, CgPairCode, CgPerson,
  CgPersonCard, CgRecentEntry, CgRelationship, CgResults, CgRoom, CgTopicLists,
} from './types';

const REQUEST_TIMEOUT_MS = 15_000;

export class CommonGroundError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly body: unknown;

  constructor(message: string, status: number, code: string | null, retryAfterSeconds: number | null = null, body: unknown = null) {
    super(message);
    this.name = 'CommonGroundError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.body = body;
  }

  /** A 404 without a Common ground error code: the server does not have this route yet. */
  get routeMissing(): boolean {
    return this.status === 404 && !this.code;
  }
}

export function commonGroundErrorCode(error: unknown): string | null {
  return error instanceof CommonGroundError ? error.code : null;
}

export function isRouteMissing(error: unknown): boolean {
  return error instanceof CommonGroundError && error.routeMissing;
}

/** One line for a failed request; rate limits name the wait in minutes. */
export function commonGroundErrorMessage(error: unknown): string {
  if (error instanceof CommonGroundError && error.status === 429) {
    const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60));
    return `Try again in ${minutes} min.`;
  }
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.';
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

export type CommonGroundClientOptions = {
  baseUrl?: () => string;
  fetchImpl?: () => typeof fetch;
  token?: () => Promise<string>;
  timeoutMs?: number;
};

export type CgResponse<T> = { status: number; body: T };

async function sessionToken(): Promise<string> {
  const session = await loadSession();
  if (!session?.token) throw new CommonGroundError('Sign in again to use Common ground.', 401, null);
  return session.token;
}

const enc = encodeURIComponent;

export function createCommonGroundClient(options: CommonGroundClientOptions = {}) {
  const baseUrl = options.baseUrl ?? (() => cloudApiBaseUrl());
  const fetchImpl = options.fetchImpl ?? (() => cloudFetchImpl());
  const token = options.token ?? sessionToken;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function send<T>(method: string, path: string, body?: unknown): Promise<CgResponse<T>> {
    const bearer = await token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl()(`${baseUrl()}/v1/cloud/${path}`, {
        method,
        signal: controller.signal,
        headers: body === undefined
          ? { Authorization: `Bearer ${bearer}` }
          : { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CommonGroundError(controller.signal.aborted ? 'The request timed out. Try again.' : 'Could not reach Kordi Cloud.', 0, null);
    } finally {
      clearTimeout(timer);
    }
    const text = response.status === 204 ? '' : await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      const record = (parsed && typeof parsed === 'object' ? parsed : {}) as { errorCode?: unknown; message?: unknown };
      const code = typeof record.errorCode === 'string' && record.errorCode ? record.errorCode : null;
      const message = typeof record.message === 'string' && record.message ? record.message : 'Something went wrong. Try again.';
      throw new CommonGroundError(message, response.status, code, parseRetryAfter(response.headers.get('retry-after')), parsed);
    }
    return { status: response.status, body: parsed as T };
  }
  const data = async <T>(method: string, path: string, body?: unknown) => (await send<T>(method, path, body)).body;
  const cg = (path: string) => `common-ground/${path}`;

  return {
    card: () => data<CgOwnerView>('GET', cg('card')),
    saveTopics: (topics: CgTopicLists) => data<CgOwnerView>('PUT', cg('card'), {
      workingOn: topics.workingOn, interests: topics.interests, canHelp: topics.canHelp, lookingFor: topics.lookingFor,
    }),
    deleteCard: () => data<CgOwnerView>('DELETE', cg('card')),
    build: (request: CgBuildRequest) => data<CgOwnerView>('POST', cg('card/build'), request),
    setHidden: (hidden: string[]) => data<CgOwnerView>('PUT', cg('card/hidden'), { hidden }),
    setSharing: (sharing: boolean) => data<CgOwnerView>('PUT', cg('settings'), { sharing }),
    room: (code: string) => data<CgRoom>('GET', cg(`rooms/${enc(code)}`)),
    joinRoom: (code: string, name?: string) => data<CgRoom>('POST', cg(`rooms/${enc(code)}/join`), name ? { name } : {}),
    leaveRoom: (code: string) => data<null>('POST', cg(`rooms/${enc(code)}/leave`)),
    results: (code: string) => data<CgResults>('POST', cg(`rooms/${enc(code)}/results`)),
    createGroup: (code: string, name: string, memberIds: string[]) => data<CgCreatedGroup>('POST', cg(`rooms/${enc(code)}/group`), { name, memberIds }),
    joinInvitation: (code: string, ref: string) => data<{ status: string } & Omit<CgGroup, 'memberCount'>>(
      'POST', cg(`rooms/${enc(code)}/invitations/${enc(ref)}/join`),
    ),
    person: (accountId: string) => data<CgPersonCard>('GET', cg(`people/${enc(accountId)}`)),
    /** 200 with the match, or 202 while it is being found. */
    match: async (accountId: string): Promise<CgMatch> => {
      const { status, body } = await send<CgMatch>('GET', cg(`people/${enc(accountId)}/match`));
      return status === 202 ? { status: body.status === 'failed' ? 'failed' : 'matching', person: body.person } : { ...body, status: 'ready' };
    },
    addContact: (accountId: string, message?: string) => data<{ relationship: CgRelationship }>(
      'POST', cg(`people/${enc(accountId)}/contact`), message ? { message } : {},
    ),
    chat: (accountId: string) => data<{ conversationId: string; sessionId: string; relationship: CgRelationship }>('POST', cg(`people/${enc(accountId)}/chat`)),
    meet: (accountId: string, input: CgMeetInput) => data<{ conversationId: string; planCardId: string; relationship: CgRelationship }>(
      'POST', cg(`people/${enc(accountId)}/meet`), input,
    ),
    recent: () => data<{ people: CgRecentEntry[] }>('GET', cg('recent')),
    pairings: () => data<{ people: CgPerson[] }>('GET', cg('pairings')),
    newPairCode: () => data<CgPairCode>('POST', cg('pairings/code')),
    redeem: (code: string) => data<CgPersonCard>('POST', cg('pairings/redeem'), { code }),
  };
}

export type CommonGroundClient = ReturnType<typeof createCommonGroundClient>;
