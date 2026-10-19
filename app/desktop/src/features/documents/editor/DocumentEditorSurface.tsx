import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { DocumentShareApi } from '../documentShareApi';
import type { DocumentComment, DocumentReaction, DocumentResponse } from '../documentShareTypes';
import type { DocumentCollabState } from '../documentPresence';
import type { CollabUser, DocumentRoom } from './documentRoom';
import { annotationContainer, AnnotationWidgets, setAnnotatedBlocks } from './annotationWidgets';
import { serializeBlocks, sourceOfBlocks, type SourceBlock } from './documentBlockIds';
import { insertBlock, type InsertTool } from './documentEditorCommands';
import { documentEditorExtensions } from './documentEditorExtensions';
import { applyRemoteBlocks, loadBlocks, OUTSIDE_CONTENT, type SyncState } from './documentEditorSync';
import { DocumentBubbleMenu } from './DocumentBubbleMenu';
import { DocumentSlashMenu } from './DocumentSlashMenu';
import { slashMatches, slashQuery } from './documentSlashItems';

export type DocumentEditorHandle = { insert: (tool: InsertTool, url?: string) => void };

export type DocumentEditorProps = {
  /** Joins the document's collaboration room (editable cloud documents with a signed-in viewer). */
  collab?: { api: DocumentShareApi; attachmentId: string; user: CollabUser } | null;
  /** Room status and the people in it. */
  onCollab?: (state: DocumentCollabState) => void;
  /** A snapshot the room's writer saved (new revision, remapped annotations). */
  onSnapshot?: (document: DocumentResponse) => void;
  /** Blocks from outside: the server's (`k:` or index ids, sources without comments) or a local file's. */
  blocks: readonly SourceBlock[];
  /** Changes whenever `blocks` is a new outside version (load, remote update, a save's answer). */
  revisionKey: string;
  editable: boolean;
  canComment: boolean;
  canReact: boolean;
  reactions: DocumentReaction[];
  comments: DocumentComment[];
  /** Server block id that shows a new-comment field. */
  composingBlock: string | null;
  /** Reactions, threads, and the comment field under a block, by the block id the server knows. Kept outside this
   * module so the lazy editor chunk does not carry the app's comment UI. */
  renderAnnotations: (serverBlockId: string) => ReactNode;
  /** The whole Markdown with id comments, and the index-to-id map for a document's first stamped save. */
  onChange: (markdown: string, blockIds: Record<string, string> | null) => void;
  onComment: (serverBlockId: string) => void;
  onReact: (serverBlockId: string, reaction: string) => void;
  onUpdatedElsewhere?: () => void;
  onReady?: (handle: DocumentEditorHandle | null) => void;
  /** Exposes the Tiptap editor (tests and the review page). */
  onEditor?: (editor: Editor | null) => void;
};

type Slash = { query: string; range: { from: number; to: number }; position: { top: number; left: number } };

/** What the surface shares with the room wrapper: the latest Markdown and the first-stamping id map. */
export type SurfaceOutput = { markdown: string | null; blockIds: Record<string, string> | null };

type SurfaceProps = DocumentEditorProps & {
  /** Bound to the room's Y document when set; revisioned otherwise. */
  room: DocumentRoom | null;
  user: CollabUser | null;
  output: { current: SurfaceOutput };
  /** `k:` ids chosen once for index ids; shared by the room and revisioned editors so the first stamped write maps them. */
  initialLegacyIds: Record<string, string>;
};

/**
 * The document as a Tiptap (ProseMirror) editor: Markdown in and out, stable
 * block ids, a bubble menu on the selection, a `/` menu, and the block's
 * reactions and comments under it. In a room the content is the room's Y
 * document; out of one it loads and merges outside versions by block id.
 */
