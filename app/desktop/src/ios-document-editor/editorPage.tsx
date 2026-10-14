import type { Editor } from '@tiptap/core';
import { createRoot, type Root } from 'react-dom/client';

import { notifyDocumentSyncEvents } from '@/features/documents/documentSyncEvents';

import { runEditorCommand } from './editorCommands';
import { IosDocumentEditor, type EditorConfig, type EditorFlush } from './IosDocumentEditor';
import { NativeBridge, type NativePost, type NativeReply, type SocketEventKind } from './nativeBridge';
import { createNativeDocumentApi } from './nativeDocumentApi';

/** How long closing waits for the last save or snapshot to reach the app. */
const CLOSE_WAIT_MS = 4_000;

/** Calls the app makes into the page. */
export type EditorPage = {
  start(config: EditorConfig): void;
  command(name: string, value?: string): boolean;
  documentUpdated(payload: { attachmentId: string; revision: number; change?: string }): void;
  setAccent(color: string): void;
  /** Saves what is pending, leaves the room (the room's writer saves a snapshot), and waits for those requests. */
  close(): Promise<void>;
};

/** Calls the app makes to answer the page. */
export type NativeReceiver = {
  reply(id: string, result: NativeReply): void;
  socket(id: string, kind: SocketEventKind, payload?: unknown): void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createEditorPage(post: NativePost, container: HTMLElement): { page: EditorPage; receiver: NativeReceiver; bridge: NativeBridge } {
  const bridge = new NativeBridge(post);
  const api = createNativeDocumentApi(bridge);
  const flushRef: EditorFlush = { current: null };
  let editor: Editor | null = null;
  let root: Root | null = null;

  const page: EditorPage = {
    start(config) {
      if (root) return;
      root = createRoot(container);
      root.render(<IosDocumentEditor api={api} bridge={bridge} config={config} flushRef={flushRef} onEditor={(next) => { editor = next; }} />);
    },
    command(name, value) {
      if (!editor || editor.isDestroyed) return false;
      return runEditorCommand(editor, name, value);
    },
    documentUpdated(payload) {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload }]);
    },
    setAccent(color) {
      if (/^#[0-9a-f]{3,8}$/i.test(color)) container.ownerDocument.documentElement.style.setProperty('--app-chat-accent', color);
    },
    async close() {
      await flushRef.current?.();
      root?.unmount();
      root = null;
      const deadline = Date.now() + CLOSE_WAIT_MS;
      // Leaving the room may start a snapshot save; let the app finish it before the page goes away.
      await sleep(0);
      while (bridge.pendingRequests > 0 && Date.now() < deadline) await sleep(50);
    },
  };
  const receiver: NativeReceiver = {
    reply: (id, result) => bridge.reply(id, result),
    socket: (id, kind, payload) => bridge.socketEvent(id, kind, payload),
  };
  return { page, receiver, bridge };
}
