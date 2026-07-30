import type { VirtualTranscriptNavigationRequest } from '@/features/chat/VirtualTranscript';

export type TranscriptNavigationRequest =
  VirtualTranscriptNavigationRequest;

export function sameTranscriptNavigationRequest(
  current: TranscriptNavigationRequest,
  handled: TranscriptNavigationRequest,
) {
  return (
    current.sessionKey === handled.sessionKey
    && current.nonce === handled.nonce
    && current.id.trim() === handled.id.trim()
  );
}
