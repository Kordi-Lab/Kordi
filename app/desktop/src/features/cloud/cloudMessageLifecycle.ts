const CLOUD_MESSAGE_OPERATION_PREFIX = 'kordi-message-v2';

function randomOperationToken(): string {
  if (
    typeof globalThis.crypto !== 'undefined'
    && typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Identity for one logical producer operation. It is created before network
 * I/O and must be reused by every retry of that operation.
 */
export function createCloudMessageOperationId(scope = 'send'): string {
  const normalizedScope = scope.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${CLOUD_MESSAGE_OPERATION_PREFIX}:${normalizedScope || 'send'}:${randomOperationToken()}`;
}

/** One logical group publication has one independently idempotent delivery per recipient. */
export function cloudMessageRecipientOperationId(
  operationId: string,
  recipientAccountId: string,
): string {
  return `${operationId.trim()}:${recipientAccountId.trim()}`;
}

export function cloudAgentResponseOperationId(responseSourceId: string): string {
  return `${CLOUD_MESSAGE_OPERATION_PREFIX}:agent-response:${responseSourceId.trim()}`;
}

export function cloudAgentCancelOperationId(requestMessageId: string): string {
  return `${CLOUD_MESSAGE_OPERATION_PREFIX}:agent-cancel:${requestMessageId.trim()}`;
}
