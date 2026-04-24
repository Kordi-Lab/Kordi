export const BRIDGE_MESSAGE_DIRECTION_OUTBOUND = 'outbound' as const;
export const BRIDGE_MESSAGE_DIRECTION_INBOUND = 'inbound' as const;
export const BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE = 'outbound-response' as const;
export const BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE = 'inbound-response' as const;

export type BridgeMessageDirection =
  | typeof BRIDGE_MESSAGE_DIRECTION_OUTBOUND
  | typeof BRIDGE_MESSAGE_DIRECTION_INBOUND
  | typeof BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
  | typeof BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE;

export function isInboundBridgeMessageDirection(direction: string) {
  return direction === BRIDGE_MESSAGE_DIRECTION_INBOUND
    || direction === BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE;
}

export function isOutboundBridgeMessageDirection(direction: string) {
  return direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND
    || direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
}
