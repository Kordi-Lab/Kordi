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
