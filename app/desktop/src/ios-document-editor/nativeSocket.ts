import { base64ToBytes, type NativeBridge } from './nativeBridge';

/** What the page passes as the socket origin; the app opens the real `wss://` socket. */
export const NATIVE_SOCKET_BASE = 'kordi-native://cloud';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type Handler<T> = ((event: T) => void) | null;

/** The path and query the app should open, from the URL `y-websocket` builds. */
export function socketPath(url: string) {
  return url.startsWith(NATIVE_SOCKET_BASE) ? url.slice(NATIVE_SOCKET_BASE.length) : url;
}

/**
 * The parts of `WebSocket` that `y-websocket` uses, carried by the app:
 * binary frames go out and come back as base64.
 */
export function nativeWebSocketClass(bridge: NativeBridge) {
  return class NativeWebSocket {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;
    readonly url: string;
    binaryType: BinaryType = 'arraybuffer';
    readyState = CONNECTING;
    onopen: Handler<Event> = null;
    onmessage: Handler<{ data: ArrayBuffer }> = null;
    onclose: Handler<{ code: number; reason: string; wasClean: boolean }> = null;
    onerror: Handler<Event> = null;
    private readonly id: string;

    constructor(url: string) {
      this.url = url;
      this.id = bridge.openSocket(socketPath(url), (kind, payload) => {
        if (kind === 'open') {
          this.readyState = OPEN;
          this.onopen?.(new Event('open'));
        } else if (kind === 'message' && typeof payload === 'string') {
          const bytes = base64ToBytes(payload);
          this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
        } else if (kind === 'error') {
          this.onerror?.(new Event('error'));
        } else if (kind === 'close') {
          this.readyState = CLOSED;
          const { code = 1006, reason = '' } = (payload ?? {}) as { code?: number; reason?: string };
          this.onclose?.({ code, reason, wasClean: code === 1000 });
        }
      });
    }

    send(data: ArrayBufferLike | ArrayBufferView) {
      if (this.readyState !== OPEN) return;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      bridge.sendSocket(this.id, bytes);
    }

    close() {
      if (this.readyState === CLOSED || this.readyState === CLOSING) return;
      this.readyState = CLOSED;
      bridge.closeSocket(this.id);
      // Reported later, as a browser does; `y-websocket` detaches the handler first when it closes on purpose.
      setTimeout(() => this.onclose?.({ code: 1000, reason: '', wasClean: true }), 0);
    }
  };
}
