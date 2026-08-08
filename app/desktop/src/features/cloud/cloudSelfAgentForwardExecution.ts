import type {
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import { encodeCloudAgentResponse } from './cloudAgentMessages';
import type {
  CloudSelfAgentSyncLedger,
  CloudSelfAgentSyncOperation,
} from './cloudSelfAgentForwardSync';

const PROCESSING_LEDGER_PREFIX = 'processing:';
export const CLOUD_SELF_AGENT_HEARTBEAT_MS = 30_000;

function stableClientMessageId(
  operation: CloudSelfAgentSyncOperation,
  kind: 'request' | 'processing' | 'response',
): string {
  const requestId = operation.parentLocalMessageId
    ?? operation.localMessageId;
  return `self-agent:${operation.sessionId}:${requestId}:${kind}`;
}

export function cloudSelfAgentProcessingLedgerKey(
  localRequestMessageId: string,
): string {
  return `${PROCESSING_LEDGER_PREFIX}${localRequestMessageId}`;
}

export async function publishCloudSelfAgentHeartbeat({
  accountId,
  client,
  cloudRequestMessageId,
  localRequestMessageId,
  nowMs = Date.now(),
  sessionId,
  token,
}: {
  accountId: string;
  client: Pick<CloudAuthClient, 'sendMessage'>;
  cloudRequestMessageId: string;
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
      text: 'processing...',
      deliveryState: 'processing',
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

export async function publishCloudSelfAgentOperations({
  accountId,
  client,
  ledger,
  mergeMessage,
  onRequestPublished,
  operations,
  saveLedger,
  shouldContinue = () => true,
  token,
}: {
  accountId: string;
  client: Pick<CloudAuthClient, 'sendMessage'>;
  ledger: CloudSelfAgentSyncLedger;
  mergeMessage: (message: CloudMessage) => void;
  onRequestPublished?: (message: CloudMessage) => void;
  operations: readonly CloudSelfAgentSyncOperation[];
  saveLedger: (ledger: CloudSelfAgentSyncLedger) => void;
  shouldContinue?: () => boolean;
  token: string;
}): Promise<void> {
  for (const operation of operations) {
    if (!shouldContinue()) return;
    if (ledger[operation.localMessageId]) continue;
    if (operation.role === 'user') {
      const request = await client.sendMessage(
        token,
        accountId,
        operation.text,
        {
          sessionId: operation.sessionId,
          clientCreatedAt: new Date(operation.createdAtMs).toISOString(),
          clientMessageId: stableClientMessageId(operation, 'request'),
        },
      );
      ledger[operation.localMessageId] = {
        cloudMessageId: request.messageId,
        syncedAtMs: Date.now(),
      };
      saveLedger(ledger);
      mergeMessage(request);
      onRequestPublished?.(request);

      const processingLedgerKey = cloudSelfAgentProcessingLedgerKey(
        operation.localMessageId,
      );
      if (!ledger[processingLedgerKey]) {
        if (!shouldContinue()) return;
        const processing = await client.sendMessage(
          token,
          accountId,
          encodeCloudAgentResponse({
            requestId: request.messageId,
            text: 'processing...',
            deliveryState: 'processing',
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
      }),
      {
        sessionId: operation.sessionId,
        clientCreatedAt: new Date(operation.createdAtMs).toISOString(),
        clientMessageId: stableClientMessageId(operation, 'response'),
      },
    );
    ledger[operation.localMessageId] = {
      cloudMessageId: response.messageId,
      syncedAtMs: Date.now(),
    };
    saveLedger(ledger);
    mergeMessage(response);
  }
}
