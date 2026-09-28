import {
  ProviderLoginError,
  type OmpLoginSpec,
  type ProviderLoginClient,
  type ProviderLoginSession,
  type ProviderLoginSnapshot,
  type ProviderLoginStartInput,
  type ProviderLoginStep,
} from '@/features/cloud/providerLogin';
import { DEFAULT_LOGIN_CALLBACK_PATH, type LoginCallbackCapture } from '@/features/cloud/loginCallbackCapture';
import { loginAcceptsApiKey, type OmpCatalogEntry } from '@/kordi-app/auth/ompCatalog';

// Offline stand-in for the hosted OMP sign-in API. It follows the same
// session state machine with the real catalog texts, never opens a network
// connection, and completes accounts only inside this preview. Like the
// server, it sends a null version once a sign-in completes or is cancelled.

export const previewDeviceCode = 'PRVW-2468';
const deviceHooks = new Set(['openai-codex-device', 'github-copilot']);

type Flow = 'api-key' | 'oauth-code' | 'device' | 'prompt';

type PreviewSession = {
  session: ProviderLoginSession;
  /** Counts every change, including those whose state carries a null version. */
  revision: number;
  flow: Flow;
  provider: string;
  login: OmpLoginSpec;
  label: string;
  listeners: Set<() => void>;
};

function previewUrl(provider: string, device: boolean) {
  return `https://sign-in.example/${device ? 'device' : 'authorize'}/${encodeURIComponent(provider)}`;
}

function flowFor(login: OmpLoginSpec, input: ProviderLoginStartInput): Flow {
  const mode = input.mode;
  if (input.method === 'api-key' || login.kind === 'api-key' || login.kind === 'env-only') return 'api-key';
  if (mode === 'device' || login.kind === 'device-code' || deviceHooks.has(login.hook ?? '')) return 'device';
  if (login.kind === 'oauth-code') return 'oauth-code';
  return 'prompt';
}

