// Errors the connectors clients throw so the panel can react to them without
// matching on message text.

/** The person canceled a pending connect or act grant. */
export class ConnectorFlowCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

/** The server no longer has this connector; the panel should re-list. */
export class ConnectorGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorGoneError';
  }
}

export function isConnectorFlowCanceled(error: unknown): boolean {
  return error instanceof ConnectorFlowCanceledError;
}

export function isConnectorGone(error: unknown): boolean {
  return error instanceof ConnectorGoneError;
}
