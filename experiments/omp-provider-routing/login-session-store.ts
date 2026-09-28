/**
 * In-memory store of hosted login sessions: session records and their state
 * transitions, idle expiry, the concurrency cap, and claim-once hand-over of the
 * resulting credential. Nothing in this module logs.
 */
import type { OAuthCredentials } from '@oh-my-pi/pi-ai';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { createStepController, runApiKeyFlow } from './login-step-bridge';
import {
  classifyLoginError,
  HostedLoginError,
  isUsableResult,
  loginMaterial,
  LoginRouteError,
  type LoginClaim,
  type LoginErrorCode,
  type LoginRegistry,
  type LoginSessionManagerOptions,
  type LoginSnapshot,
  type LoginStatus,
  type LoginStep,
  type OpenUrlStep,
} from './login-session-types';
import type { ProviderEndpoint } from './provider-endpoint';

export const LOGIN_IDLE_TIMEOUT_MS = 15 * 60_000;
export const MAX_LOGIN_SESSIONS = 20;
export const MAX_LOGIN_INPUT_LENGTH = 16_384;
const MAX_WAIT_SECONDS = 30;
const FIRST_STEP_WAIT_MS = 5_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

type PendingInput = {
  allowEmpty: boolean;
  resolve(value: string): void;
  reject(error: Error): void;
};

type FinalStatus = 'completed' | 'failed' | 'cancelled';

function isTerminal(status: LoginStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** One login session: its latest step, pending input, and (until claimed) its credential. */
export class LoginSessionRecord {
  readonly abort = new AbortController();
  readonly waiters = new Set<() => void>();
  status: LoginStatus = 'running';
  step: LoginStep | null = null;
  auth: OpenUrlStep | null = null;
  error: LoginErrorCode | null = null;
  version = 1;
  lastActivity: number;
  pending?: PendingInput;
  pasteRequests = 0;
  result?: OAuthCredentials | string;
  endpoint?: ProviderEndpoint;
  /** Cleared when the store forgets the session, so late flow results are dropped. */
  live = true;
  readonly #now: () => number;

  constructor(
    readonly id: string,
    readonly provider: string,
    readonly claimProvider: string,
    readonly pasteKey: boolean,
    now: () => number,
  ) {
    this.#now = now;
    this.lastActivity = now();
  }

  get terminal(): boolean {
    return isTerminal(this.status);
  }

  snapshot(): LoginSnapshot {
    return {
      sessionId: this.id,
      status: this.status,
      step: this.step,
      auth: this.auth,
      error: this.error,
      version: this.version,
    };
  }

  touch(): void {
    this.lastActivity = this.#now();
  }

  /** Records a state change and wakes long-polls. */
  bump(): void {
    this.version += 1;
    this.lastActivity = this.#now();
    for (const wake of [...this.waiters]) wake();
  }

  waitForChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  setStep(step: LoginStep): boolean {
    if (this.terminal) return false;
    this.step = step;
    if (step.type === 'open-url') this.auth = step;
    this.bump();
    return true;
  }

  /** Enters a final status, aborts the flow, and rejects any pending input. */
  finish(status: FinalStatus, error: LoginErrorCode | null): void {
    this.status = status;
    this.error = error;
    const pending = this.pending;
    this.pending = undefined;
    if (!this.abort.signal.aborted) this.abort.abort(status);
    pending?.reject(new AIError.LoginCancelledError());
    this.bump();
  }

  complete(result: OAuthCredentials | string, endpoint: ProviderEndpoint): void {
    if (this.terminal || !this.live) return;
    this.result = result;
    this.endpoint = endpoint;
    this.finish('completed', null);
  }

  /** Drops the unclaimed credential. */
  discard(): void {
    this.result = undefined;
    this.endpoint = undefined;
  }

  fail(error: unknown): void {
    if (this.terminal || !this.live) return;
    this.finish('failed', classifyLoginError(error));
  }

  /** Publishes an input step and resolves with the caller's value; rejects on abort. */
  awaitInput(step: LoginStep, allowEmpty: boolean, signal?: AbortSignal): Promise<string> {
    if (this.terminal || this.abort.signal.aborted || signal?.aborted) {
      return Promise.reject(new AIError.LoginCancelledError());
    }
    this.pending?.reject(new AIError.LoginCancelledError('Superseded by a newer input request'));
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        this.abort.signal.removeEventListener('abort', onAbort);
      };
      const pending: PendingInput = {
        allowEmpty,
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      };
      const onAbort = () => {
        if (this.pending === pending) {
          this.pending = undefined;
          if (this.status === 'awaiting-input') {
            this.status = 'running';
            this.bump();
          }
        }
        pending.reject(new AIError.LoginCancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      this.pending = pending;
      this.status = 'awaiting-input';
      this.setStep(step);
    });
  }
}

export class LoginSessionManager {
  readonly #registry: LoginRegistry;
  readonly #now: () => number;
  readonly #idleTimeoutMs: number;
  readonly #maxSessions: number;
  readonly #firstStepWaitMs: number;
  readonly #sessions = new Map<string, LoginSessionRecord>();

  constructor(options: LoginSessionManagerOptions) {
    this.#registry = options.registry;
    this.#now = options.now ?? Date.now;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? LOGIN_IDLE_TIMEOUT_MS;
    this.#maxSessions = options.maxSessions ?? MAX_LOGIN_SESSIONS;
    this.#firstStepWaitMs = options.firstStepWaitMs ?? FIRST_STEP_WAIT_MS;
  }

  get size(): number {
    return this.#sessions.size;
  }

