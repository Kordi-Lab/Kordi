import type { ComponentType } from 'react';
import { GitHubMark, GoogleMark } from '@/kordi-app/cloud/CloudLoginMarks';
import type { CloudOAuthProvider } from './authClient';

const SIGN_IN_PROVIDERS: Record<CloudOAuthProvider, { label: string; Mark: ComponentType }> = {
  google: { label: 'Google', Mark: GoogleMark },
  github: { label: 'GitHub', Mark: GitHubMark },
};

export function CloudStartingScreen({
  status = 'syncing',
  onRetry,
  onCancelSignIn,
  onReopenSignIn,
  signInProvider,
  visible = true,
}: {
  visible?: boolean;
  status?: 'syncing' | 'error';
  onRetry?: () => void;
  onCancelSignIn?: () => void;
  onReopenSignIn?: () => void;
  signInProvider?: CloudOAuthProvider;
}) {
  const waitingForBrowser = status === 'syncing' && Boolean(onCancelSignIn) && visible;
  const provider = signInProvider ? SIGN_IN_PROVIDERS[signInProvider] : null;
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
      {waitingForBrowser ? (
        <div className="app-cloud-starting-titlebar" aria-hidden="true">Kordi</div>
      ) : null}
      <div className="app-cloud-starting-content">
        {waitingForBrowser ? (
          <>
            <div className="app-cloud-signin-badge" aria-hidden="true">
              <span className="app-cloud-signin-ring-track" />
              <span className="app-cloud-signin-ring" />
              {provider ? <span className="app-cloud-signin-mark"><provider.Mark /></span> : null}
            </div>
            <div className="app-cloud-signin-copy">
              <p className="app-cloud-starting-message">Continue in your browser</p>
              {provider ? <p className="app-cloud-signin-provider">Signing in with {provider.label}</p> : null}
            </div>
            <div className="app-cloud-signin-actions">
              {onReopenSignIn ? (
                <>
                  <button type="button" className="app-cloud-signin-action" onClick={onReopenSignIn}>
                    Reopen browser
                  </button>
                  <span className="app-cloud-signin-separator" aria-hidden="true" />
                </>
              ) : null}
              <button
                type="button"
                className="app-cloud-signin-action app-cloud-signin-action-quiet"
                onClick={onCancelSignIn}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="app-cloud-starting-dots" aria-hidden="true">
            <span className="app-cloud-starting-dot app-cloud-starting-dot-1" />
            <span className="app-cloud-starting-dot app-cloud-starting-dot-2" />
            <span className="app-cloud-starting-dot app-cloud-starting-dot-3" />
          </div>
        )}
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
