import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import { loginCallbackHint, pasteCodeFallback, type ProviderLoginClient, type ProviderLoginSnapshot } from '@/features/cloud/providerLogin';
import { loginCallbackPath, loginCallbackPort, type LoginCallbackCapture } from '@/features/cloud/loginCallbackCapture';
import { OMP_UNAVAILABLE_MESSAGE } from '@/features/cloud/ompAvailability';
import { AuthActionButton, AuthPageNotice, authButtonNeutralClass, authButtonPrimaryClass } from './AuthDetailPrimitives';
import type { AuthAddMethod } from './authAddMethods';
import { loginMethodVerbs } from './providerCopy';
import { useProviderLogin } from './useProviderLogin';

const inputClass = 'app-input-shell app-flat-input h-8 w-[240px] max-w-full rounded-lg px-3 text-[13px] text-white outline-none placeholder:text-slate-500 disabled:opacity-60';
const linkClass = 'text-[12px] font-medium text-[color:var(--app-sidebar-accent)] underline-offset-2 hover:underline';
/** How long the signed-in result shows before the provider page returns. */
const LOGIN_RETURN_DELAY_MS = 2000;

type AuthLoginPageProps = {
  method: AuthAddMethod;
  suggestedAccountName: string;
  client: ProviderLoginClient | null;
  openExternal: (url: string) => void;
  onCompleted: (snapshot: ProviderLoginSnapshot) => void;
  /** Returns to the provider page; called on its own shortly after sign-in completes. */
  onDone: () => void;
  onBack: () => void;
  /** Opens a chat with the provider's active account, offered next to Done. */
  onStartChat?: () => void;
  /** Receives a browser sign-in's localhost redirect on this Mac; without it the user pastes the address. */
  callbackCapture?: LoginCallbackCapture | null;
  /** The backend has no OMP sign-in: the page explains once and keeps its actions off. */
  ompUnavailable?: boolean;
  /** Called when a start is refused because the backend has no OMP sign-in; later failures are transient. */
  onOmpUnavailable?: () => void;
};

/**
 * The login page for one method, following OMP's login dialog: the sign-in
 * link and instructions, then each prompt appended in order with earlier
 * answers kept (secrets hidden), progress lines, and the signed-in result.
 */
