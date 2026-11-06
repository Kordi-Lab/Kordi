import type { Page } from '@playwright/test';
import type { CloudMemory, CloudMemoryCreate, CloudMemoryPatch, CloudMemorySettings } from '@/features/cloud/cloudMemoryClient';
import { account } from './apiFixture';
import { chatSessionId, peerName } from './chatFixture';

export const syntheticGlobalMemory = 'Synthetic review: keep replies concise.';
export const syntheticChatMemory = 'Synthetic review: share the next draft in this chat.';

/** Synthetic account routes for the complete app; install after the base/chat fixture. */
export async function installMemoryFixture(page: Page, baseURL: string) {
  const timestamp = '2026-11-05T12:00:00Z';
  const settings: CloudMemorySettings = { memoryEnabled: true, excludeSensitive: true };
  const memories: CloudMemory[] = [
    { memoryId: 'synthetic-memory-global', scope: 'global', scopeId: 'account', scopeLabel: 'Global',
      source: 'manual', text: syntheticGlobalMemory, category: 'general_preferences',
      ownerAccountId: account.accountId, profileIds: [], createdAt: timestamp, updatedAt: timestamp },
    { memoryId: 'synthetic-memory-chat', scope: 'conversation', scopeId: chatSessionId, scopeLabel: peerName,
      source: 'manual', text: syntheticChatMemory, category: 'work_context',
      ownerAccountId: account.accountId, profileIds: [], createdAt: timestamp, updatedAt: timestamp },
  ];
  const requests: { path: string; method: string; headers: Record<string, string> }[] = [];
  let nextId = 1;
  await page.route('**/v*/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL) return route.abort();
    const path = url.pathname;
    const method = request.method();
    const handles = path === '/v1/cloud/auth/capabilities' || path === '/v1/cloud/common-ground/profiles'
      || path === '/v1/cloud/memory' || path.startsWith('/v1/cloud/memory/');
    if (!handles) return route.fallback();
    requests.push({ path, method, headers: request.headers() });
    if (path === '/v1/cloud/auth/capabilities') {
      return route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], memoryVersion: 3 } });
    }
    if (path === '/v1/cloud/common-ground/profiles') return route.fulfill({ json: { profiles: [] } });
    if (path === '/v1/cloud/memory/settings') {
      if (method === 'PUT') Object.assign(settings, request.postDataJSON() as Partial<CloudMemorySettings>);
      return route.fulfill({ json: settings });
    }
    if (path === '/v1/cloud/memory') {
      if (method === 'GET') return route.fulfill({ json: { memories, settings } });
      if (method === 'DELETE') {
        const archived = memories.length;
        memories.splice(0);
        return route.fulfill({ json: { archived } });
      }
      if (method === 'POST') {
        if (!settings.memoryEnabled) return route.fulfill({ status: 409, json: { message: 'Memory is off.' } });
        const input = request.postDataJSON() as CloudMemoryCreate;
        const existing = memories.find(row => row.scope === input.scope && row.scopeId === input.scopeId && row.text === input.text);
        const memory: CloudMemory = existing ?? { ...input, scopeLabel: input.scopeLabel ?? null,
          memoryId: `synthetic-memory-added-${nextId++}`, ownerAccountId: account.accountId,
          profileIds: [], createdAt: timestamp, updatedAt: timestamp };
        if (!existing) memories.push(memory);
        return route.fulfill({ json: { memory } });
      }
    }
    const id = decodeURIComponent(path.slice('/v1/cloud/memory/'.length));
    const index = memories.findIndex(memory => memory.memoryId === id);
    if (index < 0) return route.fulfill({ status: 404, json: { message: 'This memory no longer exists.' } });
    if (method === 'DELETE') {
      memories.splice(index, 1);
      return route.fulfill({ status: 204 });
    }
    if (method === 'PATCH') {
      const patch = request.postDataJSON() as CloudMemoryPatch;
      const memory = memories[index];
      if (patch.text !== undefined) memory.text = patch.text;
      if (patch.category !== undefined) memory.category = patch.category;
      if (patch.addProfileId) memory.profileIds = [...new Set([...(memory.profileIds ?? []), patch.addProfileId])];
      if (patch.removeProfileId) memory.profileIds = (memory.profileIds ?? []).filter(id => id !== patch.removeProfileId);
      memory.updatedAt = new Date(Date.parse(timestamp) + nextId++ * 1000).toISOString();
      return route.fulfill({ json: { memory } });
    }
    return route.fulfill({ status: 405, json: { message: 'Method not supported by the synthetic fixture.' } });
  });
  return { memories, settings, requests };
}
