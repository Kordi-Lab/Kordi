import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseCloudSessionResult } from './useCloudSession';

export type CloudAuthTransition = 'signing-in' | 'signing-out';
export const CLOUD_AUTH_COVER_MS = 180;

/** Let the cover paint before auth can replace the current page or resize it. */
export function waitForCloudAuthCover(): Promise<void> {
  const duration = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 100 : CLOUD_AUTH_COVER_MS;
  return new Promise((resolve) => {
    // WebKit may stop delivering rAF while the app is covered by an OAuth
    // browser or native window animation. Painting must not gate auth forever.
    let frame = 0;
    let paintedTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallbackTimer);
      clearTimeout(paintedTimer);
      resolve();
    };
    const fallbackTimer = setTimeout(finish, duration + 100);
    frame = requestAnimationFrame(() => {
      paintedTimer = setTimeout(finish, duration);
    });
  });
}

type AuthActions = Pick<UseCloudSessionResult, 'signIn' | 'signUp' | 'signInWithProvider' | 'signOut'>;

export function useCloudAuthTransition({ signIn, signUp, signInWithProvider, signOut }: AuthActions) {
  const [activity, setActivity] = useState<CloudAuthTransition | null>(null);
  const mounted = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = useCallback((next: CloudAuthTransition, action: () => Promise<void>): Promise<void> => {
    if (pending.current) return pending.current;
    setActivity(next);
    const operation = (async () => {
      try {
        await waitForCloudAuthCover();
        if (!mounted.current) return;
        await action();
      } finally {
        pending.current = null;
        if (mounted.current) setActivity(null);
      }
    })();
    pending.current = operation;
    return operation;
  }, []);
  const enter = useCallback<AuthActions['signIn']>(
    (...args) => run('signing-in', () => signIn(...args)), [run, signIn],
  );
  const register = useCallback<AuthActions['signUp']>(
    (...args) => run('signing-in', () => signUp(...args)), [run, signUp],
  );
  const social = useCallback<AuthActions['signInWithProvider']>(
    (...args) => run('signing-in', () => signInWithProvider(...args)), [run, signInWithProvider],
  );
  const leave = useCallback(() => run('signing-out', signOut), [run, signOut]);
  return { activity, signIn: enter, signUp: register, socialSignIn: social, signOut: leave };
}
