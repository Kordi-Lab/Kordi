import { useLayoutEffect, useState } from 'react';
import { Bell, KeyRound, Laptop, Palette, User } from 'lucide-react';
import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';
import type { CloudProviderAuthSnapshot, CloudProviderAuthSnapshotInput } from '@/features/cloud/cloudAgentRuntimeTypes';
import { AuthPage, type AuthPageCloudSources } from '@/kordi-app/auth/AuthPage';
import { loadPinnedOmpCatalog } from '@/kordi-app/auth/ompCatalog';
import { SettingsNav } from '@/kordi-app/components/settingsLayout';
import type { DesktopAuthProvider, DesktopAuthState, ResolvedThemeMode } from '@/kordi-app/types';
import { createPreviewProviderLogin } from './previewProviderLogin';
import { PreviewSessionRoute } from './PreviewSessionRoute';

const previewParams = () => new URLSearchParams(window.location.search);

type PreviewVariant = 'start' | 'settings' | 'login';

const previewRouteTestDelayMs = 900;
const gateClosedNotice = 'The start gate closed.';

const previewNavGroups = [
  { label: 'Account', items: [{ id: 'profile', label: 'Profile', icon: User }, { id: 'devices', label: 'Active sessions', icon: Laptop }] },
  {
    label: 'Settings',
    items: [
      { id: 'auth', label: 'Authentication', icon: KeyRound },
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'appearance', label: 'Appearance', icon: Palette },
    ],
  },
];

// The bundled OMP catalog supplies every provider and an offline sign-in
// simulator stands in for the hosted API, so the preview never contacts a
// Kordi backend or a provider.
type PreviewCloudSources = AuthPageCloudSources & {
  labelFor: (authChoice: string) => string | null;
  /** Publishes a Custom API account; the same choice replaces the earlier copy, as on the server. */
  saveSnapshot: (input: CloudProviderAuthSnapshotInput) => void;
};

function createPreviewCloudSources(onNotice: (notice: string) => void): PreviewCloudSources {
  let saved = 0;
  // ?needsReconnect=1: the hosted copy of the Personal ChatGPT sign-in expired.
  // ?legacyCustom=1: a Custom API account saved before accounts carried a model.
  let snapshots: CloudProviderAuthSnapshot[] = [
    ...(previewParams().get('needsReconnect') === '1'
      ? [{ snapshotId: 'snap_preview_personal', provider: 'openai-codex', authChoice: 'profile:preview-personal', label: 'Personal', createdAt: '2026-01-01T00:00:00Z', revokedAt: null, status: 'needs-reconnect' }]
      : []),
    ...(previewParams().get('legacyCustom') === '1'
      ? [{ snapshotId: 'snap_preview_legacy', provider: 'custom', authChoice: 'cloud-api-key:preview-legacy', label: 'Gateway', modelHint: null, createdAt: '2026-01-01T00:00:00Z', revokedAt: null }]
      : []),
    // ?hostedAccounts=1: accounts stored only in the Kordi account, which run on Kordi Cloud.
    ...(previewParams().get('hostedAccounts') === '1' ? previewHostedSnapshots : []),
  ];
  const login = createPreviewProviderLogin(async () => (await loadPinnedOmpCatalog()).providers, {
    // ?captureBusy=1: another sign-in holds the provider's localhost port.
    captureBusy: previewParams().get('captureBusy') === '1',
    onSnapshot: (snapshot) => {
      snapshots = [...snapshots, { ...snapshot, modelHint: null, createdAt: new Date().toISOString(), revokedAt: null }];
      onNotice(`OMP saved ${snapshot.label}.`);
    },
  });
  return {
    loadCatalog: null,
    loadSnapshots: () => Promise.resolve(snapshots),
    login: login.client,
    callbackCapture: login.capture,
    revokeSnapshot: (snapshotId) => {
      snapshots = snapshots.filter((snapshot) => snapshot.snapshotId !== snapshotId);
      return Promise.resolve();
    },
    openExternal: (url) => {
      login.openedUrl(url);
      onNotice(`The sign-in page would open: ${url}`);
    },
    labelFor: (authChoice) => snapshots.find((snapshot) => snapshot.authChoice === authChoice)?.label ?? null,
    saveSnapshot: (input) => {
      saved += 1;
      const payload = (input.payload ?? {}) as { model?: unknown };
      snapshots = [...snapshots.filter((snapshot) => snapshot.authChoice !== input.authChoice), {
        snapshotId: `snap_preview_custom_${saved}`, provider: input.provider, authChoice: input.authChoice,
        label: input.label || 'Work', modelHint: typeof payload.model === 'string' ? payload.model : null,
        createdAt: new Date().toISOString(), revokedAt: null,
      }];
    },
  };
}

