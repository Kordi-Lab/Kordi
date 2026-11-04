import { useState, type FormEvent, type ReactNode } from 'react';

import { CLOUD_LOGIN_WINDOW_DRAG_STYLE } from '@/app/windowDrag';
import type { BrowserSignInState } from '@/features/cloud/appSignIn/useBrowserSignIn';
import { KordiFlyingBird } from '@/features/cloud/KordiFlyingBird';

import { loginHeading, loginSubtitle } from './cloudLoginMessages';

// Signed-out screens for browser sign-in: the welcome screen, then a wait
// screen while the user logs in or signs up in the system browser.

function GateFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="app-cloud-login-page app-cloud-browser-signin fixed inset-0 z-[100] grid place-items-center overflow-hidden px-5 py-14 text-foreground"
      style={{ WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="app-cloud-login-accents pointer-events-none absolute inset-0" />
      <div className="app-cloud-login-grain pointer-events-none absolute inset-0" />
      <div className="absolute" style={CLOUD_LOGIN_WINDOW_DRAG_STYLE} data-tauri-drag-region="true" aria-hidden="true" />
      <div
        className="pointer-events-none absolute left-0 right-0 text-center text-[12px] font-semibold tracking-[0.02em] text-[var(--utility-meta-text)]"
        style={{ top: 'calc(var(--app-gate-crop-y, 0px) + 12px)' }}
      >
        Kordi
      </div>
      {children}
    </div>
  );
}

function WelcomeScreen({ signIn }: { signIn: BrowserSignInState }) {
  return (
    <main className="app-cloud-login-panel relative w-full max-w-[440px] px-6" data-browser-sign-in="welcome">
      <div className="grid justify-items-center text-center">
        <KordiFlyingBird className="app-cloud-welcome-bird" />
        <h1 className="mt-3.5 text-[34px] font-bold leading-[1.1] tracking-[-0.025em] text-foreground">
          {loginHeading(false)}
        </h1>
        <p className="mt-2 text-[12px] font-medium text-muted-foreground">{loginSubtitle(false)}</p>
      </div>
      {signIn.error ? (
        <div role="alert" className="app-cloud-login-error mt-6 rounded-[14px] border px-4 py-2.5 text-[12px] font-medium">
          {signIn.error}
        </div>
      ) : null}
      <div className={`${signIn.error ? 'mt-4' : 'mt-8'} grid gap-2.5`}>
        <button
          type="button"
          className="app-cloud-login-submit h-12 rounded-full border text-[13px] font-semibold tracking-[-0.005em] transition"
          onClick={() => void signIn.start('login')}
        >
          Log in
        </button>
        <button
          type="button"
          className="app-cloud-welcome-secondary h-12 rounded-full border text-[13px] font-semibold tracking-[-0.005em] transition"
          onClick={() => void signIn.start('signup')}
        >
          Sign up
        </button>
      </div>
      <div className="mt-[18px] flex justify-center">
        <button type="button" className="app-cloud-welcome-link" onClick={() => void signIn.start('login', { copyLink: true })}>
          Trouble logging in? Copy link
        </button>
      </div>
    </main>
  );
}

function PasteCodeForm({ signIn }: { signIn: BrowserSignInState }) {
  const [code, setCode] = useState('');
  const busy = signIn.submittingCode || signIn.phase === 'finishing';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy && code.trim()) void signIn.submitCode(code);
  }
  return (
    <form className="app-cloud-browser-signin-paste" onSubmit={submit}>
      <div className="app-cloud-browser-signin-paste-row">
        <input
          className="app-cloud-login-input app-cloud-browser-signin-paste-input"
          aria-label="Paste code"
          placeholder="Paste code"
          autoComplete="one-time-code"
          autoFocus
          spellCheck={false}
          value={code}
          disabled={busy}
          aria-invalid={signIn.codeError ? true : undefined}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
        <button type="submit" className="app-cloud-login-submit app-cloud-browser-signin-paste-submit" disabled={busy || !code.trim()}>
          Continue
        </button>
      </div>
      {signIn.codeError ? <p role="alert" className="app-cloud-browser-signin-paste-error">{signIn.codeError}</p> : null}
    </form>
  );
}

function WaitingScreen({ signIn, host }: { signIn: BrowserSignInState; host: string }) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const finishing = signIn.phase === 'finishing';
  return (
    <div className="app-cloud-browser-signin-content" data-browser-sign-in="waiting" aria-live="polite">
      <div className="app-cloud-signin-badge" aria-hidden="true">
        <span className="app-cloud-signin-ring-track" />
        <span className="app-cloud-signin-ring" />
        <span className="app-cloud-signin-mark"><KordiFlyingBird className="app-cloud-browser-signin-bird" /></span>
      </div>
      <p className="app-cloud-browser-signin-title">{finishing ? 'Signing in…' : 'Continue in your browser'}</p>
      {finishing ? null : (
        <p className="app-cloud-browser-signin-sub">
          {signIn.linkCopied ? `Link copied. Open it in your browser and log in on ${host}.` : `Log in on ${host}, then come back here.`}
        </p>
      )}
      <div className="app-cloud-signin-actions">
        <button type="button" className="app-cloud-signin-action" onClick={signIn.reopenBrowser} disabled={finishing}>
          Open browser again
        </button>
        <span className="app-cloud-signin-separator" aria-hidden="true" />
        <button type="button" className="app-cloud-signin-action app-cloud-signin-action-quiet" onClick={signIn.cancel} disabled={finishing}>
          Cancel
        </button>
      </div>
      {pasteOpen ? <PasteCodeForm signIn={signIn} /> : null}
      {pasteOpen || finishing ? null : (
        <div className="app-cloud-browser-signin-foot">
          <button type="button" className="app-cloud-welcome-link" onClick={() => setPasteOpen(true)}>Paste code</button>
        </div>
      )}
    </div>
  );
}

export function CloudBrowserSignInPage({ signIn, host }: { signIn: BrowserSignInState; host: string }) {
  return (
    <GateFrame>
      {signIn.phase === 'welcome' ? <WelcomeScreen signIn={signIn} /> : <WaitingScreen signIn={signIn} host={host} />}
    </GateFrame>
  );
}
