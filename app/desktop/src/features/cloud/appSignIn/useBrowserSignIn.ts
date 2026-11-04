import { useCallback, useEffect, useRef, useState } from 'react';

import { CloudAuthError } from '../cloudAuthError';
import type { AppSignInResult, BrowserSignInIntent } from './appSignInClient';
import {
  BrowserSignInAttempt,
  isBrowserSignInCancelled,
  type BrowserSignInConfig,
} from './browserSignIn';

export type BrowserSignInPhase = 'welcome' | 'waiting' | 'finishing';

export type BrowserSignInState = {
  phase: BrowserSignInPhase;
  /** Shown on the welcome screen after a failed or canceled sign-in. */
  error: string | null;
  /** Shown under the paste-code field. */
  codeError: string | null;
  linkCopied: boolean;
  submittingCode: boolean;
  start: (intent: BrowserSignInIntent, options?: { copyLink?: boolean }) => Promise<void>;
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
  config: BrowserSignInConfig;
  onSignedIn: (result: AppSignInResult) => Promise<void>;
}): BrowserSignInState {
  const [phase, setPhase] = useState<BrowserSignInPhase>('welcome');
  const [error, setError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [submittingCode, setSubmittingCode] = useState(false);
  const attemptRef = useRef<BrowserSignInAttempt | null>(null);
  const startingRef = useRef(false);
  // The redirect and a pasted code can both resolve one attempt; finish once.
  const finishingRef = useRef<BrowserSignInAttempt | null>(null);

  useEffect(() => () => {
    attemptRef.current?.cancel();
    attemptRef.current = null;
  }, []);

  const returnToWelcome = useCallback((message: string | null) => {
    attemptRef.current?.cancel();
    attemptRef.current = null;
    setPhase('welcome');
    setCodeError(null);
    setLinkCopied(false);
    setSubmittingCode(false);
    setError(message);
  }, []);

  const finish = useCallback(async (attempt: BrowserSignInAttempt, result: AppSignInResult) => {
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

  const start = useCallback<BrowserSignInState['start']>(async (intent, options) => {
    if (attemptRef.current || startingRef.current) return;
    startingRef.current = true;
    setError(null);
    setCodeError(null);
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
    setLinkCopied(false);
    setPhase('waiting');
    if (options?.copyLink) {
      await attempt.copyLink().then(() => setLinkCopied(true), () => attempt.openBrowser().catch(() => undefined));
    } else {
      void attempt.openBrowser().catch(() => undefined);
    }
    attempt.waitForBrowser().then(
      (result) => finish(attempt, result),
      (caught: unknown) => {
        if (attemptRef.current !== attempt || isBrowserSignInCancelled(caught)) return;
        returnToWelcome(browserSignInErrorMessage(caught));
      },
    );
  }, [config, finish, returnToWelcome]);

  const reopenBrowser = useCallback(() => {
    void attemptRef.current?.openBrowser().catch(() => undefined);
  }, []);

  const cancel = useCallback(() => returnToWelcome(null), [returnToWelcome]);

  const submitCode = useCallback(async (code: string) => {
    const attempt = attemptRef.current;
    if (!attempt) return;
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

  return { phase, error, codeError, linkCopied, submittingCode, start, reopenBrowser, cancel, submitCode };
}
