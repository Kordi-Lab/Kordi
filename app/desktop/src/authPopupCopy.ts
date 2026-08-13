import type { DesktopAuthProvider } from '@/kordi-app/types';

export function authPopupTitle(
  provider: DesktopAuthProvider | null,
  providerId: string,
  mode: 'oauth' | 'api-key',
) {
  if (providerId === 'anthropic' && mode === 'oauth') return 'Claude subscription';
  if (providerId === 'anthropic' && mode === 'api-key') return 'Anthropic API key';
  if (providerId === 'openai-codex' && mode === 'oauth') return 'ChatGPT sign-in';
  if (providerId === 'openai' && mode === 'api-key') return 'OpenAI API key';
  if (providerId === 'lm-studio' && mode === 'api-key') return 'LM Studio optional API key';
  if (providerId === 'ollama' && mode === 'api-key') return 'Ollama optional API key';
  return provider ? `${provider.label} ${mode === 'oauth' ? 'sign-in' : 'API key'}` : 'Authentication';
}

export function authPopupDescription(providerId: string, mode: 'oauth' | 'api-key') {
  if (providerId === 'anthropic' && mode === 'oauth') {
    return 'Sign in with the Claude subscription account you already use. Kordi will save it on this device for future desktop and terminal sessions.';
  }
  if (providerId === 'anthropic' && mode === 'api-key') {
    return 'Paste an Anthropic API key for billed API usage, scripting, and automation.';
  }
  if (providerId === 'openai-codex' && mode === 'oauth') {
    return 'Sign in with your ChatGPT account here. Kordi will save it on this device and refresh Settings automatically.';
  }
  if (providerId === 'openai' && mode === 'api-key') {
    return 'Paste your OpenAI API key and Kordi will reuse it on this device for future desktop and terminal sessions.';
  }
  if (providerId === 'lm-studio' && mode === 'api-key') {
    return 'The default LM Studio local server does not need a key. Paste one only if you enabled API-key protection in LM Studio.';
  }
  if (providerId === 'ollama' && mode === 'api-key') {
    return 'The default Ollama local server does not need a key. Paste one only if your Ollama-compatible endpoint requires authorization.';
  }
  return mode === 'oauth'
    ? 'Finish browser sign-in here. Kordi will save the result on this device and refresh Settings automatically.'
    : 'Paste the API key here and Kordi will reuse it on this device for future desktop and terminal sessions.';
}

export function authPopupPrimaryActionLabel(providerId: string, mode: 'oauth' | 'api-key') {
  if (providerId === 'anthropic' && mode === 'oauth') return 'Open Claude sign-in';
  if (providerId === 'anthropic' && mode === 'api-key') return 'Save Anthropic key';
  if ((providerId === 'lm-studio' || providerId === 'ollama') && mode === 'api-key') return 'Save optional key';
  if (mode === 'oauth') return 'Open sign-in';
  return 'Save key';
}

export function isLocalAuthProvider(providerId: string) {
  return providerId === 'lm-studio' || providerId === 'ollama';
}