export function createPreviewProviderLogin(loadCatalog: () => Promise<OmpCatalogEntry[]>, options: {
  onSnapshot: (snapshot: ProviderLoginSnapshot) => void;
  stepDelayMs?: number;
  /** The loopback port is taken, so the capture cannot start and the paste field stays. */
  captureBusy?: boolean;
}) {
  const delay = options.stepDelayMs ?? 700;
  const sessions = new Map<string, PreviewSession>();
  let counter = 0;
  let listening: { port: number; path: string; resolve: (url: string) => void; reject: (error: Error) => void } | null = null;

  // Stands in for the desktop listener: the simulated browser lands on the
  // provider's localhost redirect a moment after the sign-in page opens.
  const capture: LoginCallbackCapture = {
    start(port, path = DEFAULT_LOGIN_CALLBACK_PATH) {
      if (options.captureBusy) return Promise.reject(new Error('port_unavailable'));
      listening?.reject(new Error('cancelled'));
      return new Promise((resolve, reject) => { listening = { port, path, resolve, reject }; });
    },
    stop() {
      listening?.reject(new Error('cancelled'));
      listening = null;
      return Promise.resolve();
    },
  };

  const isFinal = (session: ProviderLoginSession) => session.status === 'completed' || session.status === 'cancelled';
  const update = (entry: PreviewSession, patch: Partial<ProviderLoginSession>) => {
    entry.revision += 1;
    const next = { ...entry.session, ...patch };
    entry.session = { ...next, version: isFinal(next) ? null : entry.revision };
    for (const listener of [...entry.listeners]) listener();
  };
  const later = (entry: PreviewSession, run: () => void) => {
    window.setTimeout(() => {
      if (entry.session.status === 'cancelled' || entry.session.status === 'completed') return;
      run();
    }, delay);
  };
  const complete = (entry: PreviewSession) => {
    counter += 1;
    const snapshot: ProviderLoginSnapshot = {
      snapshotId: `snap_preview_${counter}`,
      provider: entry.login.storeCredentialsAs ?? entry.provider,
      authChoice: `omp-${entry.flow === 'api-key' ? 'api-key' : 'oauth'}:preview-${counter}`,
      label: entry.label,
    };
    options.onSnapshot(snapshot);
    update(entry, { status: 'completed', step: null, snapshot });
  };

  const client: ProviderLoginClient = {
    async start(input) {
      const login = (await loadCatalog()).find((entry) => entry.id === input.provider)?.login;
      if (!login) return Promise.reject(new ProviderLoginError('login_unsupported', 422));
      if (!input.label.trim()) return Promise.reject(new ProviderLoginError('invalid_login_input', 400));
      counter += 1;
      const sessionId = `preview-login-${counter}`;
      if (input.method === 'api-key' && !loginAcceptsApiKey(login)) {
        return Promise.reject(new ProviderLoginError('login_unsupported', 422));
      }
      const flow = flowFor(login, input);
      let step: ProviderLoginStep;
      let auth: ProviderLoginSession['auth'] = null;
      if (flow === 'api-key') {
        step = { type: 'api-key', instructions: login.instructions, placeholder: login.placeholder, authUrl: login.authUrl };
      } else if (flow === 'device') {
        const instructions = (login.instructions ?? 'Enter code: {user_code}').replace('{user_code}', previewDeviceCode);
        auth = { url: previewUrl(input.provider, true), instructions };
        step = { type: 'open-url', ...auth };
      } else if (flow === 'oauth-code') {
        auth = { url: previewUrl(input.provider, false), instructions: login.instructions };
        step = { type: 'open-url', ...auth };
      } else {
        step = { type: 'prompt', message: login.prompt ?? 'Paste your access token', placeholder: login.placeholder ?? 'tok_…', secret: true };
      }
      const entry: PreviewSession = {
        flow, provider: input.provider, login, label: input.label.trim(), listeners: new Set(), revision: 1,
        session: { sessionId, status: flow === 'api-key' || flow === 'prompt' ? 'awaiting-input' : 'running', step, auth, version: 1 },
      };
      sessions.set(sessionId, entry);
      if (flow === 'oauth-code') {
        later(entry, () => update(entry, { status: 'awaiting-input', step: { type: 'paste-code' } }));
      }
      return Promise.resolve(entry.session);
    },
    poll(sessionId, after, signal) {
      const entry = sessions.get(sessionId);
      if (!entry) return Promise.reject(new ProviderLoginError('login_not_found', 404));
      if (entry.revision > after || isFinal(entry.session)) return Promise.resolve(entry.session);
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(done, 25_000);
        function done() {
          window.clearTimeout(timer);
          entry!.listeners.delete(done);
          signal?.removeEventListener('abort', aborted);
          resolve(entry!.session);
        }
        function aborted() {
          window.clearTimeout(timer);
          entry!.listeners.delete(done);
          reject(new DOMException('Aborted', 'AbortError'));
        }
        entry.listeners.add(done);
        signal?.addEventListener('abort', aborted, { once: true });
      });
    },
    submit(sessionId, value) {
      const entry = sessions.get(sessionId);
      if (!entry) return Promise.reject(new ProviderLoginError('login_not_found', 404));
      const step = entry.session.step;
      const allowEmpty = step?.type === 'prompt' && step.allowEmpty;
      if ((!value.trim() && !allowEmpty) || value.trim().toLowerCase().startsWith('invalid')) {
        return Promise.reject(new ProviderLoginError('invalid_login_input', 400));
      }
      update(entry, {
        status: 'running',
        step: { type: 'progress', message: entry.flow === 'api-key' ? 'Verifying with OMP…' : 'Finishing sign-in…' },
      });
      later(entry, () => complete(entry));
      return Promise.resolve(entry.session);
    },
    cancel(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return Promise.resolve(null);
      if (!isFinal(entry.session)) update(entry, { status: 'cancelled', step: null });
      return Promise.resolve(entry.session);
    },
  };

  /** The sign-in page "opens": a device code confirms, and a browser sign-in redirects to localhost. */
  const openedUrl = (url: string) => {
    for (const entry of sessions.values()) {
      if (entry.session.auth?.url !== url || entry.session.status === 'completed' || entry.session.status === 'cancelled') continue;
      if (entry.flow === 'device') {
        later(entry, () => {
          update(entry, { step: { type: 'progress', message: 'Confirming sign-in…' } });
          later(entry, () => complete(entry));
        });
      } else if (entry.flow === 'oauth-code') {
        later(entry, () => {
          const pending = listening;
          listening = null;
          pending?.resolve(`http://localhost:${pending.port}${pending.path}?code=preview-code&state=preview-state`);
        });
      }
    }
  };

  return { client, openedUrl, capture };
}