export function DocumentEditorSurface(props: SurfaceProps) {
  const latest = useRef({ ...props, dirty: false });
  useLayoutEffect(() => { latest.current = { ...props, dirty: latest.current.dirty }; });
  const sync = useRef<SyncState>({ base: [], legacyIds: {} });
  /** The editor the outside blocks were loaded into, and the revision it holds. */
  const applied = useRef<{ editor: Editor | null; key: string }>({ editor: null, key: '' });
  // Index ids (`b3`) of a document saved before ids existed get `k:` ids once; after its first stamped save the server lists only `k:` ids.
  const { initialLegacyIds } = props;
  const legacyIds = useMemo(() => (props.blocks.some((block) => !block.id.startsWith('k:')) ? initialLegacyIds : {}), [initialLegacyIds, props.blocks]);
  const [slash, setSlash] = useState<Slash | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const slashRef = useRef<{ open: boolean; count: number }>({ open: false, count: 0 });

  /** The editor's Markdown and the index-to-id map, for saves and the room's snapshots. */
  const emitOutput = useCallback((editor: Editor) => {
    const markdown = sourceOfBlocks(serializeBlocks(editor.markdown!, editor.getJSON()));
    const present = new Set<string>();
    editor.state.doc.forEach((node) => { if (typeof node.attrs.id === 'string') present.add(node.attrs.id); });
    const stamped = Object.entries(sync.current.legacyIds).filter(([, id]) => present.has(id));
    const output = { markdown, blockIds: stamped.length > 0 ? Object.fromEntries(stamped) : null };
    latest.current.output.current = output;
    return output;
  }, []);

  const emitChange = useCallback((editor: Editor) => {
    const { markdown, blockIds } = emitOutput(editor);
    // While the room is connected it carries every change; revisioned saves only happen without it.
    if (latest.current.room?.status === 'connected') return;
    // Transactions that change nothing in the Markdown (id stamping after a load, selection-only steps) are not edits.
    if (markdown === sourceOfBlocks(sync.current.base) && !latest.current.dirty) return;
    latest.current.dirty = true;
    latest.current.onChange(markdown, blockIds);
  }, [emitOutput]);

  const updateSlash = (editor: Editor) => {
    const found = editor.isEditable ? slashQuery(editor) : null;
    const shell = shellRef.current;
    if (!found || !shell) {
      slashRef.current = { open: false, count: 0 };
      setSlash(null);
      return;
    }
    const caret = editor.view.coordsAtPos(found.to);
    const box = shell.getBoundingClientRect();
    slashRef.current = { open: true, count: slashMatches(found.query).length };
    setSlash({ query: found.query, range: { from: found.from, to: found.to }, position: { top: caret.bottom - box.top + 6, left: Math.max(0, caret.left - box.left) } });
  };

  const editor = useEditor({
    extensions: documentEditorExtensions([AnnotationWidgets], props.room && props.user ? { room: props.room, user: props.user } : null),
    editable: props.editable,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'app-document-markdown app-document-prose', 'data-kordi-copy-surface': 'document' },
      handleKeyDown: (_view, event) => {
        if (!slashRef.current.open) return false;
        if (event.key === 'Escape') { slashRef.current.open = false; setSlash(null); return true; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const count = Math.max(1, slashRef.current.count);
          setSlashIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
          return true;
        }
        if (event.key === 'Enter') {
          shellRef.current?.querySelector<HTMLButtonElement>('[data-slash-item][aria-selected="true"]')?.click();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: changed, transaction }) => {
      // Only the editor this surface loaded reports edits. Another instance (React's discarded
      // render in development) starts empty, and its id stamping would save an empty document.
      if (changed !== applied.current.editor) return;
      updateSlash(changed);
      if (!transaction.getMeta(OUTSIDE_CONTENT)) emitChange(changed);
    },
    onSelectionUpdate: ({ editor: changed }) => updateSlash(changed),
  });

  // The first outside version loads; newer ones (remote save, our own save's answer, a reloaded file) merge in.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (applied.current.editor !== editor) {
      applied.current = { editor, key: props.revisionKey };
      // A room's content is its Y document, seeded or reconciled before the editor binds to it.
      if (props.room) {
        sync.current = { base: [], legacyIds };
        emitOutput(editor);
        return;
      }
      sync.current = loadBlocks(editor, props.blocks, legacyIds);
      emitOutput(editor);
      return;
    }
    // In a room, outside versions are snapshots of the room itself.
    if (props.room) return;
    if (applied.current.key === props.revisionKey) return;
    applied.current.key = props.revisionKey;
    const result = applyRemoteBlocks(editor, sync.current, props.blocks, legacyIds);
    sync.current = result.sync;
    if (result.conflict) latest.current.onUpdatedElsewhere?.();
    if (result.localChanges) emitChange(editor);
  }, [editor, emitChange, emitOutput, legacyIds, props.blocks, props.revisionKey, props.room]);

  useEffect(() => { editor?.setEditable(props.editable); }, [editor, props.editable]);

  // Registered once per editor instance; the callbacks are read from the latest props.
  useEffect(() => {
    const { onReady, onEditor } = latest.current;
    onReady?.(editor ? { insert: (tool, url) => { insertBlock(editor, tool, url); } } : null);
    onEditor?.(editor);
    return () => { onReady?.(null); onEditor?.(null); };
  }, [editor]);

  // Annotations: server ids are `k:` ids or index ids from before the first stamped save.
  const serverIdFor = (nodeId: string) => Object.entries(legacyIds).find(([, id]) => id === nodeId)?.[0] ?? nodeId;
  const annotated = useMemo(() => {
    const ids = new Set<string>();
    props.reactions.forEach((entry) => ids.add(entry.blockId));
    props.comments.forEach((entry) => { if (!entry.resolvedAt && !entry.parentCommentId) ids.add(entry.blockId); });
    if (props.composingBlock) ids.add(props.composingBlock);
    return [...ids].flatMap((serverId) => {
      const nodeId = serverId.startsWith('k:') ? serverId : legacyIds[serverId];
      return nodeId ? [{ serverId, nodeId }] : [];
    });
  }, [legacyIds, props.comments, props.composingBlock, props.reactions]);

  const annotatedKey = annotated.map((entry) => entry.nodeId).sort().join(',');
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    setAnnotatedBlocks(editor, annotatedKey ? annotatedKey.split(',') : []);
  }, [annotatedKey, editor]);

  if (!editor) return null;
  return (
    <div className="app-document-editor-shell" ref={shellRef}>
      <EditorContent editor={editor} />
      <DocumentBubbleMenu
        editor={editor}
        canFormat={props.editable}
        canComment={props.canComment}
        canReact={props.canReact}
        onComment={(nodeId) => props.onComment(serverIdFor(nodeId))}
        onReact={(nodeId, reaction) => props.onReact(serverIdFor(nodeId), reaction)}
      />
      {slash ? (
        <DocumentSlashMenu
          key={`${slash.range.from}`}
          editor={editor}
          query={slash.query}
          range={slash.range}
          position={slash.position}
          activeIndex={Math.min(slashIndex, Math.max(0, slashMatches(slash.query).length - 1))}
          onClose={() => { slashRef.current.open = false; setSlash(null); setSlashIndex(0); }}
        />
      ) : null}
      {annotated.map(({ serverId, nodeId }) => createPortal(
        props.renderAnnotations(serverId),
        annotationContainer(editor, nodeId),
        serverId,
      ))}
    </div>
  );
}
