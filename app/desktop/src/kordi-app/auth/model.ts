import type { DesktopAuthOption, DesktopAuthProvider, DesktopAuthState } from '@/kordi-app/types';
import type { OmpLoginSpec } from '@/features/cloud/providerLogin';

/** The hosted OMP sign-in that adds an account for one display method. */
export type AuthHostedLogin = {
  providerId: string;
  mode?: 'device';
  method?: 'default' | 'api-key';
  login: OmpLoginSpec;
  /** Short name for buttons, for example "ChatGPT". */
  displayName: string;
};

export type AuthDisplayMethod = {
  mode: 'oauth' | 'api-key';
  title: string;
  detail: string;
  providerId: string;
  helpUrl: string;
  envVar: string;
  options: Array<DesktopAuthOption & { providerId: string }>;
  /** OMP catalog models for this method's provider. */
  modelIds?: string[];
  defaultModelId?: string | null;
  /** OMP provider name for this method's provider. */
  providerName?: string;
  /** Primary hosted sign-in; `hostedLogins` lists every hosted way to add this method's account. */
  hostedLogin?: AuthHostedLogin | null;
  hostedLogins?: AuthHostedLogin[];
};

export type AuthDisplayProvider = {
  id: string;
  label: string;
  configured: boolean;
  statusSummary: string;
  loginHint: string;
  authority?: string | null;
  localBaseUrl?: string;
  preferredModel?: string | null;
  methods: AuthDisplayMethod[];
  catalogOnly?: boolean;
  modelCount?: number;
  modelIds?: string[];
  defaultModelId?: string | null;
  ompAuth?: OmpProviderAuth;
};

export type OmpProviderAuth = {
  kind: 'api-key' | 'oauth-code' | 'device-code' | 'custom' | 'native';
  name: string;
  acceptsApiKey: boolean;
  instructions: string | null;
  authUrl: string | null;
  placeholder: string | null;
  envVars: string[];
};

function optionsFor(provider: DesktopAuthProvider | undefined, method: 'oauth' | 'api-key') {
  return (provider?.options ?? [])
    .filter((option) => option.method === (method === 'oauth' ? 'OAuth' : 'API key'))
    .map((option) => ({ ...option, providerId: provider?.id ?? '' }));
}

export function normalizeSelectedProviderId(id: string | null) {
  if (!id) return null;
  return id === 'openai-codex' || id === 'openai-codex-device' ? 'openai' : id;
}

export function localProviderBaseUrl(providerId: string) {
  if (providerId === 'lm-studio') return 'http://localhost:1234/v1';
  if (providerId === 'ollama') return 'http://localhost:11434/v1';
  return null;
}

export function isLocalProvider(providerId: string) {
  return localProviderBaseUrl(providerId) !== null;
}

/** Providers whose interactive sign-in runs through a Kordi adapter rather than OMP. */
export const kordiSignInProviderIds: ReadonlySet<string> = new Set(['openai-codex', 'anthropic', 'github-copilot']);

function localProviderHasSavedModel(providerId: string, preferredModel?: string | null) {
  return isLocalProvider(providerId) && !!preferredModel?.trim();
}

function displayProviderConfigured(provider: DesktopAuthProvider) {
  return provider.configured || localProviderHasSavedModel(provider.id, provider.preferredModel);
}

export function authStateSatisfiesStartupGate(authState: DesktopAuthState | null) {
  if (authState?.hasAnyAuth) return true;
  return buildAuthDisplayProviders(authState).some((provider) => provider.configured);
}

export function authStateHasChatReadyProvider(
  authState: DesktopAuthState | null,
  modelOptions: Array<{ provider?: string | null }> = [],
) {
  const modelProviderIds = new Set(
    modelOptions
      .map((option) => option.provider?.trim())
      .filter((provider): provider is string => Boolean(provider))
      .map((provider) => normalizeSelectedProviderId(provider) ?? provider),
  );

  if (buildAuthDisplayProviders(authState).some((provider) => {
    if (!provider.configured) return false;
    const providerId = normalizeSelectedProviderId(provider.id) ?? provider.id;
    return modelProviderIds.has(providerId)
      || localProviderHasSavedModel(providerId, provider.preferredModel);
  })) {
    return true;
  }

  return [...modelProviderIds].some((provider) => isLocalProvider(provider));
}

