import { WebsocketProvider } from 'y-websocket';

import type { ProviderFactory } from '@/features/documents/editor/documentRoom';

import type { NativeBridge } from './nativeBridge';
import { nativeWebSocketClass } from './nativeSocket';

/** `y-websocket` over the app's socket, without its own reconnects (each connection needs a new ticket), as on the Mac. */
export function nativeProviderFactory(bridge: NativeBridge): ProviderFactory {
  const WebSocketPolyfill = nativeWebSocketClass(bridge) as unknown as typeof WebSocket;
  return (serverUrl, roomName, doc, params) => new WebsocketProvider(serverUrl, roomName, doc, {
    connect: false,
    params,
    disableBc: true,
    shouldReconnect: () => false,
    WebSocketPolyfill,
  });
}
