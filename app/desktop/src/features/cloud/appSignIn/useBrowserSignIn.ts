import { useCallback, useEffect, useRef, useState } from 'react';

import { CloudAuthError } from '../cloudAuthError';
import type { AppSignInResult, BrowserSignInIntent } from './appSignInClient';
import {
  BrowserSignInAttempt,
  isBrowserSignInCancelled,
} from './browserSignIn';
import { DeviceCodeAttempt, type DeviceCodeSignInConfig } from './deviceCodeSignIn';

/** `code`: showing a device code while the app polls (the browser could not open). */
export type BrowserSignInPhase = 'welcome' | 'waiting' | 'code' | 'finishing';

export type DeviceCodeDisplay = { userCode: string; verificationUri: string; expiresAt: number };

export type BrowserSignInState = {
  phase: BrowserSignInPhase;
  /** Shown on the welcome screen after a failed or canceled sign-in. */
  error: string | null;
  /** Shown under the paste-code field. */
  codeError: string | null;
  submittingCode: boolean;
  /** The system browser could not be opened; offer sign-in with a code. */
  browserUnavailable: boolean;
  /** The code to show while `phase` is `code`. */
  deviceCode: DeviceCodeDisplay | null;
  start: (intent: BrowserSignInIntent) => Promise<void>;
  startCodeSignIn: () => Promise<void>;
  reopenBrowser: () => void;
  cancel: () => void;
  submitCode: (code: string) => Promise<void>;
};

export function browserSignInErrorMessage(caught: unknown): string {
  if (caught instanceof CloudAuthError) {
    if (caught.code === 'network_error') return 'Could not reach the server. Check your connection and try again.';
    return caught.message || 'Could not finish signing in. Try again.';
  }
  return 'Could not finish signing in. Try again.';
}

export function useBrowserSignIn({
  config,
  onSignedIn,
}: {
  config: DeviceCodeSignInConfig;
  onSignedIn: (result: AppSignInResult) => Promise<void>;
}): BrowserSignInState {
  const [phase, setPhase] = useState<BrowserSignInPhase>('welcome');
  const [error, setError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submittingCode, setSubmittingCode] = useState(false);
  const [browserUnavailable, setBrowserUnavailable] = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeDisplay | null>(null);
  const attemptRef = useRef<BrowserSignInAttempt | DeviceCodeAttempt | null>(null);
  const startingRef = useRef(false);
  // The redirect and a pasted code can both resolve one attempt; finish once.
  const finishingRef = useRef<BrowserSignInAttempt | DeviceCodeAttempt | null>(null);

  useEffect(() => () => {
    attemptRef.current?.cancel();
    attemptRef.current = null;
  }, []);

  const returnToWelcome = useCallback((message: string | null) => {
    attemptRef.current?.cancel();
    attemptRef.current = null;
    setPhase('welcome');
    setDeviceCode(null);
    setCodeError(null);
    setSubmittingCode(false);
    setError(message);
  }, []);

  const finish = useCallback(async (attempt: BrowserSignInAttempt | DeviceCodeAttempt, result: AppSignInResult) => {
    if (attemptRef.current !== attempt || finishingRef.current === attempt) return;
    finishingRef.current = attempt;
    setPhase('finishing');
    try {
      await onSignedIn(result);
      if (attemptRef.current === attempt) attemptRef.current = null;
    } catch (caught) {
      if (attemptRef.current === attempt) returnToWelcome(browserSignInErrorMessage(caught));
    } finally {
      if (finishingRef.current === attempt) finishingRef.current = null;
    }
  }, [onSignedIn, returnToWelcome]);

  const start = useCallback<BrowserSignInState['start']>(async (intent) => {
    if (attemptRef.current || startingRef.current) return;
    startingRef.current = true;
    setError(null);
    setCodeError(null);
    setBrowserUnavailable(false);
    let attempt: BrowserSignInAttempt;
    try {
      attempt = await BrowserSignInAttempt.start(config, intent);
    } catch (caught) {
      startingRef.current = false;
      setError(browserSignInErrorMessage(caught));
      return;
    }
    startingRef.current = false;
    attemptRef.current = attempt;
    setPhase('waiting');
    void attempt.openBrowser().catch(() => {
      if (attemptRef.current === attempt) setBrowserUnavailable(true);
    });
    attempt.waitForBrowser().then(
      (result) => finish(attempt, result),
      (caught: unknown) => {
        if (attemptRef.current !== attempt || isBrowserSignInCancelled(caught)) return;
        returnToWelcome(browserSignInErrorMessage(caught));
      },
    );
  }, [config, finish, returnToWelcome]);

  const reopenBrowser = useCallback(() => {
    const attempt = attemptRef.current;
    if (!(attempt instanceof BrowserSignInAttempt)) return;
    void attempt.openBrowser().then(
      () => setBrowserUnavailable(false),
      () => setBrowserUnavailable(true),
    );
  }, []);

  const startCodeSignIn = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    attemptRef.current?.cancel();
    attemptRef.current = null;
    setError(null);
    setCodeError(null);
    let attempt: DeviceCodeAttempt;
    try {
      attempt = await DeviceCodeAttempt.start(config);
    } catch (caught) {
      startingRef.current = false;
      // A server without device codes keeps the browser flow.
      returnToWelcome(browserSignInErrorMessage(caught));
      return;
    }
    startingRef.current = false;
    attemptRef.current = attempt;
    const { userCode, verificationUri, expiresAt } = attempt.prompt;
    setDeviceCode({ userCode, verificationUri, expiresAt });
    setPhase('code');
    attempt.wait().then(
      (result) => finish(attempt, result),
      (caught: unknown) => {
        if (attemptRef.current !== attempt || isBrowserSignInCancelled(caught)) return;
        returnToWelcome(browserSignInErrorMessage(caught));
      },
    );
  }, [config, finish, returnToWelcome]);

  const cancel = useCallback(() => returnToWelcome(null), [returnToWelcome]);

  const submitCode = useCallback(async (code: string) => {
    const attempt = attemptRef.current;
    if (!(attempt instanceof BrowserSignInAttempt)) return;
    setCodeError(null);
    setSubmittingCode(true);
    try {
      const result = await attempt.exchangeCode(code);
      await finish(attempt, result);
    } catch (caught) {
      if (attemptRef.current === attempt && !isBrowserSignInCancelled(caught)) {
        setCodeError(browserSignInErrorMessage(caught));
      }
    } finally {
      if (attemptRef.current === attempt) setSubmittingCode(false);
    }
  }, [finish]);

  return {
    phase,
    error,
    codeError,
    submittingCode,
    browserUnavailable,
    deviceCode,
    start,
    startCodeSignIn,
    reopenBrowser,
    cancel,
    submitCode,
  };
}
