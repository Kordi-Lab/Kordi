export function CloudStartingScreen({
  status = 'syncing',
  onRetry,
  visible = true,
}: {
  visible?: boolean;
  status?: 'syncing' | 'error';
  onRetry?: () => void;
}) {
  return (
    <div
      className={`app-cloud-starting-screen ${status === 'error' ? 'app-cloud-starting-screen-error' : ''}`}
      data-visible={visible}
      aria-hidden={!visible}
      aria-live="polite"
      aria-busy={visible && status === 'syncing'}
      aria-label={status === 'error' ? 'Cloud sync timed out' : 'Preparing Kordi Cloud'}
    >
      <div className="app-cloud-starting-dots" aria-hidden="true">
        <span className="app-cloud-starting-dot app-cloud-starting-dot-1" />
        <span className="app-cloud-starting-dot app-cloud-starting-dot-2" />
        <span className="app-cloud-starting-dot app-cloud-starting-dot-3" />
      </div>
      {status === 'error' && onRetry ? (
        <button
          type="button"
          className="app-cloud-starting-retry"
          onClick={onRetry}
        >
          Retry sync
        </button>
      ) : null}
    </div>
  );
}
