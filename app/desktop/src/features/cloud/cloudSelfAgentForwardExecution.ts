import type {
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  encodeCloudAgentResponse,
  type CloudAgentExecutionSnapshot,
} from './cloudAgentMessages';
import { finalizeCloudAgentExecutionSnapshot } from './cloudAgentExecutionTrace';
import {
  cloudSelfAgentOperationClientMessageId,
  queuedCancellationLedgerKey,
  type CloudSelfAgentSyncLedger,
  type CloudSelfAgentSyncOperation,
} from './cloudSelfAgentForwardSync';
import { cloudSelfAgentProcessingLedgerKey } from './cloudSelfAgentIdentity';
export { cloudSelfAgentProcessingLedgerKey } from './cloudSelfAgentIdentity';
import { encodeCloudDirectMessageEnvelope } from './cloudDirectMessages';

export const CLOUD_SELF_AGENT_HEARTBEAT_MS = 30_000;
export const CLOUD_SELF_AGENT_EXECUTION_STREAM_MS = 5_000;

function stableClientMessageId(
  operation: CloudSelfAgentSyncOperation,
  kind: 'request' | 'processing' | 'response',
): string {
  if (kind !== 'processing') {
    return cloudSelfAgentOperationClientMessageId(operation);
  }
  const requestId = operation.parentLocalMessageId
    ?? operation.localMessageId;
  return `self-agent:${operation.sessionId}:${requestId}:${kind}`;
}

export async function publishCloudSelfAgentHeartbeat({
  accountId,
  assistantText = '',
  client,
  cloudRequestMessageId,
  execution,
  localRequestMessageId,
  nowMs = Date.now(),
  sessionId,
  token,
}: {
  accountId: string;
  assistantText?: string;
  client: Pick<CloudAuthClient, 'sendMessage'>;
  cloudRequestMessageId: string;
  execution?: CloudAgentExecutionSnapshot;
  localRequestMessageId: string;
  nowMs?: number;
  sessionId: string;
  token: string;
}): Promise<CloudMessage> {
  const heartbeatBucket = Math.floor(
    nowMs / CLOUD_SELF_AGENT_HEARTBEAT_MS,
  );
  return client.sendMessage(
    token,
    accountId,
    encodeCloudAgentResponse({
      requestId: cloudRequestMessageId,
      text: assistantText.trim() || 'processing...',
      deliveryState: 'processing',
      execution,
    }),
    {
      sessionId,
      clientCreatedAt: new Date(nowMs).toISOString(),
      clientMessageId:
        `self-agent:${sessionId}:${localRequestMessageId}`
        + `:processing:${heartbeatBucket}`,
    },
  );
}

export async function publishCloudSelfAgentExecutionSnapshot({
  accountId,
  assistantText,
  client,
  cloudRequestMessageId,
  execution,
  localRequestMessageId,
  revision,
  sessionId,
  token,
}: {
  accountId: string;
  assistantText: string;
  client: Pick<CloudAuthClient, 'sendMessage'>;
  cloudRequestMessageId: string;
  execution: CloudAgentExecutionSnapshot;
  localRequestMessageId: string;
  revision: number;
  sessionId: string;
  token: string;
}): Promise<CloudMessage> {
  return client.sendMessage(
    token,
    accountId,
    encodeCloudAgentResponse({
      requestId: cloudRequestMessageId,
      text: assistantText.trim() || 'processing...',
      deliveryState: 'processing',
      execution,
    }),
    {
      sessionId,
      clientCreatedAt: new Date(execution.updatedAtMs).toISOString(),
      clientMessageId:
        `self-agent:${sessionId}:${localRequestMessageId}`
        + `:execution:${revision}`,
    },
  );
}

