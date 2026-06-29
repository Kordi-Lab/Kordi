import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, LoaderCircle, LogIn, Shield, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AuthFlowSteps, type AuthFlowStep } from '@/kordi-app/auth/AuthFlowSteps';
import type { DesktopAuthAttemptSnapshot, DesktopAuthProvider, DesktopAuthState } from '@/kordi-app/types';
import {
  cancelDesktopAuthAttempt,
  fetchDesktopAuthAttemptState,
  fetchDesktopAuthState,
  saveDesktopApiKey,
  startDesktopOAuthLogin,
  submitDesktopAuthManualInput,
} from '@/lib/desktop';

type AuthPopupProps = {
  providerId?: string;
  mode?: 'oauth' | 'api-key';
  authority?: string;
  requireAuthority?: boolean;
  embedded?: boolean;
  authState?: DesktopAuthState | null;
  onRequestClose?: () => void;
  onAuthUpdated?: () => void | Promise<void>;
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
};

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false;
  return typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

async function closePopupWindow(embedded = false, onRequestClose?: () => void) {
  if (embedded) {
    onRequestClose?.();
    return;
  }

  if (isNativeDesktopShell()) {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await getCurrentWebviewWindow().close();
    return;
  }

  window.close();
}

function notifyAuthUpdated() {
  try {
    const channel = new BroadcastChannel('kordi-auth');
    channel.postMessage({ type: 'auth-updated', at: Date.now() });
    channel.close();
  } catch {}
}

function authPopupTitle(provider: DesktopAuthProvider | null, providerId: string, mode: 'oauth' | 'api-key') {
  if (providerId === 'anthropic' && mode === 'oauth') return 'Claude subscription';
  if (providerId === 'anthropic' && mode === 'api-key') return 'Anthropic API key';
  if (providerId === 'openai-codex' && mode === 'oauth') return 'ChatGPT sign-in';
  if (providerId === 'openai' && mode === 'api-key') return 'OpenAI API key';
  if (providerId === 'lm-studio' && mode === 'api-key') return 'LM Studio optional API key';
  if (providerId === 'ollama' && mode === 'api-key') return 'Ollama optional API key';
  return provider ? `${provider.label} ${mode === 'oauth' ? 'sign-in' : 'API key'}` : 'Authentication';
}

function authPopupDescription(providerId: string, mode: 'oauth' | 'api-key') {
  if (providerId === 'anthropic' && mode === 'oauth') {
    return 'Sign in with the Claude subscription account you already use. Kordi will save it for both desktop and terminal sessions.';
  }
  if (providerId === 'anthropic' && mode === 'api-key') {
    return 'Paste an Anthropic API key for billed API usage, scripting, and automation.';
  }
  if (providerId === 'openai-codex' && mode === 'oauth') {
    return 'Sign in with your ChatGPT account here. Kordi will save it and refresh Settings automatically.';
  }
  if (providerId === 'openai' && mode === 'api-key') {
    return 'Paste your OpenAI API key and Kordi will save it in the shared auth store used by desktop and terminal sessions.';
  }
  if (providerId === 'lm-studio' && mode === 'api-key') {
    return 'The default LM Studio local server does not need a key. Paste one only if you enabled API-key protection in LM Studio.';
  }
  if (providerId === 'ollama' && mode === 'api-key') {
    return 'The default Ollama local server does not need a key. Paste one only if your Ollama-compatible endpoint requires authorization.';
  }
  return mode === 'oauth'
    ? 'Finish browser sign-in here. Kordi will save the result and refresh Settings automatically.'
    : 'Paste the API key here and Kordi will save it in the shared auth store used by desktop and terminal sessions.';
}

function authPopupPrimaryActionLabel(providerId: string, mode: 'oauth' | 'api-key') {
  if (providerId === 'anthropic' && mode === 'oauth') return 'Open Claude sign-in';
  if (providerId === 'anthropic' && mode === 'api-key') return 'Save Anthropic key';
  if ((providerId === 'lm-studio' || providerId === 'ollama') && mode === 'api-key') return 'Save optional key';
  if (mode === 'oauth') return 'Open sign-in';
  return 'Save key';
}

function isLocalAuthProvider(providerId: string) {
  return providerId === 'lm-studio' || providerId === 'ollama';
}

