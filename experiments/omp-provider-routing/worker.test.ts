import { expect, test } from 'bun:test';
import { runSyntheticHostedTurn, type HostedRoute, type ProviderMaterial } from './worker';

const cases: Array<[string, HostedRoute, ProviderMaterial]> = [
  ['first Codex account', { defaultAuthProvider: 'openai', defaultAuthChoice: 'profile:codex-1', defaultModel: 'openai/gpt-5.6-sol' }, { provider: 'openai-codex', authChoice: 'profile:codex-1', payload: { apiMode: 'openai-codex-oauth', accessToken: 'synthetic-codex-1' } }],
  ['second Codex account', { defaultAuthProvider: 'openai', defaultAuthChoice: 'profile:codex-2', defaultModel: 'openai/gpt-5.6-luna' }, { provider: 'openai-codex', authChoice: 'profile:codex-2', payload: { apiMode: 'openai-codex-oauth', accessToken: 'synthetic-codex-2' } }],
  ['iPhone Codex account', { defaultAuthProvider: 'openai', defaultAuthChoice: 'ios-codex:1', defaultModel: 'openai/gpt-5.6-sol' }, { provider: 'openai-codex', authChoice: 'ios-codex:1', payload: { apiMode: 'openai-codex-oauth', accessToken: 'synthetic-ios-codex' } }],
  ['OpenAI API key', { defaultAuthProvider: 'openai', defaultAuthChoice: 'ios-api-key:1', defaultModel: 'openai/gpt-5.6-sol' }, { provider: 'openai', authChoice: 'ios-api-key:1', payload: { apiKey: 'synthetic-openai-key' } }],
  ['Anthropic OAuth', { defaultAuthProvider: 'anthropic', defaultAuthChoice: 'profile:claude', defaultModel: 'anthropic/claude-sonnet-5' }, { provider: 'anthropic', authChoice: 'profile:claude', payload: { apiMode: 'anthropic-oauth', accessToken: 'synthetic-claude' } }],
  ['Anthropic API key', { defaultAuthProvider: 'anthropic', defaultAuthChoice: 'ios-api-key:claude', defaultModel: 'anthropic/claude-sonnet-5' }, { provider: 'anthropic', authChoice: 'ios-api-key:claude', payload: { apiKey: 'synthetic-claude-key' } }],
  ['Google API key', { defaultAuthProvider: 'google', defaultAuthChoice: 'ios-api-key:google', defaultModel: 'google/gemini-2.5-pro' }, { provider: 'google', authChoice: 'ios-api-key:google', payload: { apiKey: 'synthetic-google' } }],
  ['Groq API key', { defaultAuthProvider: 'groq', defaultAuthChoice: 'ios-api-key:groq', defaultModel: 'groq/llama-3.3-70b-versatile' }, { provider: 'groq', authChoice: 'ios-api-key:groq', payload: { apiKey: 'synthetic-groq' } }],
  ['OpenRouter API key', { defaultAuthProvider: 'openrouter', defaultAuthChoice: 'ios-api-key:router', defaultModel: 'openrouter/openai/gpt-5.6-sol' }, { provider: 'openrouter', authChoice: 'ios-api-key:router', payload: { apiKey: 'synthetic-router' } }],
  ['xAI API key', { defaultAuthProvider: 'xai', defaultAuthChoice: 'ios-api-key:xai', defaultModel: 'xai/grok-code-fast-1' }, { provider: 'xai', authChoice: 'ios-api-key:xai', payload: { apiKey: 'synthetic-xai' } }],
];

for (const [name, route, material] of cases) {
  test(`OMP worker routes ${name}`, async () => {
    const result = await runSyntheticHostedTurn(route, material);
    expect(result.authChoice).toBe(route.defaultAuthChoice);
    expect(result.credentialDelivered).toBe(true);
    expect(result.response).toContain(result.model);
  });
}

test('OMP worker rejects a credential from another saved account', async () => {
  await expect(runSyntheticHostedTurn(cases[0]![1], cases[1]![2])).rejects.toThrow(/does not match/);
});
