import { cloudApiBaseUrl } from './cloudApiEnvironment';
import { cloudFetchImpl } from './cloudTransport';
import { isOmpUnavailableResponse, OMP_UNAVAILABLE_MESSAGE } from './ompAvailability';
import { publishableAccountLabel } from './routeAccountChoice';
import { loadSession } from './session';

// Hosted OMP sign-in sessions. The server runs OMP's own login flow for a
// provider and exposes each step; the desktop renders the step and relays
// user input. Credentials never pass through this client except the API key
// or pasted code the user types, which goes straight to the session input.

export type OmpLoginKind = 'api-key' | 'oauth-code' | 'device-code' | 'custom' | 'env-only';

/** Per-provider login description from the pinned OMP catalog. */
export type OmpLoginSpec = {
  kind: OmpLoginKind;
  name: string;
  instructions: string | null;
  prompt: string | null;
  placeholder: string | null;
  authUrl: string | null;
  validates: boolean;
  pasteKey: boolean;
  manualOnly: boolean;
  callbackPort: number | null;
  /** Path of OMP's loopback redirect, for example "/auth/callback"; older catalogs omit it. */
  callbackPath?: string | null;
  hook: string | null;
  apiKeyFormat: string | null;
  envVars: string[];
  storeCredentialsAs: string | null;
  /** True when the provider also takes an API key (paste key or a *_API_KEY variable). */
  acceptsApiKeyMethod?: boolean;
};

export type ProviderLoginAuthLink = { url: string; launchUrl?: string | null; instructions?: string | null };

export type ProviderLoginStep =
  | { type: 'open-url'; url: string; launchUrl?: string | null; instructions?: string | null }
  | { type: 'prompt'; message: string; placeholder?: string | null; secret?: boolean; allowEmpty?: boolean }
  | { type: 'paste-code'; instructions?: string | null }
  | { type: 'progress'; message: string }
  | { type: 'api-key'; instructions?: string | null; placeholder?: string | null; authUrl?: string | null };

export type ProviderLoginStatus = 'running' | 'awaiting-input' | 'claiming' | 'completed' | 'failed' | 'cancelled';

const terminalStatuses: ReadonlySet<ProviderLoginStatus> = new Set<ProviderLoginStatus>(['completed', 'failed', 'cancelled']);

/** Completed, failed and cancelled end a sign-in; the server's answer for them is final. */
export function isTerminalLoginStatus(status: ProviderLoginStatus) {
  return terminalStatuses.has(status);
}

export type ProviderLoginSnapshot = { snapshotId: string; provider: string; authChoice: string; label: string };

export type ProviderLoginSession = {
  sessionId: string;
  status: ProviderLoginStatus;
  step: ProviderLoginStep | null;
  auth: ProviderLoginAuthLink | null;
  /** Pass back as `after` when long-polling; null for states the server records itself (claiming, completed, cancelled). */
  version: number | null;
  error?: string | null;
  reason?: string | null;
  snapshot?: ProviderLoginSnapshot | null;
};

export type ProviderLoginStartInput = {
  provider: string;
  label: string;
  /** `device` selects a device-code hook such as openai-codex-device. */
  mode?: 'device';
  /** `api-key` asks OMP for key entry instead of the provider's default sign-in. */
  method?: 'default' | 'api-key';
};

export type ProviderLoginErrorCode =
  | 'login_not_found'
  | 'login_expired'
  | 'login_failed'
  | 'login_unsupported'
  | 'invalid_login_input'
  | 'rate_limited'
  | 'omp_unavailable'
  | 'provider_auth_not_configured'
  | 'omp_busy'
  | 'not_signed_in'
  | 'network_error'
  | 'unknown';

const knownErrorCodes = new Set<ProviderLoginErrorCode>([
  'login_not_found', 'login_expired', 'login_failed', 'login_unsupported', 'invalid_login_input',
  'rate_limited', 'omp_unavailable', 'provider_auth_not_configured', 'omp_busy', 'not_signed_in', 'network_error',
]);