function buildPopupSteps(authAttempt: DesktopAuthAttemptSnapshot | null): AuthFlowStep[] {
  const openStep = 'Open the sign-in page';
  const browserStep = 'Finish sign-in in your browser';
  const returnStep = 'Return here if a code or callback is needed';
  const saveStep = 'Save this account to Kordi';

  if (!authAttempt) {
    return [
      { label: openStep, state: 'active' },
      { label: browserStep, state: 'pending' },
      { label: returnStep, state: 'pending' },
      { label: saveStep, state: 'pending' },
    ];
  }

  switch (authAttempt.status) {
    case 'starting':
      return [
        { label: openStep, state: 'active' },
        { label: browserStep, state: 'pending' },
        { label: returnStep, state: 'pending' },
        { label: saveStep, state: 'pending' },
      ];
    case 'waiting_browser':
    case 'waiting_device':
    case 'waiting':
      return [
        { label: openStep, state: 'done' },
        { label: browserStep, state: 'active' },
        {
          label: returnStep,
          state: authAttempt.canPasteCallback || authAttempt.userCode ? 'active' : 'pending',
        },
        { label: saveStep, state: 'pending' },
      ];
    case 'exchanging':
      return [
        { label: openStep, state: 'done' },
        { label: browserStep, state: 'done' },
        { label: returnStep, state: 'done' },
        { label: saveStep, state: 'active' },
      ];
    case 'succeeded':
      return [
        { label: openStep, state: 'done' },
        { label: browserStep, state: 'done' },
        { label: returnStep, state: 'done' },
        { label: saveStep, state: 'done' },
      ];
    default:
      return [
        { label: openStep, state: 'done' },
        { label: browserStep, state: 'active' },
        { label: returnStep, state: 'pending' },
        { label: saveStep, state: 'pending' },
      ];
  }
}

async function copyText(value: string, onDone: (message: string | null) => void) {
  try {
    await navigator.clipboard.writeText(value);
    onDone('Copied');
    window.setTimeout(() => onDone(null), 1200);
  } catch {
    onDone('Copy failed');
    window.setTimeout(() => onDone(null), 1200);
  }
}

