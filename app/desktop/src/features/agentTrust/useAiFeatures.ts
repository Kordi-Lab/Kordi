import { useEffect, useState } from 'react';

import type { AiFeatures } from '@/features/cloud/agentTrustTypes';
import { defaultAgentTrustApi, type AgentTrustApi } from './agentTrustApi';

const featuresByToken = new Map<string, Promise<AiFeatures>>();

/** Server AI features (whether PiP is available), loaded once per session token. */
export function useAiFeatures(api: AgentTrustApi = defaultAgentTrustApi()) {
  const [features, setFeatures] = useState<AiFeatures | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await api.session();
        if (!session) return;
        let request = featuresByToken.get(session.token);
        if (!request) {
          request = api.calls.aiFeatures(session.token);
          featuresByToken.set(session.token, request);
          request.catch(() => featuresByToken.delete(session.token));
        }
        const loaded = await request;
        if (!cancelled) setFeatures(loaded);
      } catch {
        // Older servers have no AI features; PiP controls stay hidden.
        if (!cancelled) setFeatures({ pip: { available: false, providerLabel: null } });
      }
    })();
    return () => { cancelled = true; };
  }, [api]);
  return features;
}

/** Forgets cached AI features. Entries are per session token, so a new
 * sign-in reads them again; tests use this to start clean. */
export function clearAiFeaturesCache() {
  featuresByToken.clear();
}
