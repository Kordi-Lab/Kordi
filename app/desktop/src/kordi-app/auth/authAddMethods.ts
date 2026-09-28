import type { DesktopAuthProvider } from '@/kordi-app/types';
import { kordiSignInProviderIds, type AuthDisplayMethod, type AuthDisplayProvider, type AuthHostedLogin } from './model';
import {
  hostedLoginKind,
  joinTitle,
  loginMethodFallbackDescriptions,
  lowerFirst,
  loginMethodTitles,
  methodSubProvider,
  providerShortName,
  type LoginMethodKind,
} from './providerCopy';

// The three add-account layers mirror OMP's own flow: the provider page shows
// one "Add account" row, a picker lists each way to connect, and a login page
// runs one method step by step.

export type AuthAddMethod = {
  key: string;
  kind: LoginMethodKind | 'custom';
  /** Picker row title, for example "ChatGPT device code" or "API key". */
  title: string;
  /** Login page title, for example "Device code · ChatGPT". */
  pageTitle: string;
  description: string;
  method: AuthDisplayMethod | null;
  hosted: AuthHostedLogin | null;
  /** Desktop provider for Kordi's local sign-in on this Mac. */
  raw: DesktopAuthProvider | null;
  nativeMode?: 'oauth' | 'api-key';
};

/** Route inside a provider page: absent for the page, `{}` for the picker, a method for the login page. */
export type AuthAddRoute = { method?: string; provider?: string; /** A Custom API account being edited. */ account?: string };

function hostedDescription(hosted: AuthHostedLogin, kind: LoginMethodKind) {
  const instructions = hosted.login.instructions;
  return instructions && !instructions.includes('{user_code}') ? instructions : loginMethodFallbackDescriptions[kind];
}

export function buildAddMethods(provider: AuthDisplayProvider, rawProviders: DesktopAuthProvider[]): AuthAddMethod[] {
  const shortName = providerShortName(provider.label);
  if (provider.id === 'custom') {
    return [{
      key: 'custom', kind: 'custom', title: 'API key', pageTitle: `API key · ${shortName}`,
      description: 'Use a public HTTPS endpoint with an OpenAI-compatible Chat Completions API.',
      method: provider.methods[0] ?? null, hosted: null, raw: null,
    }];
  }
  return provider.methods.flatMap((method) => {
    const raw = rawProviders.find((item) => item.id === method.providerId) ?? null;
    const sub = methodSubProvider(provider, method);
    const name = sub ?? shortName;
    const hostedLogins = method.hostedLogins ?? (method.hostedLogin ? [method.hostedLogin] : []);
    const methods: AuthAddMethod[] = hostedLogins.map((hosted) => {
      const kind = hostedLoginKind(hosted);
      return {
        key: `${kind}:${hosted.providerId}`, kind, title: joinTitle(sub, loginMethodTitles[kind]),
        pageTitle: `${loginMethodTitles[kind]} · ${name}`, description: hostedDescription(hosted, kind),
        method, hosted, raw: null,
      };
    });
    if (!raw) return methods;
    if (hostedLogins.length === 0) {
      // No OMP catalog entry: Kordi's desktop flow is the only way in.
      methods.push({
        key: `native:${method.providerId}:${method.mode}`, kind: 'local', title: method.title,
        pageTitle: `${method.title} · ${name}`, description: method.detail, method, hosted: null, raw, nativeMode: method.mode,
      });
      return methods;
    }
    // Kordi's local adapter stays available where this Mac already uses it.
    const hasLocalAccounts = method.options.some((option) => option.profileId && option.source !== 'Cloud');
    if (method.mode === 'oauth' && kordiSignInProviderIds.has(method.providerId) && hasLocalAccounts) {
      methods.push({
        key: `local:${method.providerId}`, kind: 'local', title: joinTitle(sub, loginMethodTitles.local),
        pageTitle: `${loginMethodTitles.local} · ${name}`, description: loginMethodFallbackDescriptions.local,
        method, hosted: null, raw, nativeMode: 'oauth',
      });
    }
    return methods;
  });
}

/** "Browser sign-in, device code, API key" for the provider page's Add account row. */
export function addMethodsSummary(methods: AuthAddMethod[]) {
  // Generic method names read as one sentence; Kordi's own method titles keep their case.
  const labels = new Map<string, boolean>();
  for (const method of methods) {
    const native = method.key.startsWith('native:');
    labels.set(method.kind === 'custom' ? 'API key' : native ? method.title : loginMethodTitles[method.kind], !native);
  }
  return [...labels].map(([label, generic], index) => (index > 0 && generic ? lowerFirst(label) : label)).join(', ');
}

/** Finds the login page method from a route: an exact key, or a kind with an optional provider id. */
export function resolveAddMethod(methods: AuthAddMethod[], route: AuthAddRoute | null | undefined) {
  if (!route) return null;
  if (!route.method) return methods.length === 1 ? methods[0] : null;
  const exact = methods.find((method) => method.key === route.method);
  if (exact) return exact;
  const byKind = methods.filter((method) => method.kind === route.method);
  return byKind.find((method) => route.provider && (method.hosted?.providerId === route.provider || method.method?.providerId === route.provider))
    ?? byKind[0] ?? null;
}
