import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { ProviderFactory, RoomProvider } from '../../src/features/documents/editor/documentRoom';

type Listener = (...args: never[]) => void;

/**
 * An in-memory collaboration room standing in for the socket: each provider
 * syncs its Y document with the room's through `Y.applyUpdate`, and awareness
 * states travel between the connected providers. `drop` closes a connection
 * the way the server would.
 */
export function createMemoryCollabRoom() {
  const server = new Y.Doc();
  const connected = new Set<MemoryProvider>();
  const opened: Array<{ serverUrl: string; roomName: string; ticket: string }> = [];

  class MemoryProvider implements RoomProvider {
    readonly awareness: Awareness;
    params: Record<string, string>;
    shouldConnect = false;
    synced = false;
    private readonly listeners = new Map<string, Set<Listener>>();
    private unbind: (() => void) | null = null;

    constructor(readonly serverUrl: string, readonly roomName: string, readonly doc: Y.Doc, params: Record<string, string>) {
      this.params = params;
      this.awareness = new Awareness(doc);
      this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'remote' || !connected.has(this)) return;
        const update = encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]);
        connected.forEach((peer) => { if (peer !== this) applyAwarenessUpdate(peer.awareness, update, 'remote'); });
      });
    }

    on(event: string, listener: Listener) {
      const set = this.listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(event, set);
    }

    off(event: string, listener: Listener) {
      this.listeners.get(event)?.delete(listener);
    }

    private emit(event: string, ...args: unknown[]) {
      this.listeners.get(event)?.forEach((listener) => (listener as (...values: unknown[]) => void)(...args));
    }

    connect() {
      this.shouldConnect = true;
      if (connected.has(this)) return;
      opened.push({ serverUrl: this.serverUrl, roomName: this.roomName, ticket: this.params.ticket ?? '' });
      // Asynchronous like a socket: the first sync lands on a later tick.
      setTimeout(() => {
        if (!this.shouldConnect) return;
        connected.add(this);
        Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(this.doc)), 'remote');
        Y.applyUpdate(server, Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(server)), this);
        const toServer = (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(server, update, this); };
        const fromServer = (update: Uint8Array, origin: unknown) => { if (origin !== this) Y.applyUpdate(this.doc, update, 'remote'); };
        this.doc.on('update', toServer);
        server.on('update', fromServer);
        this.unbind = () => { this.doc.off('update', toServer); server.off('update', fromServer); };
        connected.forEach((peer) => {
          if (peer === this) return;
          applyAwarenessUpdate(this.awareness, encodeAwarenessUpdate(peer.awareness, [peer.doc.clientID]), 'remote');
          applyAwarenessUpdate(peer.awareness, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]), 'remote');
        });
        this.synced = true;
        this.emit('sync', true);
      }, 0);
    }

    /** Closes the connection as the server would (`code` like 1006 or 4401). */
    close(code = 1006) {
      if (!connected.has(this)) return;
      connected.delete(this);
      this.unbind?.();
      this.emit('connection-close', { code });
      this.synced = false;
      removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID), 'remote');
      connected.forEach((peer) => removeAwarenessStates(peer.awareness, [this.doc.clientID], 'remote'));
    }

    disconnect() {
      this.shouldConnect = false;
      this.close();
    }

    destroy() {
      this.disconnect();
      this.awareness.destroy();
    }
  }

  const providers: MemoryProvider[] = [];
  const createProvider: ProviderFactory = (serverUrl, roomName, doc, params) => {
    const provider = new MemoryProvider(serverUrl, roomName, doc, params);
    providers.push(provider);
    return provider;
  };
  return { server, providers, opened, createProvider, fragment: () => server.getXmlFragment('document') };
}
