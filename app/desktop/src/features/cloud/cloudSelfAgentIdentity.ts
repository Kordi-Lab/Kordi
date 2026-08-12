import { cloudOperationUuid } from './authClient';
import type { CloudSelfAgentSyncOperation } from './cloudSelfAgentForwardSync';

const RECOVERY_KEY_PREFIX = 'kordi.cloud.selfAgentRecovery:';
const PREVIOUS_RECOVERY_KEY_PREFIX = 'kordi.cloud.selfAgentV2Recovery.v1:';

export function cloudSelfAgentRequestClientMessageId(
  sessionId: string,
  localMessageId: string,
): string {
  return cloudOperationUuid(
    `self-agent:${sessionId}:${localMessageId}:request`,
  );
}

export function cloudSelfAgentOperationClientMessageId(
  operation: CloudSelfAgentSyncOperation,
): string {
  const requestId = operation.parentLocalMessageId ?? operation.localMessageId;
  if (operation.role === 'user') {
    return cloudSelfAgentRequestClientMessageId(
      operation.sessionId,
      requestId,
    );
  }
  return cloudOperationUuid(
    `self-agent:${operation.sessionId}:${requestId}:response`,
  );
}

function recoveryKey(accountId: string): string {
  return `${RECOVERY_KEY_PREFIX}${accountId}`;
}

export function loadCloudSelfAgentRecoverySessionIds(accountId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const key = recoveryKey(accountId);
    const previousKey = `${PREVIOUS_RECOVERY_KEY_PREFIX}${accountId}`;
    const raw = window.localStorage.getItem(key)
      ?? window.localStorage.getItem(previousKey);
    if (raw && window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(key, raw);
      window.localStorage.removeItem(previousKey);
    }
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.flatMap((value) => typeof value === 'string' && value.trim()
      ? [value.trim()]
      : []));
  } catch {
    return new Set();
  }
}

export function saveCloudSelfAgentRecoverySessionIds(
  accountId: string,
  sessionIds: ReadonlySet<string>,
): void {
  if (typeof window === 'undefined') return;
  try {
    const key = recoveryKey(accountId);
    if (sessionIds.size === 0) {
      window.localStorage.removeItem(key);
      window.localStorage.removeItem(`${PREVIOUS_RECOVERY_KEY_PREFIX}${accountId}`);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify([...sessionIds].sort()));
    window.localStorage.removeItem(`${PREVIOUS_RECOVERY_KEY_PREFIX}${accountId}`);
  } catch {
    // Best effort. Stable operation IDs still make a retry safe.
  }
}
