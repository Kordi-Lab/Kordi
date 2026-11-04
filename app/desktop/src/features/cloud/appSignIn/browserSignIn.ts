// One browser sign-in attempt: PKCE + state, a loopback listener for the
// redirect, the authorize URL, and the code exchange. The same attempt
// accepts the loopback code or a code the user pastes from the browser, and
// exchanges at most one of them.

import { invokeDesktop, isNativeDesktopShell, openDesktopExternalUrl } from '@/lib/desktop';

import { CloudAuthError } from '../cloudAuthError';
import { installationDeviceRegistration, type CloudDeviceRegistration } from '../deviceIdentity';
import {
  buildAppAuthorizeUrl,
  exchangeAppAuthorizationCode,
  parseAppSignInCallback,
  type AppSignInResult,
  type BrowserSignInIntent,
} from './appSignInClient';
import { createPkcePair, createSignInState } from './pkce';

/** The loopback wait is capped at ten minutes by the native listener command. */
const CALLBACK_WAIT_MS = 600_000;

export type BrowserSignInDriver = {
  prepare(expectedState: string): Promise<{ requestId: string; redirectUrl: string }>;
  wait(requestId: string, timeoutMs: number): Promise<string>;
  cancel(requestId: string): Promise<void>;
  openUrl(url: string): Promise<unknown>;
  copyText(text: string): Promise<void>;
  focusApp?(): Promise<void>;
};

export type BrowserSignInConfig = {
  baseUrl: string;
  clientId: string;
  fetchImpl: typeof fetch;
  driver: BrowserSignInDriver;
  deviceRegistration?: () => Promise<CloudDeviceRegistration>;
};

export class BrowserSignInCancelledError extends Error {
  constructor() {
    super('Browser sign-in was canceled.');
    this.name = 'BrowserSignInCancelledError';
  }
}

export function isBrowserSignInCancelled(error: unknown): boolean {
  return error instanceof BrowserSignInCancelledError;
}

/** The native shell's loopback listener, system browser and clipboard. */
export function nativeBrowserSignInDriver(): BrowserSignInDriver | null {
  if (!isNativeDesktopShell()) return null;
  return {
    prepare: (expectedState) => invokeDesktop('cloud_app_sign_in_loopback_prepare', { expectedState }),
    wait: (requestId, timeoutMs) => invokeDesktop<string>('cloud_oauth_loopback_wait', { requestId, timeoutMs }),
    cancel: (requestId) => invokeDesktop<void>('cloud_oauth_loopback_cancel', { requestId }),
    openUrl: (url) => openDesktopExternalUrl(url),
    copyText: (text) => navigator.clipboard.writeText(text),
    focusApp: async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFocus();
    },
  };
}

export class BrowserSignInAttempt {
  private cancelled = false;
  private exchange: Promise<AppSignInResult> | null = null;

  private constructor(
    private readonly config: BrowserSignInConfig,
    readonly intent: BrowserSignInIntent,
    readonly authorizeUrl: string,
    private readonly redirectUri: string,
    private readonly verifier: string,
    private readonly state: string,
    private readonly requestId: string,
  ) {}

  static async start(config: BrowserSignInConfig, intent: BrowserSignInIntent): Promise<BrowserSignInAttempt> {
    const state = createSignInState();
    const pkce = await createPkcePair();
    const loopback = await config.driver.prepare(state);
    const authorizeUrl = buildAppAuthorizeUrl({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      redirectUri: loopback.redirectUrl,
      codeChallenge: pkce.challenge,
      state,
      intent,
    });
    return new BrowserSignInAttempt(
      config, intent, authorizeUrl, loopback.redirectUrl, pkce.verifier, state, loopback.requestId,
    );
  }

  openBrowser(): Promise<unknown> {
    return this.config.driver.openUrl(this.authorizeUrl);
  }

  copyLink(): Promise<void> {
    return this.config.driver.copyText(this.authorizeUrl);
  }

  /** Resolves when the browser returns to the loopback redirect. */
  async waitForBrowser(): Promise<AppSignInResult> {
    let query: string;
    try {
      query = await this.config.driver.wait(this.requestId, CALLBACK_WAIT_MS);
    } catch (caught) {
      if (this.cancelled) throw new BrowserSignInCancelledError();
      // A pasted code finished the sign-in and stopped the listener.
      if (this.exchange) return this.exchange;
      const message = caught instanceof Error ? caught.message : String(caught);
      if (/timed out/i.test(message)) {
        throw new CloudAuthError('browser_sign_in_timed_out', 'Sign-in timed out. Try again.', 0);
      }
      throw new CloudAuthError('browser_sign_in_failed', 'Could not finish signing in. Try again.', 0);
    }
    if (this.cancelled) throw new BrowserSignInCancelledError();
    const result = await this.exchangeCode(parseAppSignInCallback(query, this.state));
    void this.config.driver.focusApp?.().catch(() => undefined);
    return result;
  }

  /**
   * Exchanges a code from the redirect or pasted by the user. A second call
   * while one exchange runs shares it, so one attempt starts one sign-in.
   */
  exchangeCode(code: string): Promise<AppSignInResult> {
    if (this.cancelled) return Promise.reject(new BrowserSignInCancelledError());
    const trimmed = code.trim();
    if (!trimmed) {
      return Promise.reject(new CloudAuthError('sign_in_code_invalid', 'Paste the code from your browser.', 0));
    }
    if (this.exchange) return this.exchange;
    const exchange = (async () => {
      const device = await (this.config.deviceRegistration ?? installationDeviceRegistration)().catch(() => null);
      const result = await exchangeAppAuthorizationCode({
        baseUrl: this.config.baseUrl,
        fetchImpl: this.config.fetchImpl,
        clientId: this.config.clientId,
        code: trimmed,
        redirectUri: this.redirectUri,
        codeVerifier: this.verifier,
        device,
      });
      if (this.cancelled) throw new BrowserSignInCancelledError();
      this.stopListening();
      return result;
    })();
    this.exchange = exchange;
    // A failed code (expired, already used) leaves the attempt open for another.
    exchange.catch(() => {
      if (this.exchange === exchange) this.exchange = null;
    });
    return exchange;
  }

  cancel(): void {
    this.cancelled = true;
    this.stopListening();
  }

  private stopListening(): void {
    void this.config.driver.cancel(this.requestId).catch(() => undefined);
  }
}