  /**
   * Starts a login. `method` is `"default"` (the provider's own OMP login) or
   * `"api-key"` (the internal api-key flow, for providers that accept a key).
   */
  async start(input: { provider?: unknown; sessionId?: unknown; method?: unknown }): Promise<LoginSnapshot> {
    this.sweep();
    const { provider, sessionId, method = 'default' } = input;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)
      || typeof provider !== 'string' || !PROVIDER_ID_PATTERN.test(provider)
      || (method !== 'default' && method !== 'api-key')) {
      throw new LoginRouteError(400, 'invalid_request');
    }
    const id = sessionId.toLowerCase();
    if (this.#sessions.has(id)) throw new LoginRouteError(409, 'session_exists');
    const policy = this.#registry.policy(provider);
    if (!policy) throw new LoginRouteError(422, 'unknown_provider');
    // One rule decides whether a key is accepted: login-policy.ts `acceptsHostedApiKey`.
    const pastesKey = method === 'api-key' || policy.kind === 'api-key' || policy.kind === 'env-only';
    if (pastesKey && !policy.acceptsApiKeyMethod) throw new LoginRouteError(422, 'unsupported_flow');
    if (this.#sessions.size >= this.#maxSessions) this.#evictFinishedSession();
    if (this.#sessions.size >= this.#maxSessions) throw new LoginRouteError(429, 'too_many_sessions');

    const session = new LoginSessionRecord(id, provider, policy.storeCredentialsAs ?? provider, policy.pasteKey, this.#now);
    this.#sessions.set(id, session);

    const run = pastesKey
      ? () => runApiKeyFlow(session, policy, this.#registry)
      : () => this.#registry.login(provider, createStepController(session));
    void (async () => {
      const result = await run();
      if (!isUsableResult(result)) throw new HostedLoginError('provider_rejected');
      return { result, endpoint: await this.#registry.endpoint(session.claimProvider, result) };
    })().then(
      ({ result, endpoint }) => session.complete(result, endpoint),
      (error) => session.fail(error),
    );

    if (session.step === null && session.status === 'running') {
      await session.waitForChange(this.#firstStepWaitMs);
    }
    return session.snapshot();
  }

  /** Returns the session state, long-polling up to `waitSeconds` (max 30) for a change. */
  async poll(sessionId: string, waitSeconds: number, after?: number, signal?: AbortSignal): Promise<LoginSnapshot> {
    const session = this.#get(sessionId);
    session.touch();
    const seconds = Number.isFinite(waitSeconds) ? Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) : 0;
    const stale = after !== undefined && after !== session.version;
    if (seconds > 0 && !stale && !session.terminal) {
      await session.waitForChange(seconds * 1_000, signal);
    }
    return session.snapshot();
  }

  /** Resolves the pending prompt, paste-code, or api-key step. */
  input(sessionId: string, value: unknown): LoginSnapshot {
    const session = this.#get(sessionId);
    session.touch();
    if (typeof value !== 'string') throw new LoginRouteError(400, 'invalid_input');
    if (value.length > MAX_LOGIN_INPUT_LENGTH) throw new LoginRouteError(413, 'invalid_input');
    const pending = session.pending;
    if (!pending || session.status !== 'awaiting-input') throw new LoginRouteError(409, 'no_pending_input');
    if (!pending.allowEmpty && value.trim() === '') throw new LoginRouteError(400, 'invalid_input');
    session.pending = undefined;
    session.status = 'running';
    session.bump();
    pending.resolve(value);
    return session.snapshot();
  }

  /** Aborts a running login, or discards an unclaimed credential. */
  cancel(sessionId: string): LoginSnapshot {
    const session = this.#get(sessionId);
    session.touch();
    if (session.status !== 'failed' && session.status !== 'cancelled') {
      session.discard();
      session.finish('cancelled', null);
    }
    return session.snapshot();
  }

  /** Hands over the credential of a completed login exactly once, then forgets the session. */
  claim(sessionId: string): LoginClaim {
    const session = this.#get(sessionId);
    if (session.status !== 'completed' || session.result === undefined) {
      session.touch();
      throw new LoginRouteError(409, 'not_completed');
    }
    const material = loginMaterial(session.result, session.claimProvider, session.endpoint);
    const claim = { provider: session.claimProvider, material };
    session.discard();
    this.#forget(session);
    return claim;
  }

  /** Expires sessions idle for longer than the idle timeout, aborting their logins. */
  sweep(): void {
    const now = this.#now();
    for (const session of [...this.#sessions.values()]) {
      if (now - session.lastActivity < this.#idleTimeoutMs) continue;
      this.#forget(session);
      session.discard();
      if (!session.terminal) session.finish('failed', 'timeout');
    }
  }

  /** Aborts every session; used on shutdown. */
  close(): void {
    for (const session of [...this.#sessions.values()]) {
      this.#forget(session);
      session.discard();
      if (!session.terminal) session.finish('cancelled', null);
    }
  }

  #forget(session: LoginSessionRecord): void {
    session.live = false;
    this.#sessions.delete(session.id);
  }

  /** Frees one slot held by a failed or cancelled session, least recently active first. */
  #evictFinishedSession(): void {
    let oldest: LoginSessionRecord | undefined;
    for (const session of this.#sessions.values()) {
      if (session.status !== 'failed' && session.status !== 'cancelled') continue;
      if (!oldest || session.lastActivity < oldest.lastActivity) oldest = session;
    }
    if (oldest) this.#forget(oldest);
  }

  #get(sessionId: string): LoginSessionRecord {
    this.sweep();
    const session = this.#sessions.get(sessionId.toLowerCase());
    if (!session) throw new LoginRouteError(404, 'not_found');
    return session;
  }
}