export async function publishCloudSelfAgentOperations({
  accountId,
  client,
  ledger,
  mergeMessage,
  onRequestPublished,
  operations,
  saveLedger,
  shouldContinue = () => true,
  shouldMergeMessage = () => true,
  messageKindForOperation = () => null,
  shouldPublishProcessing = () => true,
  executionSnapshotForOperation = () => undefined,
  token,
}: {
  accountId: string;
  client: Pick<CloudAuthClient, 'sendMessage'>;
  ledger: CloudSelfAgentSyncLedger;
  mergeMessage: (message: CloudMessage) => void;
  onRequestPublished?: (
    message: CloudMessage,
    operation: CloudSelfAgentSyncOperation,
  ) => void;
  operations: readonly CloudSelfAgentSyncOperation[];
  saveLedger: (ledger: CloudSelfAgentSyncLedger) => void;
  shouldContinue?: () => boolean;
  shouldMergeMessage?: (
    operation: CloudSelfAgentSyncOperation,
  ) => boolean;
  messageKindForOperation?: (
    operation: CloudSelfAgentSyncOperation,
  ) => string | null;
  shouldPublishProcessing?: (
    operation: CloudSelfAgentSyncOperation,
  ) => boolean;
  executionSnapshotForOperation?: (
    operation: CloudSelfAgentSyncOperation,
  ) => CloudAgentExecutionSnapshot | undefined;
  token: string;
}): Promise<void> {
  for (const operation of operations) {
    if (!shouldContinue()) return;
    if (ledger[operation.localMessageId] && !operation.cancelledWhileQueued
      && !(operation.queued && !ledger[cloudSelfAgentProcessingLedgerKey(operation.localMessageId)])) continue;
    if (operation.role === 'user') {
      const messageKind = messageKindForOperation(operation);
      const body = operation.targetAgentId && operation.targetAgentName
        ? encodeCloudDirectMessageEnvelope({
            schemaVersion: 1,
            kind: 'message',
            text: operation.text,
            targetCloudAgentId: operation.targetAgentId,
            targetCloudAgentName: operation.targetAgentName,
            targetCloudAgentOwnerAccountId: accountId,
          })
        : operation.text;
      const request = ledger[operation.localMessageId]?.cloudMessageId ? null : await client.sendMessage(
        token,
        accountId,
        body,
        {
          sessionId: operation.sessionId,
          clientCreatedAt: new Date(operation.createdAtMs).toISOString(),
          clientMessageId: stableClientMessageId(operation, 'request'),
          messageKind,
          canonicalHistoryLocalMessageId: messageKind
            ? operation.localMessageId
            : null,
        },
      );
      if (request) {
        ledger[operation.localMessageId] = { cloudMessageId: request.messageId, syncedAtMs: Date.now() };
        saveLedger(ledger);
        if (shouldMergeMessage(operation)) mergeMessage(request);
        onRequestPublished?.(request, operation);
      }
      const requestId = ledger[operation.localMessageId]?.cloudMessageId;
      if (!requestId) continue;
      if (operation.cancelledWhileQueued) {
        const cancellationKey = queuedCancellationLedgerKey(operation.localMessageId);
        if (ledger[cancellationKey]) continue;
        const cancelled = await client.sendMessage(token, accountId, encodeCloudAgentResponse({
          requestId, text: 'Request canceled.', deliveryState: 'cancelled',
          execution: { phase: 'cancelled', summary: 'Request canceled', steps: [], updatedAtMs: operation.cancelledAtMs ?? operation.createdAtMs, completed: true },
        }), {
          sessionId: operation.sessionId,
          clientMessageId: `self-agent:${operation.sessionId}:${operation.localMessageId}:queued-cancelled`,
        });
        ledger[cancellationKey] = { cloudMessageId: cancelled.messageId, syncedAtMs: Date.now() };
        saveLedger(ledger);
        mergeMessage(cancelled);
        continue;
      }

      const processingLedgerKey = cloudSelfAgentProcessingLedgerKey(
        operation.localMessageId,
      );
      if (
        (operation.queued || shouldPublishProcessing(operation))
        && !ledger[processingLedgerKey]
      ) {
        if (!shouldContinue()) return;
        const processing = await client.sendMessage(
          token,
          accountId,
          encodeCloudAgentResponse({
            requestId,
            text: 'processing...',
            deliveryState: 'processing',
            execution: operation.queued
              ? { phase: 'queued', summary: 'Queued next', steps: [], updatedAtMs: operation.createdAtMs, completed: false }
              : executionSnapshotForOperation(operation),
          }),
          {
            sessionId: operation.sessionId,
            clientCreatedAt: new Date(
              operation.createdAtMs + 1,
            ).toISOString(),
            clientMessageId: stableClientMessageId(
              operation,
              'processing',
            ),
          },
        );
        ledger[processingLedgerKey] = {
          cloudMessageId: processing.messageId,
          syncedAtMs: Date.now(),
        };
        saveLedger(ledger);
        mergeMessage(processing);
      }
      continue;
    }

    const parentLocalMessageId = operation.parentLocalMessageId;
    const parentCloudMessageId = parentLocalMessageId
      ? ledger[parentLocalMessageId]?.cloudMessageId ?? null
      : null;
    if (!parentCloudMessageId || !shouldContinue()) continue;
    const response = await client.sendMessage(
      token,
      accountId,
      encodeCloudAgentResponse({
        requestId: parentCloudMessageId,
        text: operation.text,
        deliveryState: operation.deliveryState === 'sent'
          ? 'complete'
          : operation.deliveryState,
        execution: finalizeCloudAgentExecutionSnapshot(
          executionSnapshotForOperation(operation),
          operation.deliveryState === 'sent'
            ? 'complete'
            : operation.deliveryState,
          operation.createdAtMs,
        ),
      }),
      {
        sessionId: operation.sessionId,
        clientCreatedAt: new Date(operation.createdAtMs).toISOString(),
        clientMessageId: stableClientMessageId(operation, 'response'),
        messageKind: messageKindForOperation(operation),
        canonicalHistoryLocalMessageId: messageKindForOperation(operation)
          ? operation.localMessageId
          : null,
      },
    );
    ledger[operation.localMessageId] = {
      cloudMessageId: response.messageId,
      syncedAtMs: Date.now(),
    };
    if (parentLocalMessageId) {
      delete ledger[cloudSelfAgentProcessingLedgerKey(parentLocalMessageId)];
    }
    saveLedger(ledger);
    if (shouldMergeMessage(operation)) mergeMessage(response);
  }
}
