import { useCallback, useEffect, useReducer, useRef } from 'react';
import { loginCallbackCaptureErrorCode, type LoginCallbackCapture } from '@/features/cloud/loginCallbackCapture';
import {
  acceptsLoginCallback,
  initialProviderLoginView,
  isTerminalLoginStatus,
  providerLoginReducer,
  toProviderLoginError,
  type ProviderLoginClient,
  type ProviderLoginSession,
  type ProviderLoginSnapshot,
  type ProviderLoginStartInput,
} from '@/features/cloud/providerLogin';
import { pollProviderLogin } from '@/features/cloud/providerLoginPoll';

/** Where a browser sign-in's localhost redirect can be received on this Mac. */
export type ProviderLoginCallback = { capture: LoginCallbackCapture | null; port: number | null; path?: string | null };

/**
 * Drives one hosted OMP sign-in: starts the session, long-polls its steps,
 * relays input, and cancels it when the flow closes early. For a browser
 * sign-in with a loopback port it also captures the provider's redirect on
 * this Mac and submits it in place of a pasted URL. `onOmpUnavailable` hears
 * only a start refused because the backend has no OMP sign-in.
 */
export function useProviderLogin(
  client: ProviderLoginClient | null,
  onCompleted: (snapshot: ProviderLoginSnapshot) => void,
  callback: ProviderLoginCallback = { capture: null, port: null },
  onOmpUnavailable?: () => void,
) {
  const [view, dispatch] = useReducer(providerLoginReducer, initialProviderLoginView);
  const controllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<{ id: string; terminal: boolean } | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const onCompletedRef = useRef(onCompleted);
  const onOmpUnavailableRef = useRef(onOmpUnavailable);
  const completedRef = useRef<string | null>(null);
  const callbackRef = useRef(callback);
  // The session a capture listens for, the latest session seen, and a redirect waiting for its step.
  const captureSessionRef = useRef<string | null>(null);
  const lastSessionRef = useRef<ProviderLoginSession | null>(null);
  const capturedUrlRef = useRef<string | null>(null);

  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);
  useEffect(() => { onOmpUnavailableRef.current = onOmpUnavailable; }, [onOmpUnavailable]);
  const { capture, port, path } = callback;
  useEffect(() => { callbackRef.current = { capture, port, path }; }, [capture, port, path]);

  const stopCapture = useCallback(() => {
    capturedUrlRef.current = null;
    if (captureSessionRef.current === null) return;
    captureSessionRef.current = null;
    void callbackRef.current.capture?.stop().catch(() => undefined);
  }, []);

  const noteCompleted = useCallback((session: ProviderLoginSession) => {
    if (session.status !== 'completed' || !session.snapshot || completedRef.current === session.sessionId) return;
    completedRef.current = session.sessionId;
    onCompletedRef.current(session.snapshot);
  }, []);

  // Shows a session state from any response; a final one ends polling and the capture.
  const applySession = useCallback((session: ProviderLoginSession) => {
    lastSessionRef.current = session;
    dispatch({ type: 'session', session });
    if (isTerminalLoginStatus(session.status)) {
      if (sessionRef.current?.id === session.sessionId) sessionRef.current.terminal = true;
      stopCapture();
    }
    noteCompleted(session);
  }, [noteCompleted, stopCapture]);

  const submitInput = useCallback((sessionId: string, value: string, signal: AbortSignal) => {
    if (!client) return;
    void client.submit(sessionId, value, signal)
      .then((next) => { if (next && !signal.aborted) applySession(next); })
      .catch((caught: unknown) => { if (!signal.aborted) dispatch({ type: 'error', error: toProviderLoginError(caught) }); });
  }, [applySession, client]);

  // Submits a received redirect once OMP asks for the code; it never enters the transcript.
  const submitCapturedUrl = useCallback((signal: AbortSignal) => {
    const url = capturedUrlRef.current;
    const session = lastSessionRef.current;
    if (!client || url === null || !session || !acceptsLoginCallback(session)) return;
    capturedUrlRef.current = null;
    dispatch({ type: 'submit' });
    submitInput(session.sessionId, url, signal);
  }, [client, submitInput]);

  const startCapture = useCallback((session: ProviderLoginSession, signal: AbortSignal) => {
    const { capture: listener, port: callbackPort, path: callbackPath } = callbackRef.current;
    const hasLink = Boolean(session.auth) || session.step?.type === 'open-url';
    if (!listener || !callbackPort || !hasLink || captureSessionRef.current === session.sessionId) return;
    captureSessionRef.current = session.sessionId;
    dispatch({ type: 'callback', state: 'listening' });
    const current = () => !signal.aborted && captureSessionRef.current === session.sessionId;
    listener.start(callbackPort, callbackPath ?? undefined).then((url) => {
      if (!current()) return;
      dispatch({ type: 'callback', state: 'received' });
      capturedUrlRef.current = url;
      submitCapturedUrl(signal);
    }, (caught: unknown) => {
      if (!current()) return;
      // Another program holds the port: say which, and keep the paste field.
      dispatch(loginCallbackCaptureErrorCode(caught) === 'port_unavailable'
        ? { type: 'callback', state: 'port-busy', port: callbackPort }
        : { type: 'callback', state: 'unavailable' });
    });
  }, [submitCapturedUrl]);

  const handleSession = useCallback((session: ProviderLoginSession, signal: AbortSignal) => {
    if (signal.aborted) return;
    applySession(session);
    if (!isTerminalLoginStatus(session.status)) {
      // Listen before the page opens the browser, then take OMP's paste step when it arrives.
      startCapture(session, signal);
      submitCapturedUrl(signal);
    }
    const pendingKey = pendingKeyRef.current;
    if (pendingKey !== null && session.status === 'awaiting-input' && session.step?.type === 'api-key') {
      pendingKeyRef.current = null;
      dispatch({ type: 'submit' });
      // The long poll also delivers the result of this input, including completion.
      submitInput(session.sessionId, pendingKey, signal);
    }
  }, [applySession, startCapture, submitCapturedUrl, submitInput]);

  // Ends the flow here and cancels the session; resolves with the server's final state when it sends one.
  const stop = useCallback((): Promise<ProviderLoginSession | null> => {
    stopCapture();
    controllerRef.current?.abort();
    controllerRef.current = null;
    const session = sessionRef.current;
    if (!client || !session || session.terminal) return Promise.resolve(null);
    session.terminal = true;
    return client.cancel(session.id).catch(() => null);
  }, [client, stopCapture]);

  useEffect(() => () => { void stop(); }, [stop]);

  const start = useCallback((input: ProviderLoginStartInput, options: { apiKey?: string } = {}) => {
    if (!client) return;
    void stop();
    const controller = new AbortController();
    const { signal } = controller;
    controllerRef.current = controller;
    sessionRef.current = null;
    completedRef.current = null;
    pendingKeyRef.current = options.apiKey ?? null;
    dispatch({ type: 'start' });
    const fail = (caught: unknown) => {
      if (signal.aborted) return;
      stopCapture();
      dispatch({ type: 'error', error: toProviderLoginError(caught) });
    };
    void (async () => {
      let session: ProviderLoginSession;
      try {
        session = await client.start(input, signal);
      } catch (caught) {
        // Only a refused start means the backend has no OMP; a failure later in the session is transient.
        if (!signal.aborted && toProviderLoginError(caught).ompUnavailable) onOmpUnavailableRef.current?.();
        fail(caught);
        return;
      }
      if (signal.aborted) {
        void client.cancel(session.sessionId).catch(() => undefined);
        return;
      }
      sessionRef.current = { id: session.sessionId, terminal: isTerminalLoginStatus(session.status) };
      handleSession(session, signal);
      if (isTerminalLoginStatus(session.status)) return;
      await pollProviderLogin(client, session, {
        signal,
        onSession: (next) => handleSession(next, signal),
        stopped: () => sessionRef.current?.terminal ?? true,
      }).catch(fail);
    })();
  }, [client, handleSession, stop, stopCapture]);

  const submit = useCallback((value: string, answer?: { label: string; secret: boolean }) => {
    const session = sessionRef.current;
    const signal = controllerRef.current?.signal;
    if (!client || !session || !signal) return;
    dispatch({ type: 'submit', ...(answer ? { answer: { ...answer, value } } : {}) });
    submitInput(session.id, value, signal);
  }, [client, submitInput]);

  const cancel = useCallback(() => {
    const sessionId = sessionRef.current?.id ?? null;
    dispatch({ type: 'cancelled' });
    // A sign-in can finish just before the cancel reaches the server; its saved account then shows.
    void stop().then((final) => {
      if (!final || final.sessionId !== sessionId || sessionRef.current?.id !== sessionId || final.status !== 'completed') return;
      applySession(final);
    });
  }, [applySession, stop]);

  const reset = useCallback(() => {
    void stop();
    sessionRef.current = null;
    dispatch({ type: 'reset' });
  }, [stop]);

  return { view, start, submit, cancel, reset };
}
