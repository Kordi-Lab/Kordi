import { useEffect, useState } from 'react';

import { openDesktopExternalUrl, setDesktopLocalProviderPort } from '@/lib/desktop';
import type { DesktopAuthProvider } from '@/kordi-app/types';
import type { AuthDisplayProvider } from './model';
import {
  AuthActionButton,
  DetailRow,
  SectionDivider,
  authButtonNeutralClass,
  nonDragStyle,
} from './AuthDetailPrimitives';
import { LmStudioModelControlCenter } from './LmStudioModelControlCenter';
import { OllamaModelControlCenter } from './OllamaModelControlCenter';

type LocalProviderSetupProps = {
  provider: AuthDisplayProvider;
  rawProviders: DesktopAuthProvider[];
  onOpenLogin: (provider: DesktopAuthProvider, mode: 'oauth' | 'api-key') => void;
  onRefreshAuth: () => void | Promise<void>;
  onDismissGate?: () => void;
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
};

function findRawProvider(rawProviders: DesktopAuthProvider[], providerId: string) {
  return rawProviders.find((item) => item.id === providerId) ?? null;
}

function localSignInMethodButtonLabel(providerId: string, hasOptions: boolean) {
  if (providerId === 'lm-studio' || providerId === 'ollama') {
    return hasOptions ? 'Add another optional key' : 'Save optional key';
  }
  return hasOptions ? 'Add another key' : 'Add key';
}

function localProviderPort(providerId: string, baseUrl: string) {
  const defaultPort = providerId === 'ollama' ? '11434' : '1234';

  try {
    return new URL(baseUrl).port || defaultPort;
  } catch {
    return defaultPort;
  }
}

function localProviderServerInstructions(providerId: string, label: string, baseUrl: string) {
  const port = localProviderPort(providerId, baseUrl);

  if (providerId === 'lm-studio') {
    return {
      title: 'Start LM Studio’s local server',
      detail: 'Open the LM Studio app on macOS, load a model, then start the Local Server. Kordi discovers models from this OpenAI-compatible endpoint.',
      optionalKey: 'Only save a key here if you enabled API-key protection in LM Studio.',
      port,
      installTitle: 'Install LM Studio',
      installDetail: 'Install LM Studio from the official installer, then start its local server from the app. The terminal helper below is available as an advanced fallback.',
      installCommand: 'curl -fsSL https://lmstudio.ai/install.sh | bash',
      installUrl: 'https://lmstudio.ai/download',
      docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
      docsLabel: 'Open API docs',
    };
  }

  if (providerId === 'ollama') {
    return {
      title: 'Start Ollama locally',
      detail: 'Install Ollama, pull a model, then keep the Ollama service running. Kordi uses Ollama’s OpenAI-compatible endpoint and discovers installed models from /v1/models.',
      optionalKey: 'The default Ollama local server does not require an API key. Save one only if your server is protected.',
      port,
      installTitle: 'Install Ollama',
      installDetail: 'Install Ollama from the official download page, then run a model locally before selecting it in Kordi.',
      installCommand: null,
      installUrl: 'https://ollama.com/download',
      docsUrl: 'https://docs.ollama.com/openai',
      docsLabel: 'Open docs',
    };
  }

  return {
    title: `Start ${label}`,
    detail: 'Start the local OpenAI-compatible server before chatting. Kordi will discover models from /v1/models.',
    optionalKey: 'Save a key only if this local server requires one.',
    port,
    installTitle: `Install ${label}`,
    installDetail: 'Install and start this local OpenAI-compatible server before chatting.',
    installCommand: null,
    installUrl: baseUrl,
    docsUrl: baseUrl,
    docsLabel: 'Open docs',
  };
}

function openLocalProviderHelp(url: string) {
  void openDesktopExternalUrl(url).catch((error) => {
    console.error('Unable to open local provider help URL', error);
  });
}

