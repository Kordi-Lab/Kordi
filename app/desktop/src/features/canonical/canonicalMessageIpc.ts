import type { AppendCanonicalMessageRequest } from '@/kordi-app/types';

export function canonicalMessageRequestForIpc(
  request: AppendCanonicalMessageRequest,
): AppendCanonicalMessageRequest {
  const createdAtMs = request.createdAtMs;
  if (createdAtMs == null || Number.isSafeInteger(createdAtMs)) return request;
  return {
    ...request,
    createdAtMs: Number.isFinite(createdAtMs)
      ? Math.trunc(createdAtMs)
      : undefined,
  };
}
