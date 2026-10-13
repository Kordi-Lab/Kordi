import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { DocumentShareApi } from '../documentShareApi';
import type { DocumentResponse } from '../documentShareTypes';
import type { DocumentPresencePeer } from '../documentPresence';

export type CollabUser = { name: string; color: string; accountId: string };
export type RoomPeer = DocumentPresencePeer;
export type RoomStatus = 'connecting' | 'connected' | 'offline';

/** The parts of `y-websocket`'s provider the room uses; tests pass an in-memory one. */
export type RoomProvider = {
  awareness: Awareness;
  params: Record<string, string>;
  shouldConnect: boolean;
  synced: boolean;
  connect(): void;
  disconnect(): void;
  destroy(): void;
  on(event: string, listener: (...args: never[]) => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
};

export type ProviderFactory = (serverUrl: string, roomName: string, doc: Y.Doc, params: Record<string, string>) => RoomProvider;

/** `y-websocket` without its own reconnects: every connection needs a fresh single-use ticket. */
export const websocketProviderFactory: ProviderFactory = (serverUrl, roomName, doc, params) => new WebsocketProvider(serverUrl, roomName, doc, {
  connect: false,
  params,
  disableBc: true,
  shouldReconnect: () => false,
});

export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
export const SNAPSHOT_DEBOUNCE_MS = 2_000;
export const ROOM_FIELD = 'document';

export type DocumentRoomOptions = {
  api: DocumentShareApi;
  attachmentId: string;
  user: CollabUser;
  createProvider?: ProviderFactory;
  /** Markdown (with block id comments) of the room's current content, for snapshots. */
  markdown: () => string | null;
  /** Index-to-id map a document's first stamped write carries. */
  blockIds?: () => Record<string, string> | null;
  onChange?: () => void;
  onSnapshot?: (document: DocumentResponse) => void;
  /** Shorter waits in tests. */
  timing?: { reconnectDelaysMs?: readonly number[]; snapshotDelayMs?: number };
};

/**
 * One collaboration room: a Y document, a socket per single-use ticket with a
 * reconnect loop (1, 2, 5, 10 s), the people present, and the Markdown
 * snapshots the connected editor with the smallest client id writes.
 */
export class DocumentRoom {
  readonly ydoc = new Y.Doc();
  provider: RoomProvider | null = null;
  status: RoomStatus = 'connecting';
  /** True once a connection finished its first sync. */
  synced = false;
  staleRevision = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtySinceSnapshot = false;
  private destroyed = false;
  private readonly options: DocumentRoomOptions;

  constructor(options: DocumentRoomOptions) {
    this.options = options;
    this.ydoc.on('update', this.onUpdate);
  }

  get fragment() {
    return this.ydoc.getXmlFragment(ROOM_FIELD);
  }

  start() {
    void this.connect();
  }

  private notify() {
    this.options.onChange?.();
  }

  private async connect() {
    this.retryTimer = null;
    if (this.destroyed) return;
    let ticket;
    try {
      ticket = await this.options.api.requestCollabTicket(this.options.attachmentId);
    } catch {
      this.status = 'offline';
      this.notify();
      this.scheduleRetry();
      return;
    }
    if (this.destroyed) return;
    this.staleRevision = Boolean(ticket.staleRevision);
    const socketUrl = `${this.options.api.socketBaseUrl()}${ticket.url}`;
    const cut = socketUrl.lastIndexOf('/');
    if (!this.provider) {
      const create = this.options.createProvider ?? websocketProviderFactory;
      this.provider = create(socketUrl.slice(0, cut), socketUrl.slice(cut + 1), this.ydoc, { ticket: ticket.ticket });
      this.provider.awareness.setLocalStateField('user', this.options.user);
      this.provider.on('sync', this.onSync);
      this.provider.on('connection-close', this.onClose);
      this.provider.awareness.on('change', this.onAwareness);
    } else {
      this.provider.params = { ticket: ticket.ticket };
    }
    this.provider.connect();
  }

  private scheduleRetry() {
    if (this.destroyed || this.retryTimer) return;
    const delays = this.options.timing?.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => { void this.connect(); }, delay);
  }

  private readonly onSync = (isSynced: boolean) => {
    if (!isSynced) return;
    this.synced = true;
    this.attempt = 0;
    this.status = 'connected';
    this.notify();
  };

  private readonly onClose = () => {
    // The ticket was single-use: never let the provider reconnect with it.
    if (this.provider) this.provider.shouldConnect = false;
    const wasWriter = this.isSnapshotWriter();
    this.status = 'offline';
    this.notify();
    if (wasWriter && this.dirtySinceSnapshot) void this.writeSnapshot();
    this.scheduleRetry();
  };

  private readonly onAwareness = () => this.notify();

  private readonly onUpdate = () => {
    this.dirtySinceSnapshot = true;
    if (this.status !== 'connected' || !this.isSnapshotWriter()) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => { void this.writeSnapshot(); }, this.options.timing?.snapshotDelayMs ?? SNAPSHOT_DEBOUNCE_MS);
  };

  /** The editor with the smallest awareness client id writes snapshots; the others do not. */
  isSnapshotWriter() {
    const ids = [...(this.provider?.awareness.getStates().keys() ?? []), this.ydoc.clientID];
    return Math.min(...ids) === this.ydoc.clientID;
  }

  peers(): RoomPeer[] {
    const states = this.provider?.awareness.getStates() ?? new Map<number, Record<string, unknown>>();
    return [...states.entries()].flatMap(([clientId, state]) => {
      const user = (state as { user?: Partial<CollabUser> }).user;
      if (clientId === this.ydoc.clientID || !user?.name) return [];
      return [{ clientId, name: user.name, color: user.color ?? '#847ac4', accountId: user.accountId ?? null }];
    });
  }

  /** Asks to seed an empty room from Markdown; `true` for exactly one caller. */
  async requestInit() {
    try {
      return (await this.options.api.initCollab(this.options.attachmentId)).initialize;
    } catch {
      return false;
    }
  }

  async writeSnapshot() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    const source = this.options.markdown();
    if (source === null) return;
    this.dirtySinceSnapshot = false;
    const blockIds = this.options.blockIds?.() ?? null;
    try {
      const result = await this.options.api.saveDocumentContent(this.options.attachmentId, { mode: 'snapshot', source, ...(blockIds ? { blockIds } : {}) });
      this.options.onSnapshot?.(result.document);
    } catch {
      this.dirtySinceSnapshot = true;
    }
  }

  destroy() {
    if (this.destroyed) return;
    if (this.status === 'connected' && this.isSnapshotWriter() && this.dirtySinceSnapshot) void this.writeSnapshot();
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.ydoc.off('update', this.onUpdate);
    if (this.provider) {
      this.provider.off('sync', this.onSync);
      this.provider.off('connection-close', this.onClose);
      this.provider.awareness.off('change', this.onAwareness);
      this.provider.destroy();
    }
    this.ydoc.destroy();
  }
}
