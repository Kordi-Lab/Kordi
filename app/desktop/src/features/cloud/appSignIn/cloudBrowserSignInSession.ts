import { useEffect, useMemo } from 'react';

import { cloudApiBaseUrl } from '../cloudApiEnvironment';
import { cloudFetchImpl } from '../cloudTransport';
import { loadSession } from '../session';
import { appSignInClientId, type AppSignInResult } from './appSignInClient';
import { nativeBrowserSignInDriver } from './browserSignIn';
import type { DeviceCodeSignInConfig } from './deviceCodeSignIn';

export type CloudBrowserSignInSession = {
  config: DeviceCodeSignInConfig;
  complete: (result: AppSignInResult) => Promise<void>;
};

/** Browser sign-in for the live session, or undefined where it cannot run (browser previews, tests). */
export function useCloudBrowserSignInSession(
  enabled: boolean,
  complete: (result: AppSignInResult) => Promise<void>,
): CloudBrowserSignInSession | undefined {
  return useMemo(() => {
    if (!enabled) return undefined;
    const driver = nativeBrowserSignInDriver();
    if (!driver) return undefined;
    let baseUrl: string;
    try {
      baseUrl = cloudApiBaseUrl();
    } catch {
      return undefined;
    }
    return {
      config: { baseUrl, clientId: appSignInClientId(), fetchImpl: cloudFetchImpl(), driver },
      complete,
    };
  }, [complete, enabled]);
}

const KEEP_ALIVE_INTERVAL_MS = 60_000;

/**
 * Browser sign-in access tokens expire after an hour. Loading the session
 * refreshes it shortly before expiry, so check on a timer and whenever the
 * app wakes, focuses or comes back online.
 */
export function useCloudSessionKeepAlive(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const check = () => { void loadSession().catch(() => undefined); };
    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    const timer = window.setInterval(check, KEEP_ALIVE_INTERVAL_MS);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}
