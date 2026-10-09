// How the cloud connectors client opens a provider's sign-in page and waits
// for the result, plus the timeout and cancellation helpers it uses.

import { ConnectorFlowCanceledError } from './connectorsErrors';

const MINUTE = 60_000;

export const CONNECTOR_OAUTH_TIMEOUT_MS = 10 * MINUTE;

/** A local callback target the server redirects to after the provider grant. */
export type ConnectorOAuthCallback = {
  redirectUrl: string;
  /** Resolves with the callback fragment, for example `#kordi_connector=...`. */
  wait(timeoutMs: number): Promise<string>;
  cancel(): Promise<void>;
};

export type ConnectorOAuthHandoff = {
  /** Null when this shell cannot receive the callback; the client then polls. */
  prepare(): Promise<ConnectorOAuthCallback | null>;
  /** Resolves false when the page could not be opened, for example a blocked pop-up. */
  open(url: string): Promise<boolean | void>;
};

/**
 * Same handoff as cloud sign-in: a one-use loopback listener in the desktop
 * shell receives the redirect, and the provider page opens in the system
 * browser. Outside the shell the page opens in a new tab and the client polls.
 */
export const desktopConnectorOAuthHandoff: ConnectorOAuthHandoff = {
  async prepare() {
    const desktop = await import('@/lib/desktop');
    const loopback = await desktop.prepareDesktopCloudOAuthLoopback();
    if (!loopback) return null;
    return {
      redirectUrl: loopback.redirectUrl,
      wait: (timeoutMs) => desktop.waitForDesktopCloudOAuthLoopback(loopback.requestId, timeoutMs),
      cancel: async () => {
        await desktop.invokeDesktop<void>('cloud_oauth_loopback_cancel', { requestId: loopback.requestId })
          .catch(() => undefined);
      },
    };
  },
  async open(url) {
    const desktop = await import('@/lib/desktop');
    if (desktop.isNativeDesktopShell()) {
      await desktop.openDesktopExternalUrl(url);
      return true;
    }
    // `noopener` makes `window.open` return null, so detach the opener by hand
    // to tell a blocked pop-up apart from an opened one.
    const popup = window.open(url, '_blank');
    if (!popup) return false;
    try {
      popup.opener = null;
    } catch {
      // Some browsers do not allow this; the page is still open.
    }
    return true;
  },
};

/** Rejects with `message` after `timeoutMs`; the timer is cleared on settle or abort. */
export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error(message)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); reject(new Error(message)); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function connectorCanceledError(name: string): ConnectorFlowCanceledError {
  return new ConnectorFlowCanceledError(`Connecting ${name} was canceled.`);
}

/** Rejects with a canceled error as soon as `signal` aborts. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined, name: string): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(connectorCanceledError(name));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(connectorCanceledError(name));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function abortableDelay(ms: number, signal: AbortSignal | undefined, name: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sleep = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return abortable(sleep, signal, name).finally(() => clearTimeout(timer));
}