const previewHostedSnapshots: CloudProviderAuthSnapshot[] = [
  { snapshotId: 'snap_preview_team', provider: 'openai-codex', authChoice: 'cloud-login:preview-team', label: 'Team', modelHint: 'gpt-5.5', createdAt: '2026-01-01T00:00:00Z', revokedAt: null },
  { snapshotId: 'snap_preview_research', provider: 'cerebras', authChoice: 'cloud-api-key:preview-research', label: 'Research', modelHint: null, createdAt: '2026-01-01T00:00:00Z', revokedAt: null },
  { snapshotId: 'snap_preview_gateway', provider: 'custom', authChoice: 'cloud-api-key:preview-gateway', label: 'Gateway', modelHint: 'deepseek-chat', createdAt: '2026-01-01T00:00:00Z', revokedAt: null },
  { snapshotId: 'snap_preview_old', provider: 'openai-codex', authChoice: 'cloud-login:preview-old', label: 'Old laptop', modelHint: null, createdAt: '2026-01-01T00:00:00Z', revokedAt: null, status: 'needs-reconnect' },
];

function previewTheme(): ResolvedThemeMode {
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return resolveThemeMode(readStoredThemeMode(), systemTheme);
}

const previewProviders: DesktopAuthProvider[] = [
  {
    id: 'openai-codex', label: 'ChatGPT', statusSummary: '2 accounts connected',
    loginHint: 'Use a ChatGPT account for Codex models.', envVar: '', helpUrl: '',
    supportsOAuth: true, supportsApiKey: false, configured: true,
    options: [
      { value: 'profile:preview-work', profileId: 'preview-work', method: 'OAuth', source: 'preview', label: 'Work', active: true },
      { value: 'profile:preview-personal', profileId: 'preview-personal', method: 'OAuth', source: 'preview', label: 'Personal', active: false },
    ],
  },
  {
    id: 'openai', label: 'OpenAI API', statusSummary: 'No API keys',
    loginHint: 'Use an API key for billed access.', envVar: 'OPENAI_API_KEY', helpUrl: '',
    supportsOAuth: false, supportsApiKey: true, configured: false, options: [],
  },
  {
    id: 'anthropic', label: 'Anthropic', statusSummary: 'Not connected',
    loginHint: 'Connect Claude with an account or API key.', envVar: 'ANTHROPIC_API_KEY', helpUrl: '',
    supportsOAuth: true, supportsApiKey: true, configured: false, options: [],
  },
  {
    id: 'google', label: 'Google', statusSummary: 'Not connected',
    loginHint: 'Add a Gemini API key.', envVar: 'GEMINI_API_KEY', helpUrl: '',
    supportsOAuth: false, supportsApiKey: true, configured: false, options: [],
  },
];

function withAuthCount(providers: DesktopAuthProvider[]): DesktopAuthState {
  return { authPath: '', hasAnyAuth: providers.some((provider) => provider.options.length > 0), providers };
}

type AuthPreviewProps = {
  variant: PreviewVariant;
  /** Provider detail to open first; defaults to the `provider` query parameter. */
  initialProviderId?: string | null;
};