function localProviderFallback(providerId: 'lm-studio' | 'ollama'): DesktopAuthProvider {
  const label = providerId === 'lm-studio' ? 'LM Studio' : 'Ollama';
  const baseUrl = localProviderBaseUrl(providerId);

  return {
    id: providerId,
    label,
    statusSummary: 'Local server setup required',
    loginHint: providerId === 'lm-studio'
      ? 'Run against LM Studio’s local OpenAI-compatible server. No API key is required unless you enabled one in LM Studio.'
      : 'Run against Ollama’s local OpenAI-compatible server. The default local server does not need an API key.',
    envVar: providerId === 'lm-studio' ? 'LM_STUDIO_API_KEY' : 'OLLAMA_API_KEY',
    helpUrl: providerId === 'lm-studio' ? 'https://lmstudio.ai/docs/app/api/endpoints/openai' : 'https://docs.ollama.com/openai',
    supportsOAuth: false,
    supportsApiKey: true,
    configured: false,
    authority: null,
    baseUrl,
    preferredModel: null,
    options: [],
  };
}

export function buildAuthDisplayProviders(authState: DesktopAuthState | null): AuthDisplayProvider[] {
  if (!authState) return [];

  const byId = new Map(authState.providers.map((provider) => [provider.id, provider]));
  for (const providerId of ['lm-studio', 'ollama'] as const) {
    if (!byId.has(providerId)) byId.set(providerId, localProviderFallback(providerId));
  }
  const providers: AuthDisplayProvider[] = [];

  const anthropic = byId.get('anthropic');
  if (anthropic) {
    const anthropicMethods: AuthDisplayMethod[] = [
      {
        mode: 'oauth',
        title: 'Claude subscription',
        detail: 'Use the Claude account you already pay for when you want subscription-based access instead of API billing.',
        providerId: 'anthropic',
        helpUrl: 'https://claude.ai/',
        envVar: anthropic.envVar,
        options: optionsFor(anthropic, 'oauth'),
      },
      {
        mode: 'api-key',
        title: 'Anthropic API key',
        detail: `Use ${anthropic.envVar || 'ANTHROPIC_API_KEY'} for billed API usage, automations, and scripting.`,
        providerId: 'anthropic',
        helpUrl: anthropic.helpUrl,
        envVar: anthropic.envVar,
        options: optionsFor(anthropic, 'api-key'),
      },
    ];
    const supportedMethods = anthropicMethods.filter((method) => method.options.length > 0
      || (method.mode === 'oauth' ? anthropic.supportsOAuth : anthropic.supportsApiKey));
    const methods = supportedMethods.length > 0 ? supportedMethods : anthropicMethods.slice(0, 1);

    providers.push({
      id: 'anthropic',
      label: anthropic.label,
      configured: anthropic.options.length > 0,
      statusSummary: methods
        .map((method) => `${method.title}: ${method.options.length > 0 ? `${method.options.length} configured` : 'not configured'}`)
        .join(' • '),
      loginHint: 'Choose Claude subscription access for everyday chat, or an API key for billed automation and tooling.',
      authority: anthropic.authority,
      preferredModel: anthropic.preferredModel,
      methods,
    });
  }

  // One OpenAI row spans two OMP providers: ChatGPT sign-in is backed by
  // openai-codex and API keys by openai. Each method keeps its own provider id.
  const openAiOauth = byId.get('openai-codex');
  const openAiApi = byId.get('openai');
  if (openAiOauth || openAiApi) {
    const methods: AuthDisplayMethod[] = [];
    if (openAiOauth) {
      methods.push({
        mode: 'oauth',
        title: 'ChatGPT account',
        detail: 'Sign in with ChatGPT. Save multiple accounts and choose one for each agent session.',
        providerId: 'openai-codex',
        helpUrl: openAiOauth.helpUrl,
        envVar: openAiOauth.envVar,
        options: optionsFor(openAiOauth, 'oauth'),
      });
    }
    if (openAiApi) {
      methods.push({
        mode: 'api-key',
        title: 'OpenAI API key',
        detail: `Use ${openAiApi.envVar || 'OPENAI_API_KEY'} for billed API usage, automation, and separate project keys.`,
        providerId: 'openai',
        helpUrl: openAiApi.helpUrl,
        envVar: openAiApi.envVar,
        options: optionsFor(openAiApi, 'api-key'),
      });
    }
    providers.push({
      id: 'openai',
      label: 'OpenAI',
      configured: methods.some((method) => method.options.length > 0),
      statusSummary: methods
        .map((method) => `${method.title}: ${method.options.length > 0 ? `${method.options.length} configured` : 'not configured'}`)
        .join(' • '),
      loginHint:
        'Pick a ChatGPT account for subscription access, an API key for billed automation, or keep both and switch later.',
      preferredModel: openAiApi?.preferredModel ?? openAiOauth?.preferredModel,
      methods,
    });
  }

  // Kordi sign-in adapters other than Anthropic and OpenAI (GitHub Copilot) and the local model servers.
  const nativeMethodTitles: Record<string, string> = {
    'github-copilot': 'GitHub sign-in',
    'lm-studio': 'LM Studio local server',
    ollama: 'Ollama local server',
  };
  const nativeProviderIds = [...byId.values()]
    .filter((provider) => provider.id !== 'anthropic' && provider.id !== 'openai' && provider.id !== 'openai-codex')
    .filter((provider) => kordiSignInProviderIds.has(provider.id) || isLocalProvider(provider.id))
    .map((provider) => provider.id);
  for (const id of nativeProviderIds) {
    const provider = byId.get(id);
    if (!provider) continue;

    const mode = provider.supportsOAuth ? 'oauth' : 'api-key';

    providers.push({
      id,
      label: provider.label,
      configured: displayProviderConfigured(provider),
      statusSummary: provider.statusSummary,
      loginHint: provider.loginHint,
      authority: provider.authority,
      localBaseUrl: isLocalProvider(id) ? (provider.baseUrl || localProviderBaseUrl(id) || undefined) : undefined,
      preferredModel: provider.preferredModel,
      methods: [
        {
          mode,
          title: nativeMethodTitles[id] ?? `${provider.label} ${mode === 'oauth' ? 'sign-in' : 'API key'}`,
          detail:
            mode === 'oauth'
              ? 'Sign in with GitHub and keep multiple saved accounts if you need them.'
              : id === 'lm-studio'
                ? `Start LM Studio’s local server at ${provider.baseUrl || localProviderBaseUrl(id)}. API keys are optional and only needed if you enabled one.`
                : id === 'ollama'
                  ? `Start Ollama’s OpenAI-compatible server at ${provider.baseUrl || localProviderBaseUrl(id)}. The default local server does not need an API key.`
                  : `Use ${provider.envVar || 'API_KEY'} for direct API access, or save more than one key and switch later.`,
          providerId: provider.id,
          helpUrl: provider.helpUrl,
          envVar: provider.envVar,
          options: optionsFor(provider, mode),
        },
      ],
    });
  }

  const handled = new Set(['anthropic', 'openai', 'openai-codex', ...nativeProviderIds]);
  for (const provider of byId.values()) {
    if (handled.has(provider.id)) continue;
    providers.push({
      id: provider.id,
      label: provider.label,
      configured: provider.configured || provider.options.length > 0,
      statusSummary: provider.statusSummary,
      loginHint: provider.loginHint,
      preferredModel: provider.preferredModel,
      catalogOnly: true,
      methods: [{
        mode: 'api-key',
        title: provider.id === 'custom' ? 'Custom API' : `${provider.label} API key`,
        detail: provider.id === 'custom'
          ? 'Use a public HTTPS endpoint with an OpenAI-compatible Chat Completions API.'
          : 'Save an API key for this OMP provider in your Kordi account.',
        providerId: provider.id,
        helpUrl: provider.helpUrl,
        envVar: provider.envVar,
        // OMP-only providers keep every saved option; their methods are split by sign-in kind later.
        options: provider.options.map((option) => ({ ...option, providerId: provider.id })),
      }],
    });
  }

  return providers.sort((left, right) => (
    Number(right.configured) - Number(left.configured)
    || Number(isLocalProvider(right.id)) - Number(isLocalProvider(left.id))
    || left.label.localeCompare(right.label)
  ));
}

