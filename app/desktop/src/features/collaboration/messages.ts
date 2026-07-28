export const COLLABORATION_MESSAGE_DIRECTION_OUTBOUND = 'outbound' as const;
export const COLLABORATION_MESSAGE_DIRECTION_INBOUND = 'inbound' as const;
export const COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE = 'outbound-response' as const;
export const COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE = 'inbound-response' as const;

export type CollaborationMessageDirection =
  | typeof COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
  | typeof COLLABORATION_MESSAGE_DIRECTION_INBOUND
  | typeof COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
  | typeof COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE;

export function isInboundCollaborationMessageDirection(direction: string) {
  return direction === COLLABORATION_MESSAGE_DIRECTION_INBOUND
    || direction === COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE;
}

export function isOutboundCollaborationMessageDirection(direction: string) {
  return direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
    || direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
}