export default function AuthPopup({
  providerId: providerIdProp,
  mode: modeProp,
  authority,
  requireAuthority: requireAuthorityProp,
  embedded = false,
  authState: authStateProp = null,
  onRequestClose,
  onAuthUpdated,
  onEnterChat,
}: AuthPopupProps = {}) {
  const search = useMemo(() => new URLSearchParams(window.location.search), []);
  const providerId = providerIdProp ?? search.get('provider') ?? '';
  const mode = (modeProp ?? (search.get('mode') === 'api-key' ? 'api-key' : 'oauth')) as 'oauth' | 'api-key';
  const authorityFromQuery = authority ?? search.get('authority') ?? '';
  const requireAuthority = requireAuthorityProp ?? search.get('requireAuthority') === '1';

  const [authState, setAuthState] = useState<DesktopAuthState | null>(authStateProp);
  const [authAttempt, setAuthAttempt] = useState<DesktopAuthAttemptSnapshot | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [manualCallbackDraft, setManualCallbackDraft] = useState('');
  const [authorityDraft, setAuthorityDraft] = useState(authorityFromQuery);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setAuthState(authStateProp);
  }, [authStateProp]);

  useEffect(() => {
    let cancelled = false;
    fetchDesktopAuthState()
      .then((state) => {
        if (cancelled) return;
        setAuthState(state);
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : 'Unable to load auth state');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [providerId]);

  useEffect(() => {
    if (!authAttempt || authAttempt.completed) return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const next = await fetchDesktopAuthAttemptState(authAttempt.id);
        if (cancelled) return;
        setAuthAttempt(next);
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : 'Unable to refresh auth flow');
      }
    }, 900);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authAttempt?.id, authAttempt?.completed]);

  useEffect(() => {
    if (!authAttempt?.completed || !authAttempt.succeeded) return;

    if (!embedded) {
      notifyAuthUpdated();
    }
    onAuthUpdated?.();

    if (embedded) {
      return;
    }

    const timer = window.setTimeout(() => {
      void closePopupWindow(embedded, onRequestClose);
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [authAttempt?.completed, authAttempt?.succeeded, embedded, onAuthUpdated, onRequestClose]);
  const provider = useMemo<DesktopAuthProvider | null>(
    () => authState?.providers.find((item) => item.id === providerId) ?? null,
    [authState, providerId],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [authAttempt?.id, authAttempt?.completed, embedded, onRequestClose]);
  useEffect(() => {
    if (!provider) return;
    if (provider.id !== 'github-copilot') return;
    if (authorityDraft.trim()) return;

    setAuthorityDraft(provider.authority || 'github.com');
  }, [provider?.id, provider?.authority, authorityDraft]);

  const steps = useMemo(() => buildPopupSteps(authAttempt), [authAttempt]);
  const visibleError = error ?? authAttempt?.error ?? null;
  const showInteractiveOAuthDetails = !!authAttempt && !authAttempt.completed;
  const canSaveAndEnterChat = !!onEnterChat && mode === 'api-key' && !!provider && !isLocalAuthProvider(provider.id);

  const handleEnterChat = async () => {
    if (!onEnterChat) return;

    try {
      setIsSubmitting(true);
      await Promise.resolve(onEnterChat());
      await closePopupWindow(embedded, onRequestClose);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to enter chat');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveApiKey = async (enterChat = false) => {
    if (!provider || !apiKeyDraft.trim()) return;

    try {
      setIsSubmitting(true);
      const nextState = await saveDesktopApiKey(provider.id, apiKeyDraft.trim());
      setAuthState(nextState);
      if (!embedded) {
        notifyAuthUpdated();
      }
      await Promise.resolve(onAuthUpdated?.());
      if (enterChat && onEnterChat) {
        await Promise.resolve(onEnterChat());
      }
      await closePopupWindow(embedded, onRequestClose);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save API key');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartOAuth = async () => {
    if (!provider) return;

    try {
      setIsSubmitting(true);

      const next = await startDesktopOAuthLogin(
        provider.id,
        provider.id === 'github-copilot' ? authorityDraft.trim() || 'github.com' : undefined,
      );
      setAuthAttempt(next);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to start OAuth login');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitManual = async () => {
    if (!authAttempt || !manualCallbackDraft.trim()) return;

    try {
      setIsSubmitting(true);
      const next = await submitDesktopAuthManualInput(authAttempt.id, manualCallbackDraft.trim());
      setAuthAttempt(next);
      setManualCallbackDraft('');
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to submit callback');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = async () => {
    if (authAttempt && !authAttempt.completed) {
      try {
        setIsSubmitting(true);
        await cancelDesktopAuthAttempt(authAttempt.id);
      } catch {
      } finally {
        setIsSubmitting(false);
      }
    }
    await closePopupWindow(embedded, onRequestClose);
  };

  const shell = (
    <div className={embedded ? 'mx-auto w-full max-w-[440px]' : 'mx-auto flex h-full min-h-0 w-full max-w-[520px] items-start'}>
      <div className={embedded ? 'app-auth-popup-panel app-modal-panel overflow-hidden rounded-[24px] border border-white/10 shadow-[0_20px_60px_rgba(0,0,0,0.32)]' : 'app-auth-popup-panel app-modal-panel flex max-h-[calc(100dvh-4rem)] w-full flex-col overflow-hidden rounded-[28px] border border-white/10 shadow-[var(--app-shadow-float)]'}>
        {embedded ? (
          <div className="app-auth-popup-header border-b border-white/8 px-4 py-2.5 sm:px-4.5">
            <div className="flex items-start justify-between gap-3.5">
          <div>
            <div className="mb-2.5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium tracking-[-0.01em] text-slate-300">
              <Shield className="h-3.5 w-3.5" />
              {embedded ? 'Authentication' : 'Authentication window'}
            </div>
            <div className={embedded ? 'text-[20px] font-semibold tracking-[-0.025em] text-white' : 'text-[24px] font-semibold tracking-[-0.03em] text-white'}>
              {authPopupTitle(provider, providerId, mode)}
            </div>
            <div className={embedded ? 'mt-1.5 max-w-[42ch] text-[12px] leading-6 text-slate-400' : 'mt-1.5 max-w-[44ch] text-[12px] leading-6 text-slate-400'}>
              {authPopupDescription(providerId, mode)}
            </div>
          </div>
          <button type="button" onClick={() => void handleClose()} className="app-icon-button rounded-full p-2 text-slate-300 transition hover:text-white">
            <X className="h-4 w-4" />
          </button>
            </div>
          </div>
        ) : null}

        <div className={embedded ? 'max-h-[min(72vh,640px)] overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-3.5 sm:px-4.5' : 'max-h-[calc(100dvh-4rem)] overflow-y-auto overflow-x-hidden overscroll-contain p-4.5'}>
        {!embedded && (
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2.5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium tracking-[-0.01em] text-slate-300">
                <Shield className="h-3.5 w-3.5" />
                {embedded ? 'Authentication' : 'Authentication window'}
              </div>
              <div className={embedded ? 'text-[20px] font-semibold tracking-[-0.025em] text-white' : 'text-[24px] font-semibold tracking-[-0.03em] text-white'}>
                {authPopupTitle(provider, providerId, mode)}
              </div>
              <div className={embedded ? 'mt-1.5 max-w-[42ch] text-[12px] leading-6 text-slate-400' : 'mt-1.5 max-w-[44ch] text-[12px] leading-6 text-slate-400'}>
                {authPopupDescription(providerId, mode)}
              </div>
            </div>
            <button type="button" onClick={() => void handleClose()} className="app-icon-button rounded-full p-2 text-slate-300 transition hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="app-surface-muted flex items-center gap-3 rounded-[24px] px-4 py-4 text-sm text-slate-300">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading auth state…
          </div>
        ) : !provider ? (
          <div className="rounded-[24px] border border-rose-400/30 bg-rose-500/10 px-4 py-4 text-sm text-rose-100">
            Unknown provider.
          </div>
        ) : (
          <div className="space-y-3.5">
            {authAttempt?.succeeded && (
              <div className="rounded-[20px] border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-2.5 text-[13px] leading-5 text-emerald-100">
                Authentication successful. This account is now saved in Kordi and ready to use.
              </div>
            )}

            {visibleError && (
              <div className="rounded-[20px] border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-[13px] leading-5 text-rose-100">
                {visibleError}
              </div>
            )}

            {mode === 'api-key' ? (
              <>
                <div className="rounded-[20px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-3.5 py-3 text-[12px] leading-5 text-slate-400">
                  {providerId === 'anthropic'
                    ? 'Existing Anthropic keys stay available in Settings. Use this panel when you want to add another billed API key.'
                    : 'Saved keys stay available in Settings. Use this panel when you want to add another key without leaving the current flow.'}
                </div>
                <div className="app-input-shell rounded-[20px] px-3.5 py-3">
                  <div className="mb-1.5 text-[11px] font-medium tracking-[-0.01em] text-slate-500">{provider.envVar || 'API key'}</div>
                  <input
                    type="password"
                    value={apiKeyDraft}
                    onChange={(event) => setApiKeyDraft(event.target.value)}
                    placeholder={`Paste your ${provider.label} key`}
                    className="w-full bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-500"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" className="app-control-chip rounded-xl border-0" onClick={() => void handleClose()}>
                    Cancel
                  </Button>
                  <Button type="button" className="rounded-xl" disabled={isSubmitting || !apiKeyDraft.trim()} onClick={() => void handleSaveApiKey()}>
                    {isSubmitting && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
                    {authPopupPrimaryActionLabel(providerId, mode)}
                  </Button>
                  {canSaveAndEnterChat ? (
                    <Button type="button" className="rounded-xl" disabled={isSubmitting || !apiKeyDraft.trim()} onClick={() => void handleSaveApiKey(true)}>
                      {isSubmitting && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
                      Save &amp; enter chat
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <AuthFlowSteps steps={steps} />

                {provider.id === 'github-copilot' && (requireAuthority || provider.authority) && (
                  <div className="rounded-[24px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-4 py-4">
                    <div className="mb-1.5 text-[11px] font-medium tracking-[-0.01em] text-slate-500">GitHub host</div>
                    <input
                      value={authorityDraft}
                      onChange={(event) => setAuthorityDraft(event.target.value)}
                      placeholder="github.com or github.example.com"
                      className="w-full bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-500"
                    />
                    <div className="mt-2 text-[12px] leading-5 text-slate-400">
                      Use github.com or the GitHub Enterprise domain your team signs in through.
                    </div>
                  </div>
                )}

                <div className="app-auth-popup-info-card rounded-[20px] border border-white/8 bg-[linear-gradient(155deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] px-3.5 py-3">
                  <div className="text-[13px] font-medium text-white">
                    {authAttempt?.message ?? (providerId === 'anthropic'
                      ? 'Open Claude sign-in and Kordi will keep this panel updated while you finish the subscription login.'
                      : 'Open the provider sign-in page and Kordi will keep this panel updated while you authenticate.')}
                  </div>

                  {showInteractiveOAuthDetails && authAttempt?.authUrl && (
                    <div className="mt-2.5 rounded-[18px] bg-[color:var(--app-control-bg)] px-3 py-2.5">
                      <div className="mb-1 text-[11px] font-medium tracking-[-0.01em] text-slate-500">Sign-in URL</div>
                      <div className="break-all text-[11px] leading-5 text-slate-300">{authAttempt.authUrl}</div>
                      <div className="mt-3 flex justify-end">
                        <Button type="button" variant="secondary" className="app-control-chip rounded-xl border-0" onClick={() => void copyText(authAttempt.authUrl!, setCopyFeedback)}>
                          <Copy className="mr-2 h-3.5 w-3.5" />
                          Copy URL
                        </Button>
                      </div>
                    </div>
                  )}

                  {showInteractiveOAuthDetails && authAttempt?.userCode && (
                    <div className="mt-2.5 rounded-[18px] bg-[color:var(--app-control-bg)] px-3 py-2.5">
                      <div className="text-[11px] font-medium tracking-[-0.01em] text-slate-500">Device code</div>
                      <div className="mt-1 text-[17px] font-semibold tracking-[0.04em] text-white">{authAttempt.userCode}</div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        {authAttempt.verificationUrl ? (
                          <a href={authAttempt.verificationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-slate-300 transition hover:text-white">
                            Open page
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : <span />}
                        <Button type="button" variant="secondary" className="app-control-chip rounded-xl border-0" onClick={() => void copyText(authAttempt.userCode!, setCopyFeedback)}>
                          <Copy className="mr-2 h-3.5 w-3.5" />
                          Copy code
                        </Button>
                      </div>
                    </div>
                  )}

                  {showInteractiveOAuthDetails && authAttempt?.canPasteCallback && (
                    <div className="mt-4">
                      <div className="mb-1.5 text-[11px] font-medium tracking-[-0.01em] text-slate-500">Paste a callback manually</div>
                      <div className="app-input-shell rounded-[20px] px-3 py-3">
                        <textarea
                          value={manualCallbackDraft}
                          onChange={(event) => setManualCallbackDraft(event.target.value)}
                          placeholder="Paste the redirect URL or authorization code if the browser does not return to Kordi automatically."
                          className="min-h-[112px] w-full resize-none bg-transparent text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500"
                        />
                      </div>
                    </div>
                  )}

                  {showInteractiveOAuthDetails && copyFeedback && <div className="mt-3 text-[12px] text-slate-400">{copyFeedback}</div>}
                </div>

                {!authAttempt?.succeeded && (
                  <div className="app-auth-popup-note rounded-[20px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-3.5 py-2.5 text-[11px] leading-5 text-slate-400">
                    This uses the same shared sign-in flow as the terminal app, including a manual callback fallback if the browser does not return automatically.
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  {!authAttempt && (
                    <Button type="button" className="rounded-xl" disabled={isSubmitting || (provider.id === 'github-copilot' && requireAuthority && !authorityDraft.trim())} onClick={() => void handleStartOAuth()}>
                      {isSubmitting && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
                      <LogIn className="mr-2 h-4 w-4" />
                      {authPopupPrimaryActionLabel(providerId, mode)}
                    </Button>
                  )}

                  {showInteractiveOAuthDetails && authAttempt?.canPasteCallback && (
                    <Button type="button" variant="secondary" className="app-control-chip rounded-xl border-0" disabled={isSubmitting || !manualCallbackDraft.trim()} onClick={() => void handleSubmitManual()}>
                      Save pasted callback
                    </Button>
                  )}

                  {authAttempt?.succeeded && onEnterChat ? (
                    <Button type="button" className="rounded-xl" disabled={isSubmitting} onClick={() => void handleEnterChat()}>
                      {isSubmitting && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
                      Enter chat
                    </Button>
                  ) : null}

                  {!embedded && (
                    <Button type="button" variant="secondary" className="app-control-chip rounded-xl border-0" onClick={() => void handleClose()}>
                      {authAttempt?.succeeded ? 'Done' : authAttempt?.completed ? 'Close flow' : authAttempt ? 'Cancel' : 'Close'}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        </div>
        {embedded && (
          <div className="app-auth-popup-footer flex items-center justify-between gap-3 border-t border-white/8 px-4 py-2.5 sm:px-4.5">
            <div className="text-[11px] text-slate-500">Esc to close</div>
            <Button type="button" variant="secondary" className="app-control-chip rounded-xl border-0" onClick={() => void handleClose()}>
              {authAttempt?.succeeded ? 'Done' : authAttempt?.completed ? 'Close' : authAttempt ? 'Cancel' : 'Close'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div
        className="absolute inset-0 z-[120] flex items-start justify-center bg-[color:var(--app-overlay-bg)] px-4 py-8 sm:items-center"
        style={{ WebkitAppRegion: 'no-drag' as const }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            void handleClose();
          }
        }}
      >
        {shell}
      </div>
    );
  }

  return (
    <div className="bridge-app theme-dark flex h-[100dvh] w-full overflow-hidden bg-[radial-gradient(circle_at_top,rgba(58,56,46,0.28),rgba(17,17,15,0.96)_45%,rgba(10,10,11,1))] px-6 py-8 text-white">
      {shell}
    </div>
  );
}
