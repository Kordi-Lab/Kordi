import { useMemo, useReducer, useRef } from 'react';

import { useVoiceTranscriptionJobsVersion } from '@/features/chat/voiceTranscriptionJobs';

import type { CloudMessage } from './authClient';
import { voiceAgentWaitingSince, voiceForAgentExecution } from './cloudVoiceAgentGate';

type GateRequest = Pick<CloudMessage, 'messageId' | 'createdAt' | 'voiceMessage'>;

/**
 * Lets an agent executor effect hold voice requests that were sent without
 * transcription. The returned gate changes identity when a local transcription
 * job finishes or a bounded wait expires, so the effect re-checks its requests.
 */
export function useVoiceAgentRequestGate() {
  const jobsVersion = useVoiceTranscriptionJobsVersion();
  const [wakeRevision, wake] = useReducer((value: number) => value + 1, 0);
  const passRef = useRef({ waitingSince: new Map<string, number>(), waitUntilMs: Number.POSITIVE_INFINITY });
  return useMemo(() => ({
    revision: `${jobsVersion}:${wakeRevision}`,
    /** The voice to show the agent, or undefined while the request must keep waiting. */
    check(request: GateRequest): CloudMessage['voiceMessage'] | undefined {
      const gate = voiceForAgentExecution({
        voice: request.voiceMessage,
        createdAt: request.createdAt,
        waitingSinceMs: voiceAgentWaitingSince(passRef.current.waitingSince, request.messageId),
      });
      if (gate.status === 'waiting') {
        passRef.current.waitUntilMs = Math.min(passRef.current.waitUntilMs, gate.retryAtMs);
        return undefined;
      }
      passRef.current.waitingSince.delete(request.messageId);
      return gate.voice;
    },
    /** Call once after checking every request in an effect pass; returns the effect cleanup. */
    scheduleWake() {
      const wakeAtMs = passRef.current.waitUntilMs;
      passRef.current.waitUntilMs = Number.POSITIVE_INFINITY;
      if (!Number.isFinite(wakeAtMs)) return undefined;
      const timer = window.setTimeout(wake, Math.max(0, wakeAtMs - Date.now()));
      return () => window.clearTimeout(timer);
    },
  }), [jobsVersion, wakeRevision]);
}
