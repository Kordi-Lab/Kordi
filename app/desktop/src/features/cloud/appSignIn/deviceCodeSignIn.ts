// One device code sign-in (RFC 8628), the fallback when the system browser
// cannot be opened on this Mac. The app shows a short code; the person
// enters it on the approval page from another device, and the app polls
// until the server returns the same token response as browser sign-in.

import { CloudAuthError } from '../cloudAuthError';
import { installationDeviceRegistration } from '../deviceIdentity';
import {
  pollDeviceCode,
  requestDeviceCode,
  revokeAppSignIn,
  type AppSignInResult,
  type DeviceCodePrompt,
} from './appSignInClient';
import { BrowserSignInCancelledError, type BrowserSignInConfig } from './browserSignIn';

const SLOW_DOWN_STEP_MS = 5_000;
const MAX_INTERVAL_MS = 60_000;

export type DeviceCodeSignInConfig = BrowserSignInConfig & {
  /** Waits between polls; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DeviceCodeAttempt {
  private cancelled = false;

  private constructor(
    private readonly config: DeviceCodeSignInConfig,
    readonly prompt: DeviceCodePrompt,
  ) {}

  /** Requests a code. Throws `device_code_unavailable` when the server has no device codes. */
  static async start(config: DeviceCodeSignInConfig): Promise<DeviceCodeAttempt> {
    const device = await (config.deviceRegistration ?? installationDeviceRegistration)().catch(() => null);
    const prompt = await requestDeviceCode({
      baseUrl: config.baseUrl,
      fetchImpl: config.fetchImpl,
      clientId: config.clientId,
      device,
      now: config.now,
    });
    return new DeviceCodeAttempt(config, prompt);
  }

  /** Polls until approval, denial, expiry, or cancel. */
  async wait(): Promise<AppSignInResult> {
    const sleep = this.config.sleep ?? defaultSleep;
    const now = this.config.now ?? Date.now;
    let interval = this.prompt.intervalMs;
    for (;;) {
      if (now() >= this.prompt.expiresAt) {
        throw new CloudAuthError('device_code_expired', 'The code expired. Try again.', 0);
      }
      await sleep(interval);
      if (this.cancelled) throw new BrowserSignInCancelledError();
      let poll;
      try {
        poll = await pollDeviceCode({
          baseUrl: this.config.baseUrl,
          fetchImpl: this.config.fetchImpl,
          clientId: this.config.clientId,
          deviceCode: this.prompt.deviceCode,
          now,
        });
      } catch (caught) {
        // Connection drops, rate limits and server errors are retried more
        // slowly until the code expires.
        if (
          caught instanceof CloudAuthError
          && (caught.code === 'network_error' || caught.code === 'rate_limited' || caught.code === 'server_error')
        ) {
          interval = Math.min(interval + SLOW_DOWN_STEP_MS, MAX_INTERVAL_MS);
          continue;
        }
        throw caught;
      }
      if (poll.kind === 'slow_down') {
        interval = Math.min(Math.max(poll.intervalMs, interval + SLOW_DOWN_STEP_MS), MAX_INTERVAL_MS);
        continue;
      }
      if (poll.kind === 'pending') continue;
      if (this.cancelled) {
        void this.revoke(poll.result);
        throw new BrowserSignInCancelledError();
      }
      return poll.result;
    }
  }

  cancel(): void {
    this.cancelled = true;
  }

  private revoke(result: AppSignInResult): Promise<unknown> {
    const session = {
      token: result.session.token,
      accountId: result.account.accountId,
      expiresAt: result.session.expiresAt,
      ...result.refresh,
    };
    return revokeAppSignIn(session, this.config.fetchImpl).catch(() => undefined);
  }
}
