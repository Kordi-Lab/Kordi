import { canonicalMessageRequestForIpc } from '@/features/canonical/canonicalMessageIpc';
import type {
  AppendCanonicalMessageRequest,
  CanonicalIdentity,
  CanonicalSessionMessage,
  OpenCanonicalSessionFastResult,
  OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import {
  invokeDesktop,
  isNativeDesktopShell,
} from '@/lib/desktop';

export async function applyCanonicalSelfAgentSyncPlan(request: {
  agentIdentityRequest: UpsertCanonicalIdentityRequest;
  sessionRequests: OpenCanonicalSessionRequest[];
  messageRequests: AppendCanonicalMessageRequest[];
}) {
  return invokeDesktop<{
    identity: CanonicalIdentity;
    sessions: OpenCanonicalSessionFastResult[];
    messages: CanonicalSessionMessage[];
  }>('desktop_canonical_apply_self_agent_sync_plan', {
    request: {
      ...request,
      messageRequests: request.messageRequests.map(canonicalMessageRequestForIpc),
    },
  });
}

export async function pruneCanonicalLegacyCloudSelfMessageDuplicates(
  authoritativeMessageIds: string[],
) {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<string[]>(
    'desktop_canonical_prune_legacy_cloud_self_message_duplicates',
    { authoritativeMessageIds },
  );
}
