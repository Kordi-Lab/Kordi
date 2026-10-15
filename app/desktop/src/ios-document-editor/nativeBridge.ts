/**
 * The page side of the iPhone document editor's bridge. The page never talks
 * to the network itself: requests and the collaboration socket go through the
 * app, which adds the session token and opens the socket natively.
 */

export type NativeMessage = { type: string } & Record<string, unknown>;
export type NativePost = (message: NativeMessage) => void;
export type NativeResponse = { status: number; body: string };
export type NativeReply = { status?: number; body?: string; error?: string };
export type SocketEventKind = 'open' | 'message' | 'close' | 'error';
export type SocketListener = (kind: SocketEventKind, payload: unknown) => void;

type Pending = { resolve: (value: NativeResponse) => void; reject: (error: Error) => void };

export const MESSAGE_HANDLER = 'kordiDocumentEditor';

export class NativeBridge {
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly sockets = new Map<string, SocketListener>();
  private readonly post: NativePost;

  constructor(post: NativePost) {
    this.post = post;
  }

  send(message: NativeMessage) {
    this.post(message);
  }

  private id(prefix: string) {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  /** One HTTP request to a document route; the app answers with the status and body text. */
  request(method: string, path: string, body?: string): Promise<NativeResponse> {
    const id = this.id('r');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'request', id, method, path, ...(body === undefined ? {} : { body }) });
    });
  }

  /** Requests the app has not answered yet. */
  get pendingRequests() {
    return this.pending.size;
  }

  reply(id: string, result: NativeReply) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (result.error || typeof result.status !== 'number') entry.reject(new Error(result.error || 'Could not reach Kordi Cloud.'));
    else entry.resolve({ status: result.status, body: result.body ?? '' });
  }

  openSocket(path: string, listener: SocketListener) {
    const id = this.id('s');
    this.sockets.set(id, listener);
    this.post({ type: 'socket.open', socket: id, path });
    return id;
  }

  sendSocket(id: string, bytes: Uint8Array) {
    if (this.sockets.has(id)) this.post({ type: 'socket.send', socket: id, data: bytesToBase64(bytes) });
  }

  closeSocket(id: string) {
    if (!this.sockets.delete(id)) return;
    this.post({ type: 'socket.close', socket: id });
  }

  socketEvent(id: string, kind: SocketEventKind, payload: unknown) {
    const listener = this.sockets.get(id);
    if (!listener) return;
    if (kind === 'close') this.sockets.delete(id);
    listener(kind, payload);
  }
}

/** The WKWebView message handler, when the page runs inside the app. */
export function webkitPost(): NativePost | null {
  const handler = (globalThis as { webkit?: { messageHandlers?: Record<string, { postMessage(message: unknown): void }> } })
    .webkit?.messageHandlers?.[MESSAGE_HANDLER];
  return handler ? (message) => handler.postMessage(message) : null;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