export function AuthLoginPage({ method, suggestedAccountName, client, openExternal, onCompleted, onDone, onBack, onStartChat, callbackCapture = null, ompUnavailable = false, onOmpUnavailable }: AuthLoginPageProps) {
  const hosted = method.hosted!;
  const kind = method.kind === 'custom' || method.kind === 'local' ? 'api-key' : method.kind;
  const [accountName, setAccountName] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const openedSessionRef = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  const completed = useCallback((snapshot: ProviderLoginSnapshot) => {
    setKeyValue('');
    onCompleted(snapshot);
  }, [onCompleted]);
  const login = hosted.login;
  const { view, start, submit, cancel, reset } = useProviderLogin(client, completed, {
    capture: callbackCapture,
    port: kind === 'browser' ? loginCallbackPort(login) : null,
    path: loginCallbackPath(login),
  }, onOmpUnavailable);
  const signInUrl = view.auth ? view.auth.launchUrl ?? view.auth.url : null;
  const running = view.phase === 'starting' || view.phase === 'waiting' || view.phase === 'input' || view.phase === 'submitting';
  // Only a refused start (no session yet) means the backend has no OMP sign-in.
  const refusedStart = view.phase === 'failed' && !view.sessionId && view.error?.code === 'provider_auth_not_configured';
  const unavailable = ompUnavailable || refusedStart;
  // A start refused for lack of OMP leaves the page at its first step, with actions off.
  const started = view.phase !== 'idle' && !(unavailable && view.phase === 'failed');
  const input = view.phase === 'input' ? view.input : null;
  const keyStep = kind === 'api-key' && input?.kind === 'api-key';
  const instructions = login.instructions && !login.instructions.includes('{user_code}') ? login.instructions : method.description;
  const signInDescription = view.auth?.instructions && !view.userCode ? view.auth.instructions : instructions;
  // Each step row says something new: a paste step never repeats the sign-in text.
  const callbackHint = loginCallbackHint(view);
  const pasteMessage = input?.kind === 'paste-code' && input.message && input.message !== signInDescription && input.message !== pasteCodeFallback
    ? input.message : null;
  const pasteDescription = pasteMessage ?? callbackHint ?? pasteCodeFallback;

  const blockedTitle = unavailable ? OMP_UNAVAILABLE_MESSAGE : undefined;
  // A busy loopback port is explained before OMP asks for the pasted link.
  const portBusyLine = view.callback === 'port-busy' && running && !input && callbackHint
    && !view.transcript.some((entry) => entry.type === 'answer') ? callbackHint : null;

  // The signed-in result shows briefly, then the provider page returns with the new account.
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);
  const completedPhase = view.phase === 'completed';
  useEffect(() => {
    if (!completedPhase) return;
    const timer = window.setTimeout(() => onDoneRef.current(), LOGIN_RETURN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [completedPhase]);

  // OMP opens the browser for a sign-in link; a device code waits for the user.
  useEffect(() => {
    if (kind !== 'browser' || !signInUrl || !view.sessionId || openedSessionRef.current === view.sessionId) return;
    openedSessionRef.current = view.sessionId;
    openExternal(signInUrl);
  }, [kind, openExternal, signInUrl, view.sessionId]);

  // Escape cancels a running sign-in, leaves a finished one, otherwise goes back one layer.
  // It is handled first and marked handled, so a surrounding dialog does not also close.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      if (running) cancel();
      else if (completedPhase) onDone();
      else onBack();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancel, completedPhase, onBack, onDone, running]);

  const begin = () => {
    if (!client) return;
    setCopied(null);
    start(
      {
        provider: hosted.providerId,
        label: accountName.trim() || suggestedAccountName,
        ...(hosted.mode ? { mode: hosted.mode } : {}),
        ...(hosted.method ? { method: hosted.method } : {}),
      },
      kind === 'api-key' ? { apiKey: keyValue.trim() } : {},
    );
  };
  const copy = (value: string, what: 'code' | 'link') => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(what)).catch(() => undefined);
  };
  const errorMessage = refusedStart ? null
    : kind === 'api-key' && view.error?.code === 'login_unsupported'
      ? 'This provider does not take an API key here. Use another method.'
      : view.error?.message ?? null;

  return (
    <div className="grid min-h-0 w-full pb-6 pt-6">
      {unavailable ? <AuthPageNotice>{OMP_UNAVAILABLE_MESSAGE}</AuthPageNotice> : null}
      <SettingsSection className="app-auth-detail-section">
        <SettingsRow
          title="Account name"
          description="Shown when you choose this account"
          control={(
            <input
              aria-label="Account name"
              placeholder={suggestedAccountName}
              maxLength={80}
              value={accountName}
              disabled={started && view.phase !== 'failed' && view.phase !== 'cancelled'}
              onChange={(event) => setAccountName(event.target.value)}
              className={inputClass}
            />
          )}
        />
        {kind === 'api-key' ? (
          <SettingsRow
            title="API key"
            description={(
              <>
                {instructions}
                {login.authUrl ? (
                  <a href={login.authUrl} onClick={(event) => { event.preventDefault(); openExternal(login.authUrl!); }} className={`${linkClass} ml-1.5`}>
                    Get an API key
                  </a>
                ) : null}
                {errorMessage && (keyStep || !running) ? <span role="alert" className="app-error-text block text-rose-200">{errorMessage}</span> : null}
              </>
            )}
            control={(
              <>
                <input
                  aria-label="API key"
                  type="password"
                  autoComplete="off"
                  placeholder={input?.placeholder ?? login.placeholder ?? login.envVars[0] ?? 'API key'}
                  value={keyValue}
                  disabled={running && !keyStep}
                  onChange={(event) => setKeyValue(event.target.value)}
                  className={inputClass}
                />
                <AuthActionButton
                  key={view.error ? 'save-retry' : 'save'}
                  type="button"
                  className={authButtonPrimaryClass}
                  title={blockedTitle}
                  disabled={unavailable || !client || !keyValue.trim() || (running && !keyStep) || view.phase === 'completed'}
                  onClick={() => (keyStep ? submit(keyValue.trim()) : begin())}
                >
                  Save
                </AuthActionButton>
              </>
            )}
          />
        ) : !started ? (
          <SettingsRow
            title={method.title}
            description={instructions}
            control={(
              <AuthActionButton key="start" type="button" className={authButtonPrimaryClass} title={blockedTitle} disabled={unavailable || !client} onClick={begin}>
                {loginMethodVerbs[kind]}
              </AuthActionButton>
            )}
          />
        ) : null}
        {!client ? <SettingsRow title="Hosted sign-in is unavailable" description="Sign in to Kordi to add accounts through OMP." /> : null}
      </SettingsSection>

      {started ? (
        <SettingsSection title="Steps" className="app-auth-detail-section">
          {signInUrl && kind !== 'api-key' ? (
            <>
              <SettingsRow
                title={view.userCode ? 'Enter this code on the sign-in page' : 'Sign-in page'}
                description={signInDescription}
                control={<AuthActionButton key="open" type="button" className={authButtonPrimaryClass} onClick={() => openExternal(signInUrl)}>Open sign-in page</AuthActionButton>}
              />
              {view.userCode ? (
                <SettingsRow
                  title={<code className="font-mono text-[22px] font-semibold tracking-[0.1em] text-white">{view.userCode}</code>}
                  control={<AuthActionButton key="copy-code" type="button" className={authButtonNeutralClass} onClick={() => copy(view.userCode ?? '', 'code')}>{copied === 'code' ? 'Copied' : 'Copy code'}</AuthActionButton>}
                />
              ) : null}
              <SettingsRow
                title="Link"
                description={<span className="block truncate font-mono text-[11px]" title={signInUrl}>{signInUrl}</span>}
                control={<AuthActionButton key="copy-link" type="button" className={authButtonNeutralClass} onClick={() => copy(signInUrl, 'link')}>{copied === 'link' ? 'Copied' : 'Copy link'}</AuthActionButton>}
              />
            </>
          ) : null}
          {view.transcript.map((entry, index) => (entry.type === 'answer' ? (
            <SettingsRow key={`answer-${index}`} title={entry.label} description={entry.value ?? 'Entered'} />
          ) : (
            <p key={`progress-${index}`} className="m-0 py-2 text-[12px] text-slate-500">{entry.text}</p>
          )))}
          {input && !keyStep ? (
            <SettingsRow
              title={input.kind === 'paste-code' ? 'Paste the redirect URL or code' : input.secret ? 'Secret value' : 'Requested detail'}
              description={(
                <>
                  {input.kind === 'paste-code' ? pasteDescription : input.message}
                  {input.kind !== 'paste-code' && input.placeholder ? <span className="block text-[11px] text-slate-500">e.g., {input.placeholder}</span> : null}
                  {callbackHint && (input.kind !== 'paste-code' || pasteMessage) ? <span data-login-callback-hint="" className="block text-[11px] text-slate-500">{callbackHint}</span> : null}
                  {errorMessage ? <span role="alert" className="app-error-text block text-rose-200">{errorMessage}</span> : null}
                </>
              )}
              control={(
                <>
                  <input
                    aria-label={input.kind === 'paste-code' ? 'Redirect URL or code' : input.message ?? 'Value'}
                    type={input.secret ? 'password' : 'text'}
                    autoComplete="off"
                    placeholder={input.placeholder ?? ''}
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    className={inputClass}
                  />
                  <AuthActionButton
                    key="continue"
                    type="button"
                    className={authButtonPrimaryClass}
                    disabled={!input.allowEmpty && !inputValue.trim()}
                    onClick={() => {
                      const label = input.kind === 'paste-code' ? 'Redirect URL or code' : input.message ?? 'Answer';
                      submit(input.secret ? inputValue : inputValue.trim(), { label, secret: input.secret });
                      setInputValue('');
                    }}
                  >
                    Continue
                  </AuthActionButton>
                </>
              )}
            />
          ) : null}
          {portBusyLine ? <p data-login-callback-hint="" className="m-0 py-2 text-[12px] text-slate-500">{portBusyLine}</p> : null}
          {running && !input && !view.transcript.some((entry) => entry.type === 'progress' && entry.text === view.statusLine) ? (
            <p role="status" className="m-0 py-2 text-[12px] text-slate-500">
              {view.phase === 'starting' ? view.statusLine : view.statusLine && view.statusLine !== view.auth?.instructions ? view.statusLine : 'Waiting for you to finish on the provider page…'}
            </p>
          ) : null}
          {view.phase === 'failed' ? (
            <SettingsRow
              role="alert"
              title="Sign-in did not finish"
              description={<span className="app-error-text text-rose-200">{errorMessage}</span>}
              control={<AuthActionButton key="retry" type="button" className={authButtonPrimaryClass} onClick={reset}>Try again</AuthActionButton>}
            />
          ) : null}
          {view.phase === 'cancelled' ? (
            <SettingsRow
              title="Cancelled"
              description="Nothing was saved."
              control={<AuthActionButton key="restart" type="button" className={authButtonNeutralClass} onClick={reset}>Start again</AuthActionButton>}
            />
          ) : null}
          {view.phase === 'completed' ? (
            <SettingsRow
              role="status"
              title={`Signed in as ${view.snapshot?.label ?? (accountName.trim() || suggestedAccountName)}`}
              description="The account is saved in your Kordi account."
              control={(
                <>
                  {onStartChat ? <AuthActionButton key="start-chat" type="button" className={authButtonPrimaryClass} onClick={onStartChat}>Start chat</AuthActionButton> : null}
                  <AuthActionButton key="done" type="button" className={onStartChat ? authButtonNeutralClass : authButtonPrimaryClass} onClick={onDone}>Done</AuthActionButton>
                </>
              )}
            />
          ) : null}
        </SettingsSection>
      ) : null}

      {running ? (
        <div className="flex justify-end pt-4">
          <AuthActionButton key="cancel" type="button" className={authButtonNeutralClass} onClick={cancel}>Cancel</AuthActionButton>
        </div>
      ) : null}
    </div>
  );
}
