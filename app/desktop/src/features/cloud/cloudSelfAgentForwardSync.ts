import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from './cloudAgentMessages';

const CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX =
  'kordi.cloud.selfAgentSync.v2:';
const CLOUD_SELF_AGENT_FORWARD_BASELINE_PREFIX =
  'kordi.cloud.selfAgentForwardBaseline.v1:';
const CLOUD_SELF_AGENT_FORWARD_CUTOFF_PREFIX =
  'kordi.cloud.selfAgentForwardCutoff.v1:';

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
    const raw = window.localStorage.getItem(
      selfAgentSyncLedgerKey(accountId),
    );
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
  } catch {
    // Best effort. A failed ledger write may cause a future duplicate sync,
    // but should not block local chat or Cloud refresh.
  }
}

function isTerminalSelfAgentMessage(
  message: CanonicalSessionMessage,
): boolean {
  const status = cleanText(message.status).toLowerCase();
  return ![
    '',
    'sending',
    'processing',
    'failed',
    'cancelled',
  ].includes(status);
}

function localSelfAgentSessionIds(
  state: CanonicalSessionState,
): Set<string> {
  return new Set(
    state.sessions
      .filter((session) => (
        session.kind === 'self-agent'
        && !session.id.startsWith(CLOUD_AGENT_RUNTIME_SESSION_PREFIX)
      ))
      .map((session) => session.id),
  );
}

function shouldSkipSelfAgentForwardSyncMessage(
  message: CanonicalSessionMessage,
): boolean {
  return message.sourceTransport === 'canonical-fork-snapshot'
    || message.sourceTransport === 'cloud-group-fork-snapshot'
    || message.sourceTransport === 'cloud-self-agent'
    || message.id.startsWith('msg:cloud:self:');
}

export function seedCloudSelfAgentForwardSyncLedger(
  state: CanonicalSessionState,
  ledger: CloudSelfAgentSyncLedger,
  syncedAtMs: number = Date.now(),
): { ledger: CloudSelfAgentSyncLedger; changed: boolean } {
  const selfAgentSessionIds = localSelfAgentSessionIds(state);
  if (selfAgentSessionIds.size === 0) {
    return { ledger, changed: false };
  }

  let changed = false;
  const next: CloudSelfAgentSyncLedger = { ...ledger };
  for (const message of state.messages) {
    if (
      !selfAgentSessionIds.has(message.sessionId)
      || !isTerminalSelfAgentMessage(message)
    ) continue;
    if (shouldSkipSelfAgentForwardSyncMessage(message)) continue;
    if (!cleanText(message.contentText) || next[message.id]) continue;
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
  } = {},
): CloudSelfAgentSyncOperation[] {
  if (options.allowLocalBackfill === false) return [];
  const selfAgentSessionIds = localSelfAgentSessionIds(state);
  if (selfAgentSessionIds.size === 0) return [];

  const messagesBySession =
    new Map<string, CanonicalSessionMessage[]>();
  for (const message of state.messages) {
    if (
      !selfAgentSessionIds.has(message.sessionId)
      || !isTerminalSelfAgentMessage(message)
    ) continue;
    if (
      options.createdAfterMs != null
      && message.createdAtMs <= options.createdAfterMs
    ) continue;
    if (shouldSkipSelfAgentForwardSyncMessage(message)) continue;
    const text = cleanText(message.contentText);
    if (!text) continue;
    const bucket = messagesBySession.get(message.sessionId) ?? [];
    bucket.push(message);
    messagesBySession.set(message.sessionId, bucket);
  }

  const operations: CloudSelfAgentSyncOperation[] = [];
  for (const [sessionId, messages] of messagesBySession.entries()) {
    const sorted = [...messages].sort((left, right) => (
      left.sequenceNum - right.sequenceNum
      || left.createdAtMs - right.createdAtMs
      || left.id.localeCompare(right.id)
    ));
    let lastUserMessageId: string | null = null;
    for (const message of sorted) {
      if (message.senderRole === 'user') {
        lastUserMessageId = message.id;
        if (!ledger[message.id]) {
          operations.push({
            localMessageId: message.id,
            sessionId,
            role: 'user',
            text: cleanText(message.contentText),
            parentLocalMessageId: null,
            createdAtMs: message.createdAtMs,
          });
        }
        continue;
      }
      const isAgentMessage = message.messageKind === 'agent-turn'
        || message.senderRole.includes('agent');
      if (
        !isAgentMessage
        || !lastUserMessageId
        || ledger[message.id]
      ) continue;
      operations.push({
        localMessageId: message.id,
        sessionId,
        role: 'agent',
        text: cleanText(message.contentText),
        parentLocalMessageId: lastUserMessageId,
        createdAtMs: message.createdAtMs,
      });
    }
  }

  return operations.sort((left, right) => {
    if (left.sessionId !== right.sessionId) {
      return left.sessionId.localeCompare(right.sessionId);
    }
    return 0;
  });
}
