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

export function buildAuthDisplayProviders(authState: DesktopAuthState | null): AuthDisplayProvider[] {
  if (!authState) return [];

  const byId = new Map(authState.providers.map((provider) => [provider.id, provider]));
  const providers: AuthDisplayProvider[] = [];

  const anthropic = byId.get('anthropic');
  if (anthropic) {
    const methods: AuthDisplayMethod[] = [
      {
        mode: 'oauth',
        title: 'Claude Pro/Max subscription',
        detail: 'Use your Claude browser subscription for Claude Pro/Max OAuth sign-in and saved subscription sessions.',
        providerId: 'anthropic',
        helpUrl: 'https://claude.ai/',
        envVar: anthropic.envVar,
        options: optionsFor(anthropic, 'oauth'),
      },
      {
        mode: 'api-key',
        title: 'Anthropic Console API key',
        detail: `Use ${anthropic.envVar || 'ANTHROPIC_API_KEY'} or save an Anthropic API key for platform usage, automation, and billing under your Anthropic account.`,
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
      loginHint: anthropic.loginHint,
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
        title: 'ChatGPT Plus/Pro (Codex)',
        detail: 'OAuth subscription login for ChatGPT-based access.',
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
        detail: `Use ${openAiApi.envVar || 'OPENAI_API_KEY'} or save multiple keys and switch active profile later.`,
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
        'OpenAI supports both ChatGPT OAuth and platform API keys. You can keep either or both.',
      methods,
    });
  }

  const singleProviderIds = ['github-copilot', 'google', 'groq', 'openrouter', 'xai'] as const;
  for (const id of singleProviderIds) {
    const provider = byId.get(id);
    if (!provider) continue;

    const mode = provider.supportsOAuth ? 'oauth' : 'api-key';

    providers.push({
      id,
      label: provider.label,
      configured: provider.options.length > 0,
      statusSummary: provider.statusSummary,
      loginHint: provider.loginHint,
      authority: provider.authority,
      methods: [
        {
          mode,
          title:
            id === 'github-copilot'
              ? 'GitHub sign-in'
              : id === 'google'
                ? 'Google API key'
                : id === 'groq'
                  ? 'Groq API key'
                  : id === 'openrouter'
                    ? 'OpenRouter API key'
                    : 'xAI API key',
          detail:
            mode === 'oauth'
              ? 'OAuth or device login with support for multiple saved accounts.'
              : `Use ${provider.envVar || 'API_KEY'} or save multiple keys and choose the active profile later.`,
          providerId: provider.id,
          helpUrl: provider.helpUrl,
          envVar: provider.envVar,
          options: optionsFor(provider, mode),
        },
      ],
    });
  }

  return providers.sort((left, right) => Number(right.configured) - Number(left.configured) || left.label.localeCompare(right.label));
}

export function providerListSubtitle(provider: AuthDisplayProvider) {
  const totalOptions = provider.methods.reduce((sum, method) => sum + method.options.length, 0);

  if (!provider.configured) return 'Not configured';
  if (provider.id === 'github-copilot' && provider.authority) return `Configured • ${provider.authority}`;
  if (totalOptions === 1) return '1 saved option';
  if (totalOptions > 1) return `${totalOptions} saved options`;
  return provider.statusSummary.replace(/^\[|\]$/g, '');
}
