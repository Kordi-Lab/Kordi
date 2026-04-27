import type { DesktopAuthOption, DesktopAuthProvider, DesktopAuthState } from '@/kordi-app/types';

export type AuthDisplayMethod = {
  mode: 'oauth' | 'api-key';
  title: string;
  detail: string;
  providerId: string;
  helpUrl: string;
  envVar: string;
  options: Array<DesktopAuthOption & { providerId: string }>;
};

export type AuthDisplayProvider = {
  id: string;
  label: string;
  configured: boolean;
  statusSummary: string;
  loginHint: string;
  authority?: string | null;
  localBaseUrl?: string;
  methods: AuthDisplayMethod[];
};

function optionsFor(provider: DesktopAuthProvider | undefined, method: 'oauth' | 'api-key') {
  return (provider?.options ?? [])
    .filter((option) => option.method === (method === 'oauth' ? 'OAuth' : 'API key'))
    .map((option) => ({ ...option, providerId: provider?.id ?? '' }));
}

export function normalizeSelectedProviderId(id: string | null) {
  if (!id) return null;
  return id === 'openai-codex' ? 'openai' : id;
}

export function localProviderBaseUrl(providerId: string) {
  if (providerId === 'lm-studio') return 'http://localhost:1234/v1';
  if (providerId === 'ollama') return 'http://localhost:11434/v1';
  return null;
}

export function isLocalProvider(providerId: string) {
  return localProviderBaseUrl(providerId) !== null;
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
    helpUrl: providerId === 'lm-studio' ? 'https://lmstudio.ai/docs/app/api/endpoints/openai' : 'https://docs.ollama.com',
    supportsOAuth: false,
    supportsApiKey: true,
    configured: false,
    authority: null,
    baseUrl,
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
    const methods: AuthDisplayMethod[] = [
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

    providers.push({
      id: 'anthropic',
      label: 'Claude',
      configured: anthropic.options.length > 0,
      statusSummary: methods
        .map((method) => `${method.title}: ${method.options.length > 0 ? `${method.options.length} configured` : 'not configured'}`)
        .join(' • '),
      loginHint: 'Choose Claude subscription access for everyday chat, or an API key for billed automation and tooling.',
      authority: anthropic.authority,
      methods,
    });
  }

  const openAiOauth = byId.get('openai-codex');
  const openAiApi = byId.get('openai');
  if (openAiOauth || openAiApi) {
    const methods: AuthDisplayMethod[] = [];

    if (openAiOauth) {
      methods.push({
        mode: 'oauth',
        title: 'ChatGPT account',
        detail: 'Use your ChatGPT subscription when you want ChatGPT or Codex-style access without managing an API key.',
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
      methods,
    });
  }

  const singleProviderIds = ['github-copilot', 'lm-studio', 'ollama', 'google', 'groq', 'openrouter', 'xai'] as const;
  for (const id of singleProviderIds) {
    const provider = byId.get(id);
    if (!provider) continue;

    const mode = provider.supportsOAuth ? 'oauth' : 'api-key';

    providers.push({
      id,
      label: provider.label,
      configured: provider.configured,
      statusSummary: provider.statusSummary,
      loginHint: provider.loginHint,
      authority: provider.authority,
      localBaseUrl: isLocalProvider(id) ? (provider.baseUrl || localProviderBaseUrl(id) || undefined) : undefined,
      methods: [
        {
          mode,
          title:
            id === 'github-copilot'
              ? 'GitHub sign-in'
              : id === 'lm-studio'
                ? 'LM Studio local server'
                : id === 'ollama'
                  ? 'Ollama local server'
                  : id === 'google'
                    ? 'Google API key'
                    : id === 'groq'
                      ? 'Groq API key'
                      : id === 'openrouter'
                        ? 'OpenRouter API key'
                        : 'xAI API key',
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

  return providers.sort((left, right) => (
    Number(right.configured) - Number(left.configured)
    || Number(isLocalProvider(right.id)) - Number(isLocalProvider(left.id))
    || left.label.localeCompare(right.label)
  ));
}

export function providerListSubtitle(provider: AuthDisplayProvider) {
  const totalOptions = provider.methods.reduce((sum, method) => sum + method.options.length, 0);

  if (provider.localBaseUrl && totalOptions === 0) return `Local endpoint • ${provider.localBaseUrl}`;
  if (!provider.configured) return 'No saved accounts or keys yet';
  if (provider.id === 'github-copilot' && provider.authority) return `Saved access • ${provider.authority}`;
  if (totalOptions === 1) return '1 saved account or key';
  if (totalOptions > 1) return `${totalOptions} saved accounts or keys`;
  return provider.statusSummary.replace(/^\[|\]$/g, '');
}
