import { describe, expect, test } from 'bun:test';
import { parseGeminiCliCredentials } from '@oh-my-pi/pi-ai/providers/google-gemini-cli';
import { parseGitHubCopilotApiKey } from '@oh-my-pi/pi-catalog/wire/github-copilot';
import { hostedCredential } from './hosted-credential';

// The key `/run` hands to OMP: structured JSON for `api-key-format "structured"` providers, a bearer string otherwise.

const expiresAtMs = Date.now() + 3_600_000;

describe('hosted credential', () => {
  test('google-gemini-cli gets the structured key OMP builds, in OMP field order', async () => {
    const key = await hostedCredential('google-gemini-cli', {
      apiMode: 'google-gemini-cli-oauth',
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiresAtMs,
      email: 'user@example.test',
      projectId: 'synthetic-project',
      accountId: null,
      apiEndpoint: null,
      enterpriseUrl: null,
    });
    expect(key).toBe(JSON.stringify({
      token: 'synthetic-access',
      projectId: 'synthetic-project',
      refreshToken: 'synthetic-refresh',
      expiresAt: expiresAtMs,
      email: 'user@example.test',
    }));
    // OMP's own transport parser accepts it; the raw access token alone is rejected.
    expect(parseGeminiCliCredentials(key!)).toMatchObject({ accessToken: 'synthetic-access', projectId: 'synthetic-project' });
    expect(() => parseGeminiCliCredentials('synthetic-access')).toThrow();
  });

  test('an enterprise GitHub Copilot key carries the enterprise domain and API endpoint', async () => {
    const key = await hostedCredential('github-copilot', {
      apiMode: 'github-copilot-oauth',
      accessToken: 'synthetic-copilot-token',
      refreshToken: 'synthetic-github-token',
      expiresAtMs,
      enterpriseUrl: 'ghe.example.com',
      apiEndpoint: 'https://copilot-api.ghe.example.com',
    });
    expect(parseGitHubCopilotApiKey(key!)).toEqual({
      accessToken: 'synthetic-copilot-token',
      enterpriseUrl: 'ghe.example.com',
      apiEndpoint: 'https://copilot-api.ghe.example.com',
    });
  });

  test('bearer providers get the key or access token unchanged', async () => {
    expect(await hostedCredential('openai', { apiKey: 'synthetic-openai-key' })).toBe('synthetic-openai-key');
    expect(await hostedCredential('anthropic', { apiMode: 'anthropic-oauth', accessToken: 'synthetic-claude' })).toBe('synthetic-claude');
    expect(await hostedCredential('openai-codex', { apiMode: 'openai-codex-oauth', accessToken: 'synthetic-codex', apiKey: 'unused' }))
      .toBe('synthetic-codex');
    expect(await hostedCredential('openai', {})).toBeUndefined();
  });

  test('an expired structured credential is refused before any provider call', async () => {
    await expect(hostedCredential('google-antigravity', {
      apiMode: 'google-antigravity-oauth',
      accessToken: 'synthetic-access',
      projectId: 'synthetic-project',
      expiresAtMs: Date.now() - 1_000,
    })).rejects.toThrow('credential_expired');
  });
});
