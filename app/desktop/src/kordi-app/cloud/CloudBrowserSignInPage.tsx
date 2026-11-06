import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { APP_WINDOW_RESIZE_EDGE } from '@/app/windowDrag';
import { ErrorLine } from '@/components/ui/ErrorLine';
import type { BrowserSignInState } from '@/features/cloud/appSignIn/useBrowserSignIn';
import { KordiFlyingBird } from '@/features/cloud/KordiFlyingBird';

import { loginHeading, loginSubtitle } from './cloudLoginMessages';

// Signed-out screens for browser sign-in: the welcome screen, then a wait
// screen while the user logs in or signs up in the system browser.

// The frame fills the visible window, so no crop offset applies inside it.
const GATE_DRAG_STYLE = {
  left: `${APP_WINDOW_RESIZE_EDGE}px`,
  right: `${APP_WINDOW_RESIZE_EDGE}px`,
  top: `${APP_WINDOW_RESIZE_EDGE}px`,
  height: `${48 - APP_WINDOW_RESIZE_EDGE}px`,
  WebkitAppRegion: 'drag',
} as const;

// Keys that move focus or press the focused control.
const KEYBOARD_FOCUS_KEYS = new Set(['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/**
 * Whether the person is using the keyboard. Opening the window focuses the
 * first button without any key press; WebKit treats that focus as visible,
 * so rings wait for a navigation key and hide again on a click.
 */
function useKeyboardFocus() {
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (KEYBOARD_FOCUS_KEYS.has(event.key)) setKeyboard(true);
    };
    const onPointerDown = () => setKeyboard(false);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);
  return keyboard;
}

function GateFrame({ children }: { children: ReactNode }) {
  const keyboardFocus = useKeyboardFocus();
  return (
    <div
      className="app-cloud-login-page app-cloud-browser-signin text-foreground"
      data-keyboard-focus={keyboardFocus || undefined}
      style={{ WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="app-cloud-login-accents pointer-events-none absolute inset-0" />
      <div className="app-cloud-login-grain pointer-events-none absolute inset-0" />
      <div className="absolute" style={GATE_DRAG_STYLE} data-tauri-drag-region="true" aria-hidden="true" />
      {children}
    </div>
  );
}

function WelcomeScreen({ signIn }: { signIn: BrowserSignInState }) {
  return (
    <main className="app-cloud-login-panel app-cloud-welcome" data-browser-sign-in="welcome">
      <KordiFlyingBird className="app-cloud-welcome-bird" cutout />
      <h1 className="app-cloud-welcome-title">{loginHeading(false)}</h1>
      <p className="app-cloud-welcome-subtitle">{loginSubtitle(false)}</p>
      <div className="app-cloud-welcome-actions">
        <button
          type="button"
          className="app-cloud-login-submit h-11 rounded-full border text-[13px] font-semibold tracking-[-0.005em] transition"
          onClick={() => void signIn.start('login')}
        >
          Log in
        </button>
        <button
          type="button"
          className="app-cloud-welcome-secondary h-11 rounded-full border text-[13px] font-semibold tracking-[-0.005em] transition"
          onClick={() => void signIn.start('signup')}
        >
          Sign up
        </button>
      </div>
      {signIn.error ? <ErrorLine align="center" className="mt-3">{signIn.error}</ErrorLine> : null}
    </main>
  );
}

function PasteCodeForm({ signIn }: { signIn: BrowserSignInState }) {
  const [code, setCode] = useState('');
  const errorId = useId();
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
          aria-describedby={signIn.codeError ? errorId : undefined}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
        <button type="submit" className="app-cloud-login-submit app-cloud-browser-signin-paste-submit" disabled={busy || !code.trim()}>
          Continue
        </button>
      </div>
      {signIn.codeError ? <ErrorLine id={errorId} className="mt-0">{signIn.codeError}</ErrorLine> : null}
    </form>
  );
}

function WaitingScreen({ signIn }: { signIn: BrowserSignInState }) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const finishing = signIn.phase === 'finishing';
  const titleRef = useRef<HTMLParagraphElement>(null);
  // The welcome screen's buttons are gone; keep focus on the new screen.
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="app-cloud-browser-signin-content" data-browser-sign-in="waiting" aria-live="polite">
      <div className="app-cloud-signin-badge" aria-hidden="true">
        <span className="app-cloud-signin-ring-track" />
        <span className="app-cloud-signin-ring" />
        <span className="app-cloud-signin-mark"><KordiFlyingBird className="app-cloud-browser-signin-bird" cutout /></span>
      </div>
      <p ref={titleRef} tabIndex={-1} className="app-cloud-browser-signin-title">{finishing ? 'Signing in…' : 'Continue in your browser'}</p>
      <div className="app-cloud-signin-actions">
        <button type="button" className="app-cloud-signin-action" onClick={signIn.reopenBrowser} disabled={finishing}>
          Open browser again
        </button>
        <span className="app-cloud-signin-separator" aria-hidden="true" />
        <button type="button" className="app-cloud-signin-action app-cloud-signin-action-quiet" onClick={signIn.cancel} disabled={finishing || signIn.submittingCode}>
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

export function CloudBrowserSignInPage({ signIn }: { signIn: BrowserSignInState }) {
  return (
    <GateFrame>
      {signIn.phase === 'welcome' ? <WelcomeScreen signIn={signIn} /> : <WaitingScreen signIn={signIn} />}
    </GateFrame>
  );
}
