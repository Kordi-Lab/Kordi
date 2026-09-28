import type { AuthDisplayMethod, AuthDisplayProvider, AuthHostedLogin } from './model';

// Copy rules for provider pages: the full OMP name appears once (the detail
// header); everywhere else uses the short name, and method rows are named by
// how you sign in, never by the provider.

export type LoginMethodKind = 'browser' | 'device' | 'api-key' | 'vendor-token' | 'local';

const deviceHooks = new Set(['openai-codex-device', 'github-copilot']);

/** "Antigravity (Gemini 3, Claude, GPT-OSS)" -> { short: "Antigravity", qualifier: "Gemini 3, Claude, GPT-OSS" }. */
export function splitProviderName(name: string): { short: string; qualifier: string | null } {
  const trimmed = name.trim();
  const match = trimmed.match(/^(.*?)\s*\(([^()]*)\)$/);
  let short = match ? match[1].trim() : trimmed;
  const qualifiers = match ? [match[2].trim()] : [];
  // Plan tiers such as "Plus/Pro" describe the subscription, not the provider.
  const tier = short.match(/^(.*\S)\s+([A-Za-z+]+(?:\/[A-Za-z+]+)+)$/);
  if (tier) {
    short = tier[1];
    qualifiers.unshift(tier[2]);
  }
  return { short: short || trimmed, qualifier: qualifiers.filter(Boolean).join(', ') || null };
}

export function providerShortName(name: string) {
  return splitProviderName(name).short;
}

export function hostedLoginKind(hosted: AuthHostedLogin): Exclude<LoginMethodKind, 'local'> {
  if (hosted.method === 'api-key' || hosted.login.kind === 'api-key' || hosted.login.kind === 'env-only') return 'api-key';
  if (hosted.mode === 'device' || hosted.login.kind === 'device-code' || deviceHooks.has(hosted.login.hook ?? '')) return 'device';
  if (hosted.login.kind === 'oauth-code') return 'browser';
  return 'vendor-token';
}

export function methodKind(method: AuthDisplayMethod): Exclude<LoginMethodKind, 'local'> {
  if (method.hostedLogin) return hostedLoginKind(method.hostedLogin);
  return method.mode === 'api-key' ? 'api-key' : 'browser';
}

export const loginMethodTitles: Record<LoginMethodKind, string> = {
  browser: 'Browser sign-in',
  device: 'Device code',
  'api-key': 'API key',
  'vendor-token': 'Vendor token',
  local: 'On this Mac',
};

export const loginMethodVerbs: Record<LoginMethodKind, string> = {
  browser: 'Sign in',
  device: 'Show code',
  'api-key': 'Save key',
  'vendor-token': 'Continue',
  local: 'Sign in',
};

export const loginMethodFallbackDescriptions: Record<LoginMethodKind, string> = {
  browser: 'Opens the provider sign-in page; paste the code here if the browser cannot return to Kordi.',
  device: 'Shows a one-time code to enter on the provider page.',
  'api-key': 'Paste a key from the provider console.',
  'vendor-token': 'Paste the access token the provider issues.',
  local: "Uses Kordi's desktop sign-in; the account stays on this Mac.",
};

/**
 * Sub-provider name for a method whose OMP provider differs from the row,
 * such as ChatGPT inside the OpenAI row; null when the row is the provider.
 */
export function methodSubProvider(provider: AuthDisplayProvider, method: AuthDisplayMethod) {
  if (method.providerId === provider.id || !method.providerName) return null;
  return providerShortName(method.providerName);
}

/** Lowercases a leading word but keeps acronyms such as "API". */
export function lowerFirst(text: string) {
  return /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** "ChatGPT" + "Device code" -> "ChatGPT device code"; no prefix keeps the title. */
export function joinTitle(prefix: string | null, title: string) {
  return prefix ? `${prefix} ${lowerFirst(title)}` : title;
}

export function methodRowTitle(provider: AuthDisplayProvider, method: AuthDisplayMethod, kind: LoginMethodKind = methodKind(method)) {
  return joinTitle(methodSubProvider(provider, method), loginMethodTitles[kind]);
}

/** Short method label for a saved account, for example "ChatGPT" or "API key". */
export function savedAccountMethodLabel(provider: AuthDisplayProvider, method: AuthDisplayMethod) {
  if (method.mode === 'api-key') return 'API key';
  return methodSubProvider(provider, method) ?? (method.hostedLogin ? loginMethodTitles[methodKind(method)] : method.title);
}

/** One list line: the name qualifier, how to connect, and the model count. */
export function providerListDescription(provider: AuthDisplayProvider) {
  const { qualifier } = splitProviderName(provider.label);
  const methods = [...new Set(provider.methods.map((method) => (
    method.mode === 'api-key' ? 'API key' : methodRowTitle(provider, method)
  )))].join(' or ');
  const models = provider.modelCount ? `${provider.modelCount} ${provider.modelCount === 1 ? 'model' : 'models'}` : null;
  return [qualifier, methods || null, models].filter(Boolean).join(' · ');
}
