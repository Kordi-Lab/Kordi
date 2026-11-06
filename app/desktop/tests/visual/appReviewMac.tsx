import './previewChatTheme';
import { StrictMode, useLayoutEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import type { AiConsentClient, AiConsentStatus } from '../../src/features/aiConsent/aiConsentClient';
import { AiConsentPromptDialog, AiModelsOffDialog } from '../../src/features/aiConsent/AiConsentDialogs';
import { AiConsentSettingsPanel } from '../../src/features/aiConsent/AiConsentSettingsPanel';
import { applyAiConsent } from '../../src/features/aiConsent/aiConsentStore';
import { CloudGateShell } from '../../src/features/cloud/CloudGateShell';
import type { BrowserSignInState } from '../../src/features/cloud/appSignIn/useBrowserSignIn';
import { CloudBrowserSignInPage } from '../../src/kordi-app/cloud/CloudBrowserSignInPage';
import { CloudLoginPage } from '../../src/kordi-app/cloud/CloudLoginPage';
import '../../src/index.css';

// App Review fixes on the Mac, with synthetic data and no network.
// ?view=login|welcome|consent|off|settings  ?theme=light|dark  ?bare=1 hides the view picker.
const VIEWS = ['login', 'welcome', 'consent', 'off', 'settings'] as const;
type View = typeof VIEWS[number];
const VIEW_LABELS: Record<View, string> = {
  login: 'Sign-in form',
  welcome: 'Welcome',
  consent: 'Consent',
  off: 'AI models are off',
  settings: 'Settings › Privacy',
};

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const bare = params.get('bare') === '1';
const requestedView = params.get('view');
const initialView: View = (VIEWS as readonly string[]).includes(requestedView ?? '') ? requestedView as View : 'login';
localStorage.setItem('kordi.themeMode.v1', theme);
localStorage.removeItem('kordi.cloud.loginMode');

const ACCOUNT_ID = 'acct_review_preview';
const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
const previewConsentClient: AiConsentClient = {
  async get() { return { status: 'allowed', decidedAt: null }; },
  async put(status) {
    await pause();
    return { status, decidedAt: new Date().toISOString() };
  },
};
applyAiConsent(ACCOUNT_ID, (params.get('consent') as AiConsentStatus | null) ?? 'allowed');

const welcomeSignIn: BrowserSignInState = {
  phase: 'welcome',
  error: null,
  codeError: null,
  submittingCode: false,
  start: async () => {},
  reopenBrowser: () => {},
  cancel: () => {},
  submitCode: async () => {},
};

const noop = () => {};

function DialogBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className={`kordi-app theme-${theme} min-h-screen`} style={{ background: 'var(--app-main-bg)' }}>
      {children}
    </div>
  );
}

function ViewBody({ view }: { view: View }) {
  if (view === 'login') {
    return (
      <CloudGateShell>
        <CloudLoginPage onModeChange={noop} onSocialSignIn={async () => {}} oauthProviders={['google', 'github', 'apple']} />
      </CloudGateShell>
    );
  }
  if (view === 'welcome') {
    return <CloudGateShell><CloudBrowserSignInPage signIn={welcomeSignIn} /></CloudGateShell>;
  }
  if (view === 'consent') {
    return <DialogBackdrop><AiConsentPromptDialog saving={false} error={null} onAllow={noop} onDecline={noop} onDismiss={noop} /></DialogBackdrop>;
  }
  if (view === 'off') {
    return <DialogBackdrop><AiModelsOffDialog saving={false} error={null} onAllow={noop} onDismiss={noop} /></DialogBackdrop>;
  }
  return (
    <div
      className={`kordi-app theme-${theme} grid min-h-screen place-items-center p-6`}
      style={theme === 'dark' ? { background: '#101824', color: 'rgb(255 255 255)' } : { background: 'var(--app-main-bg)', color: 'rgb(15 23 42)' }}
    >
      <div className="app-transient-surface app-modal-panel app-cloud-account-settings-dialog w-[min(760px,calc(100vw-40px))] overflow-hidden rounded-[12px]">
        <div className="app-main-panel app-cloud-account-settings-page">
          <div className="px-8 pb-8 pt-10"><AiConsentSettingsPanel client={previewConsentClient} /></div>
        </div>
      </div>
    </div>
  );
}

function AppReviewPreview() {
  const [view, setView] = useState<View>(initialView);
  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);
  const choose = (next: View) => {
    setView(next);
    const url = new URL(location.href);
    url.searchParams.set('view', next);
    history.replaceState(null, '', url);
  };
  return (
    <>
      <ViewBody key={view} view={view} />
      {bare ? null : (
        <nav
          aria-label="Preview views"
          style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 200000, display: 'flex', gap: 6, padding: 6, borderRadius: 10, background: 'rgb(15 23 42 / 0.82)', font: '500 11px system-ui' }}
        >
          {VIEWS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={view === item}
              onClick={() => choose(item)}
              style={{ padding: '4px 8px', borderRadius: 6, border: 0, color: '#fff', background: view === item ? 'rgb(255 255 255 / 0.22)' : 'transparent', cursor: 'pointer' }}
            >
              {VIEW_LABELS[item]}
            </button>
          ))}
        </nav>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><AppReviewPreview /></StrictMode>);
