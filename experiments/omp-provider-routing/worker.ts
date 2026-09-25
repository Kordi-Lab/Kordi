import { createMockModel, registerMockApi } from '@oh-my-pi/pi-ai/providers/mock';
import { streamSimple } from '@oh-my-pi/pi-ai';

export type HostedRoute = {
  defaultAuthProvider: string;
  defaultAuthChoice: string;
  defaultModel: string;
};

/**
 * Decrypted material for one claimed run. OAuth material carries the login's account
 * fields so structured-key providers (see hosted-credential.ts) get the JSON key OMP
 * builds from them. `baseUrl` is read only by the Custom API route.
 */
export type ProviderMaterial = {
  provider: string;
  authChoice: string;
  payload: {
    apiKey?: string;
    accessToken?: string;
    apiMode?: string;
    baseUrl?: string | null;
    refreshToken?: string | null;
    expiresAtMs?: number | null;
    email?: string | null;
    accountId?: string | null;
    apiEndpoint?: string | null;
    enterpriseUrl?: string | null;
    projectId?: string | null;
  };
};

function canonicalProvider(provider: string): string {
  if (provider === 'openai-codex' || provider === 'codex') return 'openai';
  if (provider === 'google-gemini') return 'google';
  return provider;
}

/** The hosted server selects one encrypted snapshot before invoking this worker. */
export async function runSyntheticHostedTurn(route: HostedRoute, material: ProviderMaterial) {
  if (canonicalProvider(route.defaultAuthProvider) !== canonicalProvider(material.provider)
    || route.defaultAuthChoice !== material.authChoice) {
    throw new Error('Provider material does not match the selected route.');
  }
  const credential = material.payload.apiKey ?? material.payload.accessToken;
  if (!credential) throw new Error('Selected provider material has no credential.');
  const modelID = route.defaultModel.replace(/^[^/]+\//, '');
  if (!modelID) throw new Error('Selected route has no model.');

  registerMockApi();
  const mock = createMockModel({
    id: modelID,
    provider: material.provider,
    handler: () => ({ content: [`synthetic response from ${modelID}`] }),
  });
  const result = await streamSimple(mock.model, {
    systemPrompt: ['Synthetic hosted routing probe.'],
    messages: [{ role: 'user', content: 'probe' }],
    tools: [],
  }, { apiKey: credential }).result();
  return {
    model: mock.model.id,
    provider: mock.model.provider,
    authChoice: material.authChoice,
    credentialDelivered: mock.calls[0]?.options?.apiKey === credential,
    response: result.content.find(block => block.type === 'text')?.text,
  };
}