function preferredModelDisplayName(provider: AuthDisplayProvider) {
  const preferredModel = provider.preferredModel?.trim();
  if (!preferredModel) return null;

  const [modelProvider, ...modelParts] = preferredModel.split('/');
  const normalizedModelProvider = normalizeSelectedProviderId(modelProvider) ?? modelProvider;
  const providerId = normalizeSelectedProviderId(provider.id) ?? provider.id;
  return normalizedModelProvider === providerId && modelParts.length > 0
    ? modelParts.join('/')
    : preferredModel;
}

export function providerListSubtitle(provider: AuthDisplayProvider) {
  const totalOptions = provider.methods.reduce((sum, method) => sum + method.options.length, 0);
  const preferredModel = preferredModelDisplayName(provider);

  if (provider.localBaseUrl && preferredModel) return `Saved local model • ${preferredModel}`;
  if (provider.localBaseUrl && totalOptions === 0) return `Local endpoint • ${provider.localBaseUrl}`;
  if (!provider.configured) return 'No saved accounts or keys yet';
  if (provider.id === 'github-copilot' && provider.authority) return `Saved access • ${provider.authority}`;
  if (totalOptions === 1) return '1 saved account or key';
  if (totalOptions > 1) return `${totalOptions} saved accounts or keys`;
  return provider.statusSummary.replace(/^\[|\]$/g, '');
}