/** Failures worth retrying in place: OMP restarting, or a dropped connection. */
export function isTransientLoginError(error: ProviderLoginError) {
  return error.code === 'omp_unavailable' || error.code === 'network_error';
}

function failureReason(reason?: string | null) {
  const text = reason?.trim().replace(/_/g, ' ');
  return text ? ` (${text.length > 160 ? `${text.slice(0, 157)}…` : text})` : '';
}

/** Recovery text for each server error code; distinct so the user knows what to do next. */
export function providerLoginErrorMessage(code: ProviderLoginErrorCode, reason?: string | null): string {
  switch (code) {
    case 'login_not_found': return 'This sign-in is no longer available. Start again.';
    case 'login_expired': return 'This sign-in expired before it finished. Start again.';
    case 'login_failed': return `The provider did not complete sign-in${failureReason(reason)}. Try again.`;
    case 'login_unsupported': return 'OMP cannot add this account from Kordi yet.';
    case 'invalid_login_input': return 'OMP did not accept that value. Check it and try again.';
    case 'rate_limited': return 'Too many sign-in attempts. Wait a minute and try again.';
    case 'omp_unavailable': return 'OMP is not reachable right now. Try again in a moment.';
    case 'provider_auth_not_configured': return OMP_UNAVAILABLE_MESSAGE;
    case 'omp_busy': return 'OMP is busy with other sign-ins. Try again in a moment.';
    case 'not_signed_in': return 'Sign in to Kordi before adding an account.';
    case 'network_error': return 'Kordi could not reach the server. Check your connection and try again.';
    default: return 'Sign-in could not continue. Try again.';
  }
}

export class ProviderLoginError extends Error {
  readonly code: ProviderLoginErrorCode;
  readonly status: number;
  readonly reason: string | null;
  /** The backend has no OMP sign-in (an older server, or one not configured for it); see ompAvailability.ts. */
  readonly ompUnavailable: boolean;

  constructor(code: ProviderLoginErrorCode, status = 0, reason: string | null = null) {
    super(providerLoginErrorMessage(code, reason));
    this.name = 'ProviderLoginError';
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.ompUnavailable = code === 'provider_auth_not_configured';
  }
}

export function toProviderLoginError(caught: unknown): ProviderLoginError {
  if (caught instanceof ProviderLoginError) return caught;
  return new ProviderLoginError('unknown');
}

/** Maps an HTTP error body ({ errorCode | error.code, reason }) to a typed error. */
export function providerLoginErrorFromResponse(status: number, body: unknown): ProviderLoginError {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const nested = (record.error && typeof record.error === 'object' ? record.error : {}) as Record<string, unknown>;
  const rawCode = [record.errorCode, record.code, nested.code].find((value): value is string => typeof value === 'string');
  const reason = [record.reason, nested.reason].find((value): value is string => typeof value === 'string');
  if (isOmpUnavailableResponse(status, rawCode)) return new ProviderLoginError('provider_auth_not_configured', status, reason ?? null);
  // A 503 names its cause; an unknown one is not taken to mean OMP is missing.
  const code = rawCode && knownErrorCodes.has(rawCode as ProviderLoginErrorCode)
    ? rawCode as ProviderLoginErrorCode
    : status === 401 ? 'not_signed_in'
      : status === 410 ? 'login_expired'
        : status === 429 ? 'rate_limited'
          : 'unknown';
  return new ProviderLoginError(code, status, reason ?? null);
}

export interface ProviderLoginClient {
  start(input: ProviderLoginStartInput, signal?: AbortSignal): Promise<ProviderLoginSession>;
  /** Long-polls until the session version passes `after` or the server wait ends. */
  poll(sessionId: string, after: number, signal?: AbortSignal): Promise<ProviderLoginSession>;
  submit(sessionId: string, value: string, signal?: AbortSignal): Promise<ProviderLoginSession | null>;
  /** Resolves with the session's final state when the server sends one, for example a sign-in that completed first. */
  cancel(sessionId: string): Promise<ProviderLoginSession | null>;
}

const loginPath = '/v1/cloud/agent-provider-auth/login';

