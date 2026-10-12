import type { Editor } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { DocumentEditorSurface, type DocumentEditorProps, type SurfaceOutput } from './DocumentEditorSurface';
import { legacyIdsFor, reconciledContent } from './documentEditorSync';
import { newBlockId } from '../newBlockId';
import { DocumentRoom, ROOM_FIELD, type DocumentRoomOptions, type ProviderFactory } from './documentRoom';

export type { DocumentEditorHandle, DocumentEditorProps } from './DocumentEditorSurface';

/** How long an unused init grant lasts on the server; an empty room asks again after it. */
const INIT_RETRY_MS = 30_000;
/** Wait for the editor that provides the seed (it loads lazily). */
const SEED_EDITOR_RETRY_MS = 200;

type Props = DocumentEditorProps & {
  /** Replaces the socket provider (tests). */
  createProvider?: ProviderFactory;
  /** Shorter room waits (tests). */
  roomTiming?: DocumentRoomOptions['timing'];
};

/**
 * Seeds an empty room (the one editor the server grants it to writes the
 * current document in one transaction) or, after a revisioned save outside
 * the room, replaces the blocks that differ from the latest snapshot. Resolves
 * once the room has content to bind to.
 */
function prepareRoom(room: DocumentRoom, seedEditor: () => Editor | null, latestSnapshot: () => Promise<{ blocks: { id: string; source: string }[] } | null>, onReady: () => void) {
  const fragment = room.fragment;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observing = true;
  const stopObserving = () => {
    if (observing) fragment.unobserve(observer);
    observing = false;
  };
  const finish = () => {
    if (cancelled || fragment.length === 0) return false;
    stopObserving();
    onReady();
    return true;
  };
  const observer = () => { finish(); };
  const attempt = async () => {
    timer = null;
    if (cancelled) return;
    const editor = seedEditor();
    if (fragment.length > 0) {
      if (room.staleRevision && editor) {
        const snapshot = await latestSnapshot();
        if (cancelled) return;
        if (snapshot && !editor.isDestroyed) {
          const target = reconciledContent(editor, yDocToProsemirrorJSON(room.ydoc, ROOM_FIELD), snapshot.blocks);
          prosemirrorJSONToYXmlFragment(editor.schema, target, fragment);
        }
      }
      finish();
      return;
    }
    if (!editor) {
      timer = setTimeout(() => { void attempt(); }, SEED_EDITOR_RETRY_MS);
      return;
    }
    const granted = await room.requestInit();
    if (cancelled) return;
    if (granted && fragment.length === 0 && !editor.isDestroyed) {
      prosemirrorJSONToYXmlFragment(editor.schema, editor.getJSON(), fragment);
    }
    // Without the grant, someone else is seeding; the observer binds once their content arrives.
    if (!finish()) timer = setTimeout(() => { void attempt(); }, INIT_RETRY_MS);
  };
  fragment.observe(observer);
  void attempt();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    stopObserving();
  };
}

/**
 * The lazy editor entry. Editable cloud documents join their collaboration
 * room: once the room has synced and has content, the editor is bound to its
 * Y document and stays bound across reconnects. Until then (ticket refused,
 * offline) it edits with revisioned saves.
 */
export function DocumentEditor(props: Props) {
  const output = useRef<SurfaceOutput>({ markdown: null, blockIds: null });
  const seedEditor = useRef<Editor | null>(null);
  // Index ids (`b3`) of a document saved before ids existed get `k:` ids once; after its first stamped save the server lists only `k:` ids.
  const [initialLegacyIds] = useState(() => legacyIdsFor(props.blocks, newBlockId));
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const [room, setRoom] = useState<DocumentRoom | null>(null);
  const [synced, setSynced] = useState(false);
  const [ready, setReady] = useState<DocumentRoom | null>(null);

  const attachmentId = props.collab?.attachmentId ?? null;
  const api = props.collab?.api ?? null;
  const accountId = props.collab?.user.accountId ?? null;
  useEffect(() => {
    const collab = latest.current.collab;
    if (!collab || !api || !attachmentId || !accountId) return undefined;
    const created = new DocumentRoom({
      api,
      attachmentId,
      user: collab.user,
      createProvider: latest.current.createProvider,
      timing: latest.current.roomTiming,
      markdown: () => output.current.markdown,
      blockIds: () => output.current.blockIds,
      onChange: () => {
        setSynced(created.synced);
        latest.current.onCollab?.({ status: created.status, peers: created.peers() });
      },
      onSnapshot: (document) => latest.current.onSnapshot?.(document),
    });
    setRoom(created);
    created.start();
    return () => {
      created.destroy();
      setRoom(null);
      setSynced(false);
      latest.current.onCollab?.({ status: 'offline', peers: [] });
    };
  }, [accountId, api, attachmentId]);

  useEffect(() => {
    if (!room || !synced || !api || !attachmentId) return undefined;
    return prepareRoom(
      room,
      () => seedEditor.current,
      () => api.getDocument(attachmentId).catch(() => null),
      () => setReady(room),
    );
  }, [api, attachmentId, room, synced]);

  const bound = room && ready === room ? room : null;
  return (
    <DocumentEditorSurface
      key={bound ? 'room' : 'revisioned'}
      {...props}
      room={bound}
      user={bound ? props.collab?.user ?? null : null}
      output={output}
      initialLegacyIds={initialLegacyIds}
      onEditor={(editor) => {
        if (!bound) seedEditor.current = editor;
        props.onEditor?.(editor);
      }}
    />
  );
}

export default DocumentEditor;
