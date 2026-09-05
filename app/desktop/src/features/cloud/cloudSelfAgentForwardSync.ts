import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import { isGenericSessionTitle } from '@/features/chat/sessionTitlePolicy';
import type { ChatSyncConversation } from './authClient';
import { cloudSelfAgentOperationClientMessageId, cloudSelfAgentProcessingLedgerKey } from './cloudSelfAgentIdentity';
export {
  cloudSelfAgentOperationClientMessageId,
  loadCloudSelfAgentRecoverySessionIds,
  saveCloudSelfAgentRecoverySessionIds,
} from './cloudSelfAgentIdentity';
import { cloudAgentTargetsBySessionId, cloudSyncedLocalAgentSessionIds } from './cloudSelfAgentSessionIdentity';

const CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX =
  'kordi.cloud.selfAgentSync.chat:';
const PREVIOUS_CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX =
  'kordi.cloud.selfAgentSync.v2:';
const CLOUD_SELF_AGENT_FORWARD_BASELINE_PREFIX =
  'kordi.cloud.selfAgentForwardBaseline.v1:';
const CLOUD_SELF_AGENT_FORWARD_CUTOFF_PREFIX =
  'kordi.cloud.selfAgentForwardCutoff.v1:';
const RECENT_INTERRUPTED_RECOVERY_WINDOW_MS = 24 * 60 * 60_000;

export type CloudSelfAgentSyncLedgerEntry = {
  cloudMessageId: string | null;
  syncedAtMs: number;
  skippedLocalBackfill?: boolean;
};

export type CloudSelfAgentSyncLedger =
  Record<string, CloudSelfAgentSyncLedgerEntry>;

export type CloudSelfAgentSyncOperation = {
  localMessageId: string;
  sessionId: string;
  role: 'user' | 'agent';
  text: string;
  parentLocalMessageId: string | null;
  createdAtMs: number;
  deliveryState: 'sent' | 'complete' | 'failed' | 'cancelled';
  queued?: boolean;
  cancelledWhileQueued?: boolean;
  cancelledAtMs?: number;
  targetAgentId?: string; targetAgentName?: string;
};

export function queuedCancellationLedgerKey(localMessageId: string) {
  return `queued-cancelled:${localMessageId}`;
}

export type CloudSelfAgentSessionReconciliation = {
  sessionId: string;
  title: string | null;
  createConversation: boolean;
  recoverHistory: boolean;
  targetAgentId?: string; targetAgentName?: string;
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function selfAgentSyncLedgerKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX}${accountId}`;
}

function selfAgentForwardBaselineKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_FORWARD_BASELINE_PREFIX}${accountId}`;
}

function selfAgentForwardCutoffKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_FORWARD_CUTOFF_PREFIX}${accountId}`;
}

export function loadCloudSelfAgentForwardBaseline(
  accountId: string,
): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(
    selfAgentForwardBaselineKey(accountId),
  ) === '1';
}

export function saveCloudSelfAgentForwardBaseline(accountId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      selfAgentForwardBaselineKey(accountId),
      '1',
    );
  } catch {
    // Best effort. If persistence fails, this device may try again later.
  }
}

export function loadCloudSelfAgentForwardCutoff(
  accountId: string,
): number | null {
  if (typeof window === 'undefined') return null;
  const parsed = Number(window.localStorage.getItem(
    selfAgentForwardCutoffKey(accountId),
  ));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function saveCloudSelfAgentForwardCutoff(
  accountId: string,
  cutoffMs: number = Date.now(),
): number {
  const normalizedCutoff = Number.isFinite(cutoffMs) && cutoffMs > 0
    ? Math.floor(cutoffMs)
    : Date.now();
  if (typeof window === 'undefined') return normalizedCutoff;
  try {
    window.localStorage.setItem(
      selfAgentForwardCutoffKey(accountId),
      String(normalizedCutoff),
    );
  } catch {
    // Best effort. The caller still uses this boundary for the current run.
  }
  return normalizedCutoff;
}

export function loadCloudSelfAgentSyncLedger(
  accountId: string,
): CloudSelfAgentSyncLedger {
  if (typeof window === 'undefined') return {};
  try {
    const key = selfAgentSyncLedgerKey(accountId);
    const previousKey = `${PREVIOUS_CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX}${accountId}`;
    const raw = window.localStorage.getItem(key)
      ?? window.localStorage.getItem(previousKey);
    if (raw && window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(key, raw);
      window.localStorage.removeItem(previousKey);
    }
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
    ) return {};
    const ledger: CloudSelfAgentSyncLedger = {};
    for (const [localMessageId, value] of Object.entries(parsed)) {
      if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
      ) continue;
      const record = value as Record<string, unknown>;
      const cloudMessageId = cleanText(
        typeof record.cloudMessageId === 'string'
          ? record.cloudMessageId
          : null,
      );
      const syncedAtMs = record.syncedAtMs;
      const skippedLocalBackfill =
        record.skippedLocalBackfill === true;
      if (
        !localMessageId.trim()
        || typeof syncedAtMs !== 'number'
        || !Number.isFinite(syncedAtMs)
      ) continue;
      if (!cloudMessageId && !skippedLocalBackfill) continue;
      ledger[localMessageId] = {
        cloudMessageId: cloudMessageId || null,
        syncedAtMs,
        skippedLocalBackfill: skippedLocalBackfill || undefined,
      };
    }
    return ledger;
  } catch {
    return {};
  }
}

export function saveCloudSelfAgentSyncLedger(
  accountId: string,
  ledger: CloudSelfAgentSyncLedger,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      selfAgentSyncLedgerKey(accountId),
      JSON.stringify(ledger),
    );
    window.localStorage.removeItem(
      `${PREVIOUS_CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX}${accountId}`,
    );
  } catch {
    // Best effort. A failed ledger write may cause a future duplicate sync,
    // but should not block local chat or Cloud refresh.
  }
}

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contentText(content: Record<string, unknown>, key: string): string {
  return cleanText(typeof content[key] === 'string' ? content[key] : null);
}

function selfAgentMessageDeliveryState(
  message: CanonicalSessionMessage,
): CloudSelfAgentSyncOperation['deliveryState'] | null {
  const status = cleanText(message.status).toLowerCase();
  const content = objectContent(message.content);
  const deliveryState = contentText(content, 'deliveryState').toLowerCase();
  if (message.senderRole === 'user') {
    if (content.queuedMessage === true && ['queued', 'cancelled'].includes(contentText(content, 'queueState') || deliveryState || status)) return 'sent';
    return ['sent', 'delivered', 'read', 'complete', 'completed'].includes(
      deliveryState || status,
    ) ? 'sent' : null;
  }
  const terminal = deliveryState || status;
  if (terminal === 'failed' || terminal === 'processing_failed') {
    return 'failed';
  }
  if (terminal === 'cancelled' || terminal === 'canceled') {
    return 'cancelled';
  }
  return ['complete', 'completed', 'succeeded', 'responded', 'read'].includes(
    terminal,
  ) ? 'complete' : null;
}

function selfAgentMessageText(
  message: CanonicalSessionMessage,
  deliveryState: CloudSelfAgentSyncOperation['deliveryState'],
): string {
  const text = cleanText(message.contentText);
  if (text) return text;
  const content = objectContent(message.content);
  if (deliveryState === 'failed') {
    return contentText(content, 'error')
      || contentText(content, 'detail')
      || 'Kordi could not finish this reply. Try again.';
  }
  if (deliveryState === 'cancelled') {
    return contentText(content, 'message') || 'Request canceled.';
  }
  return '';
}

function explicitSelfAgentParentMessageId(
  message: CanonicalSessionMessage,
): string | null {
  const content = objectContent(message.content);
  return cleanText(message.parentMessageId)
    || contentText(content, 'replyToMessageId')
    || contentText(content, 'requestId')
    || null;
}

function shouldSkipSelfAgentForwardSyncMessage(
  message: CanonicalSessionMessage,
  recoverMissingChatSession = false,
): boolean {
  return message.sourceTransport === 'canonical-fork-snapshot'
    || (!recoverMissingChatSession && (
      message.sourceTransport === 'cloud-self-agent'
      || message.id.startsWith('msg:cloud:self:')
    ));
}

function chatSyncConversationSessionId(
  conversation: ChatSyncConversation,
): string {
  return cleanText(conversation.legacy_session_id) || conversation.id;
}

export function planCloudSelfAgentSessionReconciliation(
  state: CanonicalSessionState,
  conversations: readonly ChatSyncConversation[],
  options: {
    identitySyncedSessionIds?: ReadonlySet<string>;
    pendingRecoverySessionIds?: ReadonlySet<string>;
    nowMs?: number;
  } = {},
): CloudSelfAgentSessionReconciliation[] {
  const remoteBySessionId = new Map(
    conversations
      .filter((conversation) => conversation.kind === 'ai')
      .map((conversation) => [
        chatSyncConversationSessionId(conversation),
        conversation,
      ] as const),
  );
  const recoverableMessageSessionIds = new Set(
    state.messages.flatMap((message) => {
      if (!selfAgentMessageDeliveryState(message)) return [];
      if (shouldSkipSelfAgentForwardSyncMessage(message, true)) return [];
      return [message.sessionId];
    }),
  );
  const recoverableMessageCountBySessionId = new Map<string, number>();
  for (const message of state.messages) {
    if (!selfAgentMessageDeliveryState(message)) continue;
    if (shouldSkipSelfAgentForwardSyncMessage(message, true)) continue;
    recoverableMessageCountBySessionId.set(
      message.sessionId,
      (recoverableMessageCountBySessionId.get(message.sessionId) ?? 0)
        + 1,
    );
  }
  const nowMs = options.nowMs ?? Date.now();
  const syncedSessionIds = cloudSyncedLocalAgentSessionIds(state);
  const targetsBySessionId = cloudAgentTargetsBySessionId(state, syncedSessionIds);

  return state.sessions
    .filter((session) => (
      syncedSessionIds.has(session.id)
      && session.status === 'active'
    ))
    .map((session) => {
      const target = options.identitySyncedSessionIds?.has(session.id)
        ? undefined
        : targetsBySessionId.get(session.id);
      const remote = remoteBySessionId.get(session.id) ?? null;
      const title = cleanText(session.title);
      const desiredTitle = title && !isGenericSessionTitle(title)
        ? title
        : null;
      const createConversation = !remote;
      const remoteCreatedAtMs = remote
        ? Date.parse(remote.created_at)
        : Number.NaN;
      const interruptedRecentRecovery = Boolean(
        remote
        && remote.latest_message_sequence > 0
        && Number.isFinite(remoteCreatedAtMs)
        && nowMs - remoteCreatedAtMs
          <= RECENT_INTERRUPTED_RECOVERY_WINDOW_MS
        && nowMs >= remoteCreatedAtMs
        && (recoverableMessageCountBySessionId.get(session.id) ?? 0)
          > remote.latest_message_sequence,
      );
      const recoverHistory = recoverableMessageSessionIds.has(session.id)
        && (
          !remote
          || remote.latest_message_sequence === 0
          || options.pendingRecoverySessionIds?.has(session.id)
          || interruptedRecentRecovery
        );
      return {
        sessionId: session.id,
        title: desiredTitle,
        createConversation,
        recoverHistory,
        ...target,
      };
    })
    .filter((plan) => (
      plan.createConversation
      || plan.recoverHistory
      || Boolean(plan.targetAgentId)
    ))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export function seedCloudSelfAgentForwardSyncLedger(
  state: CanonicalSessionState,
  ledger: CloudSelfAgentSyncLedger,
  syncedAtMs: number = Date.now(),
): { ledger: CloudSelfAgentSyncLedger; changed: boolean } {
  const selfAgentSessionIds = cloudSyncedLocalAgentSessionIds(state);
  if (selfAgentSessionIds.size === 0) {
    return { ledger, changed: false };
  }

  let changed = false;
  const next: CloudSelfAgentSyncLedger = { ...ledger };
  for (const message of state.messages) {
    if (
      !selfAgentSessionIds.has(message.sessionId)
      || !selfAgentMessageDeliveryState(message)
    ) continue;
    if (shouldSkipSelfAgentForwardSyncMessage(message)) continue;
    if (next[message.id]) continue;
    next[message.id] = {
      cloudMessageId: null,
      syncedAtMs,
      skippedLocalBackfill: true,
    };
    changed = true;
  }
  return { ledger: changed ? next : ledger, changed };
}

export function planCloudSelfAgentSync(
  state: CanonicalSessionState,
  ledger: CloudSelfAgentSyncLedger,
  options: {
    allowLocalBackfill?: boolean;
    createdAfterMs?: number | null;
    recoverSessionIds?: ReadonlySet<string>;
    remoteClientMessageIds?: ReadonlySet<string>;
  } = {},
): CloudSelfAgentSyncOperation[] {
  if (options.allowLocalBackfill === false) return [];
  const selfAgentSessionIds = cloudSyncedLocalAgentSessionIds(state);
  if (selfAgentSessionIds.size === 0) return [];
  const targetBySessionId = cloudAgentTargetsBySessionId(state, selfAgentSessionIds);

  const messagesBySession =
    new Map<string, CanonicalSessionMessage[]>();
  for (const message of state.messages) {
    if (!selfAgentSessionIds.has(message.sessionId)) continue;
    const recoveringMissingChatSession = Boolean(
      options.recoverSessionIds?.has(message.sessionId),
    );
    const deliveryState = selfAgentMessageDeliveryState(message);
    if (!deliveryState) continue;
    if (
      !recoveringMissingChatSession
      && options.createdAfterMs != null
      && message.createdAtMs <= options.createdAfterMs
    ) continue;
    if (shouldSkipSelfAgentForwardSyncMessage(
      message,
      recoveringMissingChatSession,
    )) continue;
    const text = selfAgentMessageText(message, deliveryState);
    if (!text) continue;
    const bucket = messagesBySession.get(message.sessionId) ?? [];
    bucket.push(message);
    messagesBySession.set(message.sessionId, bucket);
  }

  const operations: CloudSelfAgentSyncOperation[] = [];
  for (const [sessionId, messages] of messagesBySession.entries()) {
    const target = targetBySessionId.get(sessionId);
    const sorted = [...messages].sort((left, right) => (
      left.sequenceNum - right.sequenceNum
      || left.createdAtMs - right.createdAtMs
      || left.id.localeCompare(right.id)
    ));
    let lastUserMessageId: string | null = null;
    for (const message of sorted) {
      if (message.senderRole === 'user') {
        lastUserMessageId = message.id;
        const content = objectContent(message.content);
        const queuedState = contentText(content, 'queueState') || contentText(content, 'deliveryState') || message.status;
        const cancelledWhileQueued = content.queuedMessage === true && queuedState === 'cancelled';
        if (
          options.recoverSessionIds?.has(message.sessionId)
          || !ledger[message.id]
          || (queuedState === 'queued' && !ledger[cloudSelfAgentProcessingLedgerKey(message.id)])
          || (cancelledWhileQueued && !ledger[queuedCancellationLedgerKey(message.id)])
        ) {
          const operation: CloudSelfAgentSyncOperation = {
            localMessageId: message.id,
            sessionId,
            role: 'user',
            text: cleanText(message.contentText),
            parentLocalMessageId: null,
            createdAtMs: message.createdAtMs,
            deliveryState: 'sent',
            ...(queuedState === 'queued' ? { queued: true } : {}),
            ...(cancelledWhileQueued ? {
              cancelledWhileQueued: true,
              cancelledAtMs: typeof content.queueUpdatedAtMs === 'number' ? content.queueUpdatedAtMs : message.updatedAtMs,
            } : {}),
            ...target,
          };
          if (queuedState === 'queued' || cancelledWhileQueued || !options.remoteClientMessageIds?.has(
            cloudSelfAgentOperationClientMessageId(operation),
          )) operations.push(operation);
        }
        continue;
      }
      const isAgentMessage = message.messageKind === 'agent-turn'
        || message.senderRole.includes('agent');
      if (
        !isAgentMessage
        || (
          !options.recoverSessionIds?.has(message.sessionId)
          && ledger[message.id]
        )
      ) continue;
      const parentLocalMessageId = explicitSelfAgentParentMessageId(message)
        || lastUserMessageId;
      if (!parentLocalMessageId) continue;
      const deliveryState = selfAgentMessageDeliveryState(message);
      if (!deliveryState || deliveryState === 'sent') continue;
      const operation: CloudSelfAgentSyncOperation = {
        localMessageId: message.id,
        sessionId,
        role: 'agent',
        text: selfAgentMessageText(message, deliveryState),
        parentLocalMessageId,
        createdAtMs: message.createdAtMs,
        deliveryState,
        ...target,
      };
      if (!options.remoteClientMessageIds?.has(
        cloudSelfAgentOperationClientMessageId(operation),
      )) operations.push(operation);
    }
  }

  return operations.sort((left, right) => {
    if (left.sessionId !== right.sessionId) {
      return left.sessionId.localeCompare(right.sessionId);
    }
    return 0;
  });
}
