import { useEffect, useRef, useState } from 'react';

import type { AiFeatures } from '@/features/cloud/agentTrustTypes';
import { defaultAgentTrustApi, type AgentTrustApi } from './agentTrustApi';

const featuresByToken = new Map<string, Promise<AiFeatures>>();

/** Server AI features (whether PiP is available), loaded once per session token. */
export function useAiFeatures(api: AgentTrustApi = defaultAgentTrustApi()) {
  const [features, setFeatures] = useState<AiFeatures | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await apiRef.current.session();
        if (!session) return;
        let request = featuresByToken.get(session.token);
        if (!request) {
          request = apiRef.current.calls.aiFeatures(session.token);
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
  }, []);
  return features;
}

/** Forgets cached AI features. Tests and sign-out use this. */
export function clearAiFeaturesCache() {
  featuresByToken.clear();
}