function isSession(value: unknown): value is ProviderLoginSession {
  return Boolean(value && typeof value === 'object' && typeof (value as ProviderLoginSession).sessionId === 'string');
}

export function createCloudProviderLoginClient(options: {
  baseUrl?: () => string;
  fetchImpl?: typeof fetch;
  token?: () => Promise<string | null>;
  pollWaitSeconds?: number;
} = {}): ProviderLoginClient {
  const baseUrl = options.baseUrl ?? (() => cloudApiBaseUrl());
  const token = options.token ?? (async () => (await loadSession())?.token ?? null);
  const waitSeconds = options.pollWaitSeconds ?? 25;

  const request = async (path: string, init: RequestInit, timeoutMs: number): Promise<unknown> => {
    const bearer = await token();
    if (!bearer) throw new ProviderLoginError('not_signed_in', 401);
    const fetchImpl = options.fetchImpl ?? cloudFetchImpl();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const abortFromCaller = () => timeout.abort();
    init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl()}${loginPath}${path}`, {
        ...init,
        signal: timeout.signal,
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${bearer}` },
      });
    } catch (caught) {
      if (init.signal?.aborted) throw caught;
      throw new ProviderLoginError('network_error');
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abortFromCaller);
    }
    const text = response.status === 204 ? '' : await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) as unknown : null; } catch { body = null; }
    if (!response.ok) throw providerLoginErrorFromResponse(response.status, body);
    return body;
  };

  return {
    async start(input, signal) {
      const payload = { ...input, label: publishableAccountLabel(input.label) };
      const body = await request('/start', { method: 'POST', body: JSON.stringify(payload), signal }, 30_000);
      if (!isSession(body)) throw new ProviderLoginError('unknown');
      return body;
    },
    async poll(sessionId, after, signal) {
      const query = `?wait=${waitSeconds}&after=${after}`;
      const body = await request(`/${encodeURIComponent(sessionId)}${query}`, { method: 'GET', signal }, (waitSeconds + 15) * 1000);
      if (!isSession(body)) throw new ProviderLoginError('unknown');
      return body;
    },
    async submit(sessionId, value, signal) {
      const body = await request(`/${encodeURIComponent(sessionId)}/input`, { method: 'POST', body: JSON.stringify({ value }), signal }, 30_000);
      return isSession(body) ? body : null;
    },
    async cancel(sessionId) {
      const body = await request(`/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: '{}' }, 15_000);
      return isSession(body) ? body : null;
    },
  };
}

/** Finds the device code in OMP instructions such as "Enter code: ABCD-1234". */
export function parseLoginUserCode(text?: string | null): string | null {
  if (!text) return null;
  const labelled = text.match(/\bcode\b[^A-Za-z0-9]{0,4}([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)/i);
  if (labelled && /\d|-/.test(labelled[1])) return labelled[1];
  return text.match(/\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/)?.[1] ?? null;
}

/** Paste-code guidance when OMP's step carries none. */
export const pasteCodeFallback = 'Paste the code or the full redirect URL from the browser.';
/** Transcript line once the desktop receives the provider's localhost redirect. */
export const loginCallbackReceivedText = 'Sign-in received from the browser';
/** Shown under the paste field when the desktop cannot listen for the redirect. */
export const loginCallbackFallbackHint = "After you approve in the browser it will land on a localhost page that cannot load. Copy that page's full address and paste it here.";

/** Shown when another program on this Mac holds the provider's loopback port. */
export function loginCallbackPortBusyHint(port: number) {
  return `Port ${port} is in use on this Mac. Close the program using it, or paste the callback link below.`;
}

export type ProviderLoginInputView = {
  kind: 'api-key' | 'prompt' | 'paste-code';
  message: string | null;
  placeholder: string | null;
  secret: boolean;
  allowEmpty: boolean;
  authUrl: string | null;
};

/** Lines kept on the login page like OMP's dialog: answers (secrets hidden) and progress. */
export type ProviderLoginTranscriptEntry =
  | { type: 'answer'; label: string; value: string | null }
  | { type: 'progress'; text: string };

export type ProviderLoginView = {
  phase: 'idle' | 'starting' | 'waiting' | 'input' | 'submitting' | 'completed' | 'failed' | 'cancelled';
  transcript: ProviderLoginTranscriptEntry[];
  sessionId: string | null;
  version: number;
  auth: ProviderLoginAuthLink | null;
  userCode: string | null;
  statusLine: string | null;
  input: ProviderLoginInputView | null;
  error: { code: ProviderLoginErrorCode; message: string } | null;
  snapshot: ProviderLoginSnapshot | null;
  /** Desktop capture of the provider's localhost redirect for a browser sign-in. */
  callback: 'off' | 'listening' | 'unavailable' | 'port-busy' | 'received';
  /** The loopback port another program holds, while `callback` is `port-busy`. */
  callbackPort: number | null;
};

export type ProviderLoginAction =
  | { type: 'start' }
  | { type: 'session'; session: ProviderLoginSession }
  | { type: 'submit'; answer?: { label: string; value: string; secret: boolean } }
  | { type: 'error'; error: ProviderLoginError }
  | { type: 'cancelled' }
  | { type: 'callback'; state: 'listening' | 'unavailable' | 'received' }
  | { type: 'callback'; state: 'port-busy'; port: number }
  | { type: 'reset' };

export const initialProviderLoginView: ProviderLoginView = {
  phase: 'idle', transcript: [], sessionId: null, version: -1, auth: null, userCode: null,
  statusLine: null, input: null, error: null, snapshot: null, callback: 'off', callbackPort: null,
};

function withProgress(transcript: ProviderLoginTranscriptEntry[], text: string | null | undefined) {
  if (!text) return transcript;
  const last = [...transcript].reverse().find((entry) => entry.type === 'progress');
  return last?.type === 'progress' && last.text === text ? transcript : [...transcript, { type: 'progress' as const, text }];
}

function inputForStep(step: ProviderLoginStep): ProviderLoginInputView | null {
  switch (step.type) {
    case 'api-key':
      return { kind: 'api-key', message: step.instructions ?? null, placeholder: step.placeholder ?? null, secret: true, allowEmpty: false, authUrl: step.authUrl ?? null };
    case 'prompt':
      return { kind: 'prompt', message: step.message, placeholder: step.placeholder ?? null, secret: Boolean(step.secret), allowEmpty: Boolean(step.allowEmpty), authUrl: null };
    case 'paste-code':
      return { kind: 'paste-code', message: step.instructions ?? pasteCodeFallback, placeholder: null, secret: false, allowEmpty: false, authUrl: null };
    default:
      return null;
  }
}

function viewFromSession(state: ProviderLoginView, session: ProviderLoginSession): ProviderLoginView {
  const sameSession = state.sessionId === session.sessionId;
  // A saved account stays saved: nothing later for this sign-in replaces the result.
  if (sameSession && state.phase === 'completed') return state;
  // The server sends a null version for states it records itself, so versions compare only as numbers.
  const version = typeof session.version === 'number' ? session.version : null;
  if (sameSession && !isTerminalLoginStatus(session.status)) {
    if (state.phase === 'cancelled') return state;
    // An older state, or the unchanged one a long poll returns when its wait ends: nothing new,
    // so an error or a submit in progress stays on screen.
    if (version !== null && version <= state.version) return state;
  }
  const auth = session.auth ?? (session.step?.type === 'open-url'
    ? { url: session.step.url, launchUrl: session.step.launchUrl, instructions: session.step.instructions }
    : sameSession ? state.auth : null);
  const base = {
    ...state,
    sessionId: session.sessionId,
    version: version ?? (sameSession ? state.version : -1),
    auth,
    userCode: parseLoginUserCode(auth?.instructions) ?? (sameSession ? state.userCode : null),
    error: null,
  };
  if (session.status === 'completed') {
    return { ...base, phase: 'completed', input: null, statusLine: null, snapshot: session.snapshot ?? null };
  }
  if (session.status === 'failed') {
    const code = (session.error && knownErrorCodes.has(session.error as ProviderLoginErrorCode)
      ? session.error : 'login_failed') as ProviderLoginErrorCode;
    return { ...base, phase: 'failed', input: null, statusLine: null, error: { code, message: providerLoginErrorMessage(code, session.reason) } };
  }
  if (session.status === 'cancelled') return { ...base, phase: 'cancelled', input: null, statusLine: null };

  const step = session.step;
  const input = step ? inputForStep(step) : null;
  if (step?.type === 'progress') base.transcript = withProgress(base.transcript, step.message);
  if (input && session.status === 'awaiting-input') {
    return { ...base, phase: 'input', input, statusLine: null };
  }
  return {
    ...base,
    phase: 'waiting',
    input: null,
    statusLine: step?.type === 'progress' ? step.message
      : step?.type === 'open-url' ? step.instructions ?? null
        : input ? null : base.statusLine,
  };
}

// A prompt that asks for the authorization code or redirect URL rather than another detail.
const codePromptPattern = /\b(code|url|redirect)\b/i;

/** A step that takes the captured redirect: OMP's paste-code step, or a prompt for the code or URL. */
export function acceptsLoginCallback(session: Pick<ProviderLoginSession, 'status' | 'step'>) {
  const step = session.step;
  if (session.status !== 'awaiting-input' || !step) return false;
  return step.type === 'paste-code' || (step.type === 'prompt' && codePromptPattern.test(step.message));
}

/**
 * The hint when the redirect cannot be captured. A busy port is explained as
 * soon as it is known and beside a paste step; otherwise the hint goes under
 * the paste field only.
 */
export function loginCallbackHint(view: ProviderLoginView): string | null {
  const pasteStep = view.input
    ? view.input.kind === 'paste-code' || (view.input.kind === 'prompt' && codePromptPattern.test(view.input.message ?? ''))
    : null;
  if (view.callback === 'port-busy' && view.callbackPort !== null && pasteStep !== false) {
    return loginCallbackPortBusyHint(view.callbackPort);
  }
  return view.callback === 'unavailable' && pasteStep ? loginCallbackFallbackHint : null;
}

/** Maps hosted sign-in session updates to what the add-account row shows. */
export function providerLoginReducer(state: ProviderLoginView, action: ProviderLoginAction): ProviderLoginView {
  switch (action.type) {
    case 'start':
      return { ...initialProviderLoginView, phase: 'starting', statusLine: 'Starting sign-in with OMP…' };
    case 'session':
      return viewFromSession(state, action.session);
    case 'submit': {
      const statusLine = state.input?.kind === 'api-key' ? 'Verifying with OMP…' : 'Sending to OMP…';
      const answered = action.answer
        ? [...state.transcript, { type: 'answer' as const, label: action.answer.label, value: action.answer.secret ? null : action.answer.value }]
        : state.transcript;
      return {
        ...state,
        phase: 'submitting',
        error: null,
        statusLine,
        transcript: state.input?.kind === 'api-key' ? withProgress(answered, statusLine) : answered,
      };
    }
    case 'error':
      // A late failure, for example of a submit that raced the result, never hides a saved account.
      if (state.phase === 'completed') return state;
      if (action.error.code === 'invalid_login_input' && state.input) {
        return { ...state, phase: 'input', statusLine: null, error: { code: action.error.code, message: action.error.message } };
      }
      return { ...state, phase: 'failed', input: null, statusLine: null, error: { code: action.error.code, message: action.error.message } };
    case 'cancelled':
      if (state.phase === 'completed') return state;
      return { ...state, phase: 'cancelled', input: null, statusLine: null };
    case 'callback':
      // The redirect itself carries the code and never enters the view.
      if (action.state === 'received') {
        return { ...state, callback: 'received', callbackPort: null, transcript: withProgress(state.transcript, loginCallbackReceivedText) };
      }
      return { ...state, callback: action.state, callbackPort: action.state === 'port-busy' ? action.port : null };
    case 'reset':
      return initialProviderLoginView;
  }
}
