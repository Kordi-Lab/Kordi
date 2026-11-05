import { useCallback, useEffect, useRef, useState } from 'react';

import {
  probeBrowserSignIn,
  type BrowserSignInAvailability,
  type BrowserSignInIntent,
} from '@/features/cloud/appSignIn/appSignInClient';
import type { CloudBrowserSignInSession } from '@/features/cloud/appSignIn/cloudBrowserSignInSession';
import { useBrowserSignIn, type BrowserSignInState } from '@/features/cloud/appSignIn/useBrowserSignIn';
import { applyCloudLoginWindowSize } from '@/features/cloud/loginWindow';
import { anyMethodAllowed } from '@/features/cloud/managedPolicy/managedSignInPolicy';
import { useManagedSignInPolicy } from '@/features/cloud/managedPolicy/useManagedSignInPolicy';

import { CloudBrowserSignInPage, CloudSignInBlockedPage } from './CloudBrowserSignInPage';
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
  const startWhenAvailable = useCallback<BrowserSignInState['start']>(async (intent: BrowserSignInIntent) => {
    if ((await probe()) !== 'unavailable') await start(intent);
  }, [probe, start]);
  return (
    <CloudBrowserSignInPage
      signIn={{ ...signIn, start: startWhenAvailable }}
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
  // A managed device hides the methods it does not allow; wait for its policy.
  const policy = useManagedSignInPolicy();
  if (!policy) return null;
  if (!anyMethodAllowed(policy)) return <SignInBlocked onBrowserSignInChange={onBrowserSignInChange} />;
  const managedProps = { ...loginProps, allowedSignInMethods: policy.allowedSignInMethods };
  if (!browserSignIn) return <CloudLoginPage {...managedProps} />;
  return <BrowserSignInOrForm session={browserSignIn} loginProps={managedProps} onBrowserSignInChange={onBrowserSignInChange} />;
}

function SignInBlocked({ onBrowserSignInChange }: { onBrowserSignInChange?: BrowserSignInChange }) {
  useEffect(() => {
    if (onBrowserSignInChange) onBrowserSignInChange(true);
    else void applyCloudLoginWindowSize('welcome').catch(() => undefined);
  }, [onBrowserSignInChange]);
  return <CloudSignInBlockedPage />;
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