export function LocalProviderSetup({
  provider,
  rawProviders,
  onOpenLogin,
  onRefreshAuth,
  onDismissGate,
  onEnterChat,
}: LocalProviderSetupProps) {
  const baseUrl = provider.localBaseUrl;
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [localPortDraft, setLocalPortDraft] = useState('');
  const [isSavingLocalPort, setIsSavingLocalPort] = useState(false);
  const [localPortError, setLocalPortError] = useState<string | null>(null);

  useEffect(() => {
    if (!baseUrl) return;
    setLocalPortDraft(localProviderPort(provider.id, baseUrl));
    setLocalPortError(null);
  }, [provider.id, baseUrl]);

  if (!baseUrl) return null;

  const localServer = localProviderServerInstructions(provider.id, provider.label, baseUrl);
  const method = provider.methods.find((item) => item.mode === 'api-key') ?? provider.methods[0];
  const raw = method ? findRawProvider(rawProviders, method.providerId) : null;

  const saveLocalProviderPort = async () => {
    const parsedPort = Number(localPortDraft);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setLocalPortError('Enter a port between 1 and 65535.');
      return;
    }

    try {
      setIsSavingLocalPort(true);
      setLocalPortError(null);
      await setDesktopLocalProviderPort(provider.id, parsedPort);
      await Promise.resolve(onRefreshAuth());
    } catch (error) {
      setLocalPortError(error instanceof Error ? error.message : 'Unable to save local provider port.');
    } finally {
      setIsSavingLocalPort(false);
    }
  };

  const copyInstallCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedInstallCommand(true);
      window.setTimeout(() => setCopiedInstallCommand(false), 1800);
    } catch (error) {
      console.error('Unable to copy local provider install command', error);
    }
  };

  if (provider.id === 'lm-studio') {
    return (
      <LmStudioModelControlCenter
        endpoint={baseUrl}
        port={localServer.port}
        onRefreshAuth={onRefreshAuth}
        onSaved={onDismissGate}
        onEnterChat={onEnterChat}
      />
    );
  }

  if (provider.id === 'ollama') {
    return (
      <OllamaModelControlCenter
        endpoint={baseUrl}
        port={localServer.port}
        onRefreshAuth={onRefreshAuth}
        onSaved={onDismissGate}
        onEnterChat={onEnterChat}
      />
    );
  }

  return (
    <>
      <DetailRow
        title={localServer.title}
        detail={localServer.detail}
        multiline
      />
      <SectionDivider />
      <DetailRow
        title={localServer.installTitle}
        detail={
          <div className="space-y-2">
            <div>{localServer.installDetail}</div>
            {localServer.installCommand ? (
              <div className="rounded-[14px] border border-white/8 bg-black/15 px-3 py-2 font-mono text-[11px] text-slate-200">
                {localServer.installCommand}
              </div>
            ) : null}
          </div>
        }
        trailing={
          <>
            <AuthActionButton
              type="button"
              className={provider.id === 'lm-studio' ? 'border border-emerald-300/24 bg-[linear-gradient(180deg,rgba(52,211,153,0.18),rgba(20,184,166,0.11))] text-emerald-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(0,0,0,0.16)] hover:border-emerald-200/32 hover:bg-[linear-gradient(180deg,rgba(52,211,153,0.24),rgba(20,184,166,0.15))]' : authButtonNeutralClass}
              onClick={() => openLocalProviderHelp(localServer.installUrl)}
            >
              {provider.id === 'lm-studio' ? 'Download page' : 'Open install help'}
            </AuthActionButton>
            {localServer.installCommand ? (
              <AuthActionButton
                type="button"
                className={authButtonNeutralClass}
                onClick={() => copyInstallCommand(localServer.installCommand!)}
              >
                {copiedInstallCommand ? 'Copied' : 'Copy command'}
              </AuthActionButton>
            ) : null}
            <AuthActionButton
              type="button"
              className={authButtonNeutralClass}
              onClick={() => openLocalProviderHelp(localServer.docsUrl)}
            >
              {localServer.docsLabel}
            </AuthActionButton>
          </>
        }
        multiline
      />
      <SectionDivider />
      <DetailRow
        title="Server port"
        detail={
          <div className="space-y-1">
            <div>Kordi will connect to this local provider at <span className="font-mono text-slate-300">http://localhost:{localPortDraft || localServer.port}/v1</span>.</div>
            {localPortError ? <div className="app-error-text text-rose-200">{localPortError}</div> : null}
          </div>
        }
        trailing={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input
              value={localPortDraft}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label={`${provider.label} local server port`}
              onChange={(event) => setLocalPortDraft(event.target.value.replace(/\D/g, '').slice(0, 5))}
              className="app-input-shell h-8.5 w-24 rounded-full px-3 text-right text-[12px] text-white outline-none"
              style={nonDragStyle}
            />
            <AuthActionButton
              type="button"
              className={authButtonNeutralClass}
              onClick={saveLocalProviderPort}
              disabled={isSavingLocalPort || localPortDraft === localServer.port}
            >
              {isSavingLocalPort ? 'Saving…' : 'Save port'}
            </AuthActionButton>
          </div>
        }
        multiline
      />
      <SectionDivider />
      <DetailRow
        title="Optional API key"
        detail={localServer.optionalKey}
        trailing={
          raw && method ? (
            <AuthActionButton
              type="button"
              className={authButtonNeutralClass}
              onClick={() => onOpenLogin(raw, method.mode)}
            >
              {localSignInMethodButtonLabel(provider.id, method.options.length > 0)}
            </AuthActionButton>
          ) : null
        }
        multiline
      />
    </>
  );
}

export function localProviderEndpoint(provider: AuthDisplayProvider) {
  return provider.localBaseUrl ?? null;
}
