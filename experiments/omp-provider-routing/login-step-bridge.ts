/**
 * Bridges OMP's `OAuthController` callbacks to login-session steps, runs the
 * internal api-key flow, and runs OMP's own provider logins in hosted mode.
 *
 *   onAuth             -> { type: "open-url", url, launchUrl, instructions }
 *   onPrompt           -> { type: "prompt", message, placeholder, secret, allowEmpty }
 *                         (`secret` when OMP asks for it or the message names a key,
 *                         token, secret, password, cookie, or credential)
 *   onManualCodeInput  -> { type: "paste-code", instructions }
 *   onProgress         -> { type: "progress", message }
 *   onBrowserSession   -> rejected: a hosted worker cannot drive an isolated browser
 *   fetch              -> the worker's guarded fetch (outbound-guard.ts)
 */
import { getProviderDefinition, type OAuthController, type OAuthCredentials } from '@oh-my-pi/pi-ai';
import { DeclarativeOAuthCodeFlow, resolveCallbackOptions } from '@oh-my-pi/pi-ai/registry/engine/oauth-code';
import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth';
import { providerLoginPolicy, type ProviderLoginPolicy } from './login-policy';
import type { LoginSessionRecord } from './login-session-store';
import { HostedLoginError, type LoginRegistry } from './login-session-types';
import { workerFetch } from './outbound-guard';
import { resolveLoginEndpoint, type EndpointGuard } from './provider-endpoint';

const PASTE_CODE_INSTRUCTIONS = 'After you approve access, the browser opens a local address that may not load. '
  + 'Copy the full URL from the address bar, or the authorization code the provider shows, and paste it here.';
const PASTE_CODE_RETRY_INSTRUCTIONS = 'That value did not contain an authorization code for this sign-in. '
  + 'Paste the full URL from the browser address bar, or the authorization code.';
const PASTE_KEY_SUFFIX = ' You can also paste an API key instead.';
/** OMP never marks its own prompts secret, so a prompt that names a credential is masked. */
const SECRET_PROMPT = /key|token|secret|password|cookie|credential/i;

/** True when a prompt's answer must be masked. */
export function isSecretPrompt(prompt: { message: string; secret?: boolean }): boolean {
  return prompt.secret === true || SECRET_PROMPT.test(prompt.message);
}

/**
 * OMP's `launchUrl` points at the worker's own loopback callback server, which the
 * user's browser cannot reach. Only a non-loopback http(s) URL is passed through.
 */
function browserReachableUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.')
      || host === '[::1]' || host === '::1' || host === '0.0.0.0') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** Builds the controller handed to an OMP login; every callback lands on `session`. */
export function createStepController(session: LoginSessionRecord): OAuthController {
  return {
    signal: session.abort.signal,
    fetch: workerFetch(),
    onAuth: (info) => {
      session.setStep({
        type: 'open-url',
        url: String(info.url),
        launchUrl: browserReachableUrl(info.launchUrl),
        instructions: info.instructions ?? null,
      });
    },
    onProgress: (message) => {
      session.setStep({ type: 'progress', message: String(message) });
    },
    onPrompt: (prompt) => session.awaitInput({
      type: 'prompt',
      message: String(prompt.message),
      placeholder: prompt.placeholder ?? null,
      secret: isSecretPrompt({ message: String(prompt.message), secret: prompt.secret }),
      allowEmpty: prompt.allowEmpty === true,
    }, prompt.allowEmpty === true),
    onManualCodeInput: (signal) => {
      session.pasteRequests += 1;
      const instructions = (session.pasteRequests > 1 ? PASTE_CODE_RETRY_INSTRUCTIONS : PASTE_CODE_INSTRUCTIONS)
        + (session.pasteKey ? PASTE_KEY_SUFFIX : '');
      return session.awaitInput({ type: 'paste-code', instructions }, false, signal);
    },
    onBrowserSession: async () => {
      throw new HostedLoginError('unsupported_flow');
    },
  };
}

/**
 * The internal api-key flow: one api-key step, then validation. It serves `api-key`
 * and `env-only` providers and the `api-key` method of providers that also accept a
 * key; only an `api-key` rule's own text is shown, never OAuth instructions.
 */
export async function runApiKeyFlow(
  session: LoginSessionRecord,
  policy: ProviderLoginPolicy,
  registry: LoginRegistry,
): Promise<string> {
  const keyRule = policy.kind === 'api-key';
  const value = await session.awaitInput({
    type: 'api-key',
    instructions: keyRule ? policy.instructions : null,
    prompt: keyRule ? policy.prompt : null,
    placeholder: keyRule ? policy.placeholder : null,
    authUrl: keyRule ? policy.authUrl : null,
  }, false);
  const { apiKey } = await registry.validateApiKey(session.provider, value, session.abort.signal);
  return apiKey;
}

/**
 * Runs OMP's own login for one provider in hosted mode.
 *
 * The worker runs in a container, so the user's browser can never reach a loopback
 * callback listener started by the worker. Declarative `oauth-code` rules therefore
 * run through OMP's `DeclarativeOAuthCodeFlow` with `manualInputOnly: true` and
 * `nativeScheme: false`: no loopback listener or OS URL handler is registered,
 * concurrent logins for the same provider cannot collide on the registered callback
 * port, the advertised redirect URI stays the provider's registered one, and
 * completion always comes from the pasted redirect URL or code. The token exchange,
 * PKCE, state check, credential projection, and after-exchange hooks are OMP's own.
 * Every other kind calls the provider definition's `login`.
 */
export async function runHostedOmpLogin(provider: string, controller: OAuthController): Promise<OAuthCredentials | string> {
  const policy = authPolicyFor(provider);
  const rule = policy?.login;
  if (policy && rule?.kind === 'oauth-code') {
    const callback = await resolveCallbackOptions(rule.callback, policy.id, controller.signal);
    const flow = new DeclarativeOAuthCodeFlow(controller, rule, policy, {
      ...callback,
      manualInputOnly: true,
      nativeScheme: false,
    });
    const credentials = await flow.login();
    return policy.result === 'api-key' ? credentials.access : credentials;
  }
  const login = getProviderDefinition(provider)?.login;
  if (!login) throw new HostedLoginError('unsupported_flow');
  return login(controller);
}

/**
 * The production registry: OMP policies and logins, the worker's key validation, and
 * endpoint resolution. `guard` is a test seam for the endpoint check.
 */
export function ompLoginRegistry(validateApiKey: LoginRegistry['validateApiKey'], guard: EndpointGuard = {}): LoginRegistry {
  return {
    policy: providerLoginPolicy,
    login: runHostedOmpLogin,
    validateApiKey,
    endpoint: (provider, result) => resolveLoginEndpoint(provider, result, guard),
  };
}
