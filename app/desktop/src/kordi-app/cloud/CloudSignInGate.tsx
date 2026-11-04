import { useCallback, useEffect, useRef, useState } from 'react';

import {
  appSignInHost,
  probeBrowserSignIn,
  type BrowserSignInAvailability,
  type BrowserSignInIntent,
} from '@/features/cloud/appSignIn/appSignInClient';
import type { CloudBrowserSignInSession } from '@/features/cloud/appSignIn/cloudBrowserSignInSession';
import { useBrowserSignIn, type BrowserSignInState } from '@/features/cloud/appSignIn/useBrowserSignIn';
import { applyCloudLoginWindowSize } from '@/features/cloud/loginWindow';

import { CloudBrowserSignInPage } from './CloudBrowserSignInPage';
import { CloudLoginPage, type CloudLoginPageProps } from './CloudLoginPage';

// Signed out: browser sign-in when the server offers it, otherwise the
// in-app form, so older servers keep working.

const knownAvailability = new Map<string, Exclude<BrowserSignInAvailability, 'unknown'>>();

function availabilityKey(session: CloudBrowserSignInSession): string {
  return `${session.config.baseUrl} ${session.config.clientId}`;
}

function useBrowserSignInAvailability(session: CloudBrowserSignInSession) {
  const key = availabilityKey(session);
  const [availability, setAvailability] = useState<BrowserSignInAvailability | 'checking'>(
    () => knownAvailability.get(key) ?? 'checking',
  );
  const probeRef = useRef<Promise<BrowserSignInAvailability> | null>(null);
  const probe = useCallback(() => {
    const known = knownAvailability.get(key);
    if (known) return Promise.resolve(known);
    probeRef.current ??= probeBrowserSignIn(session.config).then((result) => {
      probeRef.current = null;
      if (result !== 'unknown') knownAvailability.set(key, result);
      setAvailability(result);
      return result;
    });
    return probeRef.current;
  }, [key, session.config]);
  useEffect(() => { void probe(); }, [probe]);
  return { availability, probe };
}

type BrowserSignInChange = (active: boolean) => void;

function BrowserSignIn({
  session,
  probe,
  onBrowserSignInChange,
}: {
  session: CloudBrowserSignInSession;
  probe: () => Promise<BrowserSignInAvailability>;
  onBrowserSignInChange?: BrowserSignInChange;
}) {
  const signIn = useBrowserSignIn({ config: session.config, onSignedIn: session.complete });
  // A host that sizes the window learns which surface is showing; standalone
  // renders size the window themselves.
  useEffect(() => {
    if (onBrowserSignInChange) onBrowserSignInChange(true);
    else void applyCloudLoginWindowSize('welcome').catch(() => undefined);
  }, [onBrowserSignInChange]);
  const { start } = signIn;
  // Settle availability first so an older server falls back to the form.
  const startWhenAvailable = useCallback<BrowserSignInState['start']>(async (intent: BrowserSignInIntent, options) => {
    if ((await probe()) !== 'unavailable') await start(intent, options);
  }, [probe, start]);
  return (
    <CloudBrowserSignInPage
      signIn={{ ...signIn, start: startWhenAvailable }}
      host={appSignInHost(session.config.baseUrl)}
    />
  );
}

export function CloudSignInGate({
  browserSignIn,
  onBrowserSignInChange,
  ...loginProps
}: CloudLoginPageProps & {
  browserSignIn?: CloudBrowserSignInSession;
  /** Reports whether the browser sign-in screens (true) or the in-app form (false) show. */
  onBrowserSignInChange?: BrowserSignInChange;
}) {
  if (!browserSignIn) return <CloudLoginPage {...loginProps} />;
  return <BrowserSignInOrForm session={browserSignIn} loginProps={loginProps} onBrowserSignInChange={onBrowserSignInChange} />;
}

function BrowserSignInOrForm({
  session,
  loginProps,
  onBrowserSignInChange,
}: {
  session: CloudBrowserSignInSession;
  loginProps: CloudLoginPageProps;
  onBrowserSignInChange?: BrowserSignInChange;
}) {
  const { availability, probe } = useBrowserSignInAvailability(session);
  const unavailable = availability === 'unavailable';
  useEffect(() => {
    if (unavailable) onBrowserSignInChange?.(false);
  }, [unavailable, onBrowserSignInChange]);
  if (unavailable) return <CloudLoginPage {...loginProps} />;
  return <BrowserSignIn session={session} probe={probe} onBrowserSignInChange={onBrowserSignInChange} />;
}