export function AuthPreview({
  variant,
  initialProviderId = new URLSearchParams(window.location.search).get('provider'),
}: AuthPreviewProps) {
  const [authState, setAuthState] = useState<DesktopAuthState>(() => withAuthCount(previewProviders));
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(initialProviderId ?? 'openai');
  const [notice, setNotice] = useState('');
  const [theme] = useState(previewTheme);
  const [cloudSources] = useState(() => createPreviewCloudSources(setNotice));
  const layout = variant === 'start' ? 'start' : 'settings';

  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const changeProviders = (update: (providers: DesktopAuthProvider[]) => DesktopAuthProvider[]) => {
    setAuthState((current) => withAuthCount(update(current.providers)));
  };

  return (
    <div
      className={`kordi-app theme-${theme} min-h-screen`}
      style={theme === 'dark'
        ? { background: '#101824', color: 'rgb(255 255 255)' }
        : { background: 'var(--app-main-bg)', color: 'rgb(15 23 42)' }}
    >
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between border-b border-white/10 px-6 py-3 text-sm">
          <span className="font-semibold">Kordi · Authentication UI preview</span>
          <nav className="flex gap-4" aria-label="Preview pages">
            <a className={layout === 'start' ? 'text-white' : 'text-slate-400'} href="?authPreview=start">Start page</a>
            <a className={layout === 'settings' ? 'text-white' : 'text-slate-400'} href="?authPreview=settings">Settings page</a>
          </nav>
        </header>
        <div className="border-b border-[color:var(--app-divider)] px-6 py-2 text-xs text-slate-400" aria-live="polite">
          Visual preview with synthetic accounts. Account actions stay in this window and do not sign in or run a model.
          {notice ? ` ${notice}` : ''}
        </div>
        <div className={layout === 'start' ? 'min-h-[780px] flex-1' : 'mx-auto flex min-h-[780px] w-full max-w-[1280px] flex-1 gap-10 px-8 py-8'}>
          {layout === 'settings' ? (
            <aside className="w-56 shrink-0 py-2">
              <SettingsNav groups={previewNavGroups} activeId="auth" onSelect={(id) => { if (id !== 'auth') setNotice('Only Authentication is part of this preview.'); }} />
            </aside>
          ) : null}
          <main className={layout === 'settings' ? 'min-w-0 flex-1 px-2 py-2' : 'h-[780px]'}>
            <AuthPage
              variant={layout === 'start' ? 'gate' : 'settings'}
              layoutWidth={860}
              settingsLayoutMode="fluid"
              cloudSources={cloudSources}
              initialDetailProviderId={initialProviderId}
              initialLoginProviderId={variant === 'login' ? initialProviderId : null}
              initialLoginMethod={variant === 'login' ? new URLSearchParams(window.location.search).get('method') : null}
              isNativeShell
              authState={authState}
              isLoading={false}
              error={null}
              selectedProviderId={selectedProviderId}
              onSelectProvider={setSelectedProviderId}
              onOpenLogin={(provider, mode) => {
                const profileId = `preview-${Date.now()}`;
                changeProviders((providers) => {
                  const existing = providers.find((item) => item.id === provider.id) ?? { ...provider, options: [] };
                  const next = {
                    ...existing, configured: true,
                    options: [...existing.options, {
                      value: `profile:${profileId}`, profileId,
                      method: mode === 'oauth' ? 'OAuth' : 'API key', source: 'preview',
                      label: `${mode === 'oauth' ? 'Sign-in account' : 'API key'} ${existing.options.length + 1}`, active: false,
                    }],
                  };
                  return providers.some((item) => item.id === provider.id)
                    ? providers.map((item) => item.id === provider.id ? next : item)
                    : [...providers, next];
                });
                setNotice('A synthetic account was added.');
              }}
              onRefresh={() => setNotice('Synthetic accounts are up to date.')}
              onSelectAuthChoice={(providerId, choice) => {
                changeProviders((providers) => providers.map((provider) => provider.id === providerId ? {
                  ...provider, options: provider.options.map((option) => ({ ...option, active: option.value === choice })),
                } : provider));
                setNotice('The active synthetic account changed.');
              }}
              onRemoveAuthProfile={(providerId, profileId) => {
                changeProviders((providers) => providers.map((provider) => provider.id === providerId ? {
                  ...provider, options: provider.options.filter((option) => option.profileId !== profileId),
                } : provider));
                setNotice('The synthetic account was removed.');
              }}
              onLogoutProvider={(providerId) => {
                changeProviders((providers) => providers.map((provider) => provider.id === providerId ? {
                  ...provider, configured: false, options: [],
                } : provider));
                setNotice('Synthetic accounts for this provider were removed.');
              }}
              onDismissGate={() => setNotice(gateClosedNotice)}
              onEnterChat={(model, route) => setNotice((current) => [
                current === gateClosedNotice ? current : '',
                // A hosted-only account's chat carries its route and runs on Kordi Cloud.
                `Chat would start with ${model ?? 'the default model'}${route ? ` on Kordi Cloud (${route.authProvider} account)` : ''}.`,
              ].filter(Boolean).join(' '))}
              onTestRoute={(input) => new Promise((resolve) => {
                window.setTimeout(() => resolve({
                  runner: 'OMP', provider: input.provider,
                  accountLabel: authState.providers.flatMap((provider) => provider.options)
                    .find((option) => option.value === input.authChoice)?.label ?? cloudSources.labelFor(input.authChoice) ?? 'Preview account',
                  model: input.model,
                  response: 'Synthetic preview response. No model was called.',
                }), previewRouteTestDelayMs);
              })}
              onValidateCloudKey={() => Promise.resolve({ verified: false })}
              onSaveCloudKey={(input) => {
                cloudSources.saveSnapshot(input);
                setNotice('A synthetic account was saved in this tab.');
                return Promise.resolve();
              }}
            />
            {/* Below the page, like a composer, so its route menu opens upward with room. */}
            {previewParams().get('missingAccount') === '1' || previewParams().get('hostedAccounts') === '1' ? (
              <PreviewSessionRoute
                providers={authState.providers}
                initialAuthChoice={previewParams().get('missingAccount') === '1' ? 'profile:preview-removed' : 'profile:preview-work'}
                loadSnapshots={cloudSources.loadSnapshots}
              />
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}
