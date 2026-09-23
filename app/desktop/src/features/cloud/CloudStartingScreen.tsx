export function CloudStartingScreen({
  status = 'syncing',
  onRetry,
  onCancelSignIn,
  visible = true,
}: {
  visible?: boolean;
  status?: 'syncing' | 'error';
  onRetry?: () => void;
  onCancelSignIn?: () => void;
}) {
  return (
    <div
      className={`app-cloud-starting-screen ${status === 'error' ? 'app-cloud-starting-screen-error' : ''} ${onCancelSignIn ? 'app-cloud-starting-screen-oauth' : ''}`}
      data-visible={visible}
      aria-hidden={!visible}
      aria-live="polite"
      aria-busy={visible && status === 'syncing' && !onCancelSignIn}
      aria-label={status === 'error'
        ? 'Cloud sync timed out'
        : onCancelSignIn
          ? 'Waiting for browser sign-in'
          : 'Preparing Kordi Cloud'}
    >
      <div className="app-cloud-starting-content">
        <div className="app-cloud-starting-dots" aria-hidden="true">
          <span className="app-cloud-starting-dot app-cloud-starting-dot-1" />
          <span className="app-cloud-starting-dot app-cloud-starting-dot-2" />
          <span className="app-cloud-starting-dot app-cloud-starting-dot-3" />
        </div>
        {status === 'syncing' && onCancelSignIn && visible ? (
          <>
            <p className="app-cloud-starting-message">Complete sign-in in your browser</p>
            <button
              type="button"
              className="app-cloud-starting-cancel"
              onClick={onCancelSignIn}
            >
              Cancel sign-in
            </button>
          </>
        ) : null}
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
    </div>
  );
}
