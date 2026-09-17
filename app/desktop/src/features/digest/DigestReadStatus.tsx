export function DigestReadStatus({ label, failed = false, busy, onRetry }: {
  label: string;
  failed?: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  return <div className="digest-empty" role="status" aria-live="polite">
    <p>{failed ? `${label} could not load.` : `Loading ${label.toLowerCase()}…`}</p>
    {failed && <button disabled={busy} onClick={onRetry}>{busy ? 'Retrying…' : 'Try again'}</button>}
  </div>;
}

/** What the digest can show right now when there is no brief to display. */
export type DigestUnavailableState = 'loading' | 'unreachable' | 'preparing' | 'needsProvider' | 'failed';

/**
 * The one place a digest without a brief explains itself, with the single
 * action that helps: reload when Kordi could not be reached, start a new
 * generation when generating failed, or open settings when no model provider
 * is connected.
 */
export function DigestStateCard({ state, busy, onReload, onRetry, onOpenSettings }: {
  state: DigestUnavailableState;
  busy: boolean;
  onReload: () => void;
  onRetry: () => void;
  onOpenSettings?: () => void;
}) {
  switch (state) {
    case 'loading':
      return <div className="digest-empty" role="status" aria-live="polite"><p>Loading…</p></div>;
    case 'preparing':
      return <div className="digest-empty" role="status" aria-live="polite"><p>Preparing your digest. This can take a minute.</p></div>;
    case 'unreachable':
      return <div className="digest-empty" role="status"><p>Couldn't reach Kordi.</p><button disabled={busy} onClick={onReload}>{busy ? 'Retrying…' : 'Try again'}</button></div>;
    case 'needsProvider':
      return <div className="digest-empty" role="status"><p>Connect a model provider to get your digest.</p>{onOpenSettings ? <button onClick={onOpenSettings}>Open settings</button> : null}</div>;
    case 'failed':
      return <div className="digest-empty" role="status"><p>Your digest couldn't be prepared.</p><button disabled={busy} onClick={onRetry}>{busy ? 'Trying again…' : 'Try again'}</button></div>;
  }
}
