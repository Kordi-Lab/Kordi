import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeft, Brush, ChevronRight, Copy, Download, FileText, HelpCircle, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';

import type { CanvasEditorHandle } from './CanvasEditor';
import { DocEditor } from './DocEditor';
import { ExportCanvasDialog } from './ExportCanvasDialog';
import type { CanvasExportOptions } from './download/exportCanvas';
import type { TiptapNode } from './download/tiptapToPdfmake';
import {
  createScratch,
  deleteScratch,
  duplicateScratch,
  formatRelativeTime,
  renameScratch,
  setActiveScratchId,
  useActiveScratchId,
  useScratchList,
} from './scratchStore';
import { kvGet, scratchStorageKey } from './storage/indexedDb';
import type { ScratchKind, ScratchMetadata } from './types';

type DownloadHandlers =
  | {
      kind: 'doc';
      markdown: () => Promise<void>;
      pdf: () => Promise<void>;
      docx: () => Promise<void>;
    }
  | {
      kind: 'canvas';
      openDialog: () => void;
    };

const EMPTY_DOC: TiptapNode = { type: 'doc', content: [] };

function buildDocDownloadHandlers(sessionId: string, scratchId: string, scratchName: string): DownloadHandlers {
  const loadJson = async (): Promise<TiptapNode> => {
    const stored = await kvGet<TiptapNode>(scratchStorageKey(sessionId, scratchId));
    return stored && typeof stored === 'object' ? stored : EMPTY_DOC;
  };
  return {
    kind: 'doc',
    markdown: async () => {
      const [{ exportScratchMarkdown, renderJsonToMarkdown }, json] = await Promise.all([
        import('./download/exportMarkdown'),
        loadJson(),
      ]);
      const md = renderJsonToMarkdown(json);
      exportScratchMarkdown(md, scratchName);
    },
    pdf: async () => {
      const [{ exportScratchPdf }, json] = await Promise.all([
        import('./download/exportPdf'),
        loadJson(),
      ]);
      await exportScratchPdf(json, scratchName);
    },
    docx: async () => {
      const [{ exportScratchDocx }, json] = await Promise.all([
        import('./download/exportDocx'),
        loadJson(),
      ]);
      await exportScratchDocx(json, scratchName);
    },
  };
}

const MENU_ITEM_CLASS = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-200 outline-none transition data-[highlighted]:bg-white/10 data-[highlighted]:text-white';
const MENU_ITEM_DESTRUCTIVE_CLASS = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-red-300 outline-none transition data-[highlighted]:bg-red-500/15 data-[highlighted]:text-red-200';

function ConfirmDeleteDialog({
  open,
  onOpenChange,
  scratchName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scratchName: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] p-5 text-slate-200 shadow-2xl">
          <AlertDialog.Title className="mb-2 text-[14px] font-semibold text-white">
            Delete this scratch?
          </AlertDialog.Title>
          <AlertDialog.Description className="mb-4 text-[12px] text-slate-400">
            &ldquo;{scratchName}&rdquo; will be permanently removed. This cannot be undone.
          </AlertDialog.Description>
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] text-slate-200 transition hover:bg-white/10"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onConfirm}
                className="rounded-md border border-red-500/40 bg-red-500/20 px-3 py-1.5 text-[12px] font-medium text-red-100 transition hover:bg-red-500/30"
              >
                Delete
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function ScratchActionsMenu({
  scratchName,
  onRename,
  onDuplicate,
  onDelete,
  onDownload,
}: {
  scratchName: string;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDownload?: DownloadHandlers;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
            title="More actions"
            aria-label="More actions"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            side="bottom"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 min-w-[160px] rounded-xl border border-[color:var(--app-divider)] bg-zinc-900 p-1.5 text-[13px] text-slate-200 shadow-2xl"
          >
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onRename}>
              <Pencil className="h-3.5 w-3.5 opacity-70" />
              <span>Rename</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onDuplicate}>
              <Copy className="h-3.5 w-3.5 opacity-70" />
              <span>Duplicate</span>
            </DropdownMenu.Item>
            {onDownload?.kind === 'doc' ? (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className={`${MENU_ITEM_CLASS} data-[state=open]:bg-white/10 data-[state=open]:text-white`}>
                  <Download className="h-3.5 w-3.5 opacity-70" />
                  <span className="flex-1">Download</span>
                  <ChevronRight className="h-3 w-3 opacity-60" aria-hidden />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    sideOffset={4}
                    alignOffset={-4}
                    collisionPadding={8}
                    className="z-50 min-w-[180px] rounded-xl border border-[color:var(--app-divider)] bg-zinc-900 p-1.5 text-[13px] text-slate-200 shadow-2xl"
                  >
                    <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => void onDownload.markdown()}>
                      <span className="flex-1">Markdown</span>
                      <span className="font-mono text-[11px] text-slate-500">.md</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => void onDownload.pdf()}>
                      <span className="flex-1">PDF</span>
                      <span className="font-mono text-[11px] text-slate-500">.pdf</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => void onDownload.docx()}>
                      <span className="flex-1">Word</span>
                      <span className="font-mono text-[11px] text-slate-500">.docx</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            ) : null}
            {onDownload?.kind === 'canvas' ? (
              <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onDownload.openDialog}>
                <Download className="h-3.5 w-3.5 opacity-70" />
                <span className="flex-1">Download…</span>
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
            <DropdownMenu.Item className={MENU_ITEM_DESTRUCTIVE_CLASS} onSelect={() => setConfirmOpen(true)}>
              <Trash2 className="h-3.5 w-3.5 opacity-80" />
              <span>Delete</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        scratchName={scratchName}
        onConfirm={() => {
          onDelete();
          setConfirmOpen(false);
        }}
      />
    </>
  );
}

const CanvasEditor = lazy(() => import('./CanvasEditor'));

const MD_SHORTCUTS: Array<{ label: string; syntax: string }> = [
  { label: 'Heading 1 / 2 / 3', syntax: '#  ##  ###' },
  { label: 'Bullet list', syntax: '- ' },
  { label: 'Numbered list', syntax: '1. ' },
  { label: 'Bold', syntax: '**bold**' },
  { label: 'Italic', syntax: '*italic*' },
  { label: 'Inline code', syntax: '`code`' },
  { label: 'Code block', syntax: '```' },
  { label: 'Blockquote', syntax: '> ' },
  { label: 'Divider', syntax: '---' },
];

type Props = {
  sessionId: string;
};

export function ScratchPanel({ sessionId }: Props) {
  const scratches = useScratchList(sessionId);
  const activeScratchId = useActiveScratchId(sessionId);
  const active = activeScratchId ? scratches.find((s) => s.id === activeScratchId) ?? null : null;

  if (!active) {
    return <ScratchListView sessionId={sessionId} scratches={scratches} />;
  }

  return <ScratchEditorView sessionId={sessionId} active={active} />;
}

function InlineRenameInput({
  initial,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value)}
      onClick={(e) => e.stopPropagation()}
      className={className}
    />
  );
}

function ScratchListView({ sessionId, scratches }: { sessionId: string; scratches: readonly ScratchMetadata[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleCreate = (kind: ScratchKind) => {
    if (!sessionId) return;
    createScratch(sessionId, kind);
  };

  const handleSelect = (id: string) => {
    if (!sessionId) return;
    setActiveScratchId(sessionId, id);
  };

  const commitRename = (id: string, name: string) => {
    renameScratch(sessionId, id, name);
    setEditingId(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--app-divider)] pb-2">
        <span className="text-[13px] font-semibold text-white">Scratch</span>
        <span className="text-[11px] text-slate-500">
          {scratches.length} item{scratches.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex shrink-0 gap-2 py-3">
        <NewScratchButton kind="canvas" onCreate={handleCreate} />
        <NewScratchButton kind="doc" onCreate={handleCreate} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {scratches.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-slate-500">
            No scratches yet. Use the buttons above to create one.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {scratches.map((scratch) => {
              const KindIcon = scratch.kind === 'canvas' ? Brush : FileText;
              const isEditing = editingId === scratch.id;
              if (isEditing) {
                return (
                  <li key={scratch.id}>
                    <div className="flex w-full items-center gap-2 rounded-md px-2 py-2">
                      <KindIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <InlineRenameInput
                        initial={scratch.name}
                        onCommit={(name) => commitRename(scratch.id, name)}
                        onCancel={() => setEditingId(null)}
                        className="min-w-0 flex-1 rounded-sm border border-white/15 bg-black/40 px-1 py-0.5 text-[13px] text-white outline-none focus:border-white/40"
                      />
                    </div>
                  </li>
                );
              }
              return (
                <li key={scratch.id} className="group flex items-center rounded-md transition hover:bg-white/5">
                  <button
                    type="button"
                    onClick={() => handleSelect(scratch.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                  >
                    <KindIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span
                      className="min-w-0 flex-1 truncate text-[13px] text-slate-200"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(scratch.id);
                      }}
                      title="Double-click to rename"
                    >
                      {scratch.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-500">
                      edited {formatRelativeTime(scratch.updatedAt)}
                    </span>
                  </button>
                  <div className="shrink-0 pr-1">
                    <ScratchActionsMenu
                      scratchName={scratch.name}
                      onRename={() => setEditingId(scratch.id)}
                      onDuplicate={() => {
                        duplicateScratch(sessionId, scratch.id);
                      }}
                      onDelete={() => {
                        deleteScratch(sessionId, scratch.id);
                      }}
                      onDownload={
                        scratch.kind === 'doc'
                          ? buildDocDownloadHandlers(sessionId, scratch.id, scratch.name)
                          : undefined
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewScratchButton({
  kind,
  onCreate,
}: {
  kind: ScratchKind;
  onCreate: (kind: ScratchKind) => void;
}) {
  const Icon = kind === 'canvas' ? Brush : FileText;
  const label = kind === 'canvas' ? 'New Canvas' : 'New Doc';
  return (
    <button
      type="button"
      onClick={() => onCreate(kind)}
      className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[color:var(--app-divider)] bg-white/5 px-3 py-2 text-[12px] text-slate-200 transition hover:bg-white/10 hover:text-white"
    >
      <Plus className="h-3 w-3 opacity-70" />
      <Icon className="h-3.5 w-3.5 opacity-70" />
      <span>{label}</span>
    </button>
  );
}

function ScratchEditorView({ sessionId, active }: { sessionId: string; active: ScratchMetadata }) {
  const [editingName, setEditingName] = useState(false);
  const [canvasExportOpen, setCanvasExportOpen] = useState(false);
  const canvasRef = useRef<CanvasEditorHandle>(null);
  const KindIcon = active.kind === 'canvas' ? Brush : FileText;

  const downloadHandlers = useMemo<DownloadHandlers | undefined>(() => {
    if (active.kind === 'doc') return buildDocDownloadHandlers(sessionId, active.id, active.name);
    if (active.kind === 'canvas') return { kind: 'canvas', openDialog: () => setCanvasExportOpen(true) };
    return undefined;
  }, [active.kind, active.id, active.name, sessionId]);

  const handleCanvasExport = async (options: CanvasExportOptions) => {
    const editor = canvasRef.current?.editor;
    if (!editor) return;
    const { exportScratchCanvas } = await import('./download/exportCanvas');
    await exportScratchCanvas(editor, active.name, options);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--app-divider)] pb-2">
        <button
          type="button"
          onClick={() => setActiveScratchId(sessionId, null)}
          className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
          title="Back to list"
          aria-label="Back to list"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <KindIcon className="h-3.5 w-3.5 shrink-0 text-slate-300" />
        {editingName ? (
          <InlineRenameInput
            initial={active.name}
            onCommit={(name) => {
              renameScratch(sessionId, active.id, name);
              setEditingName(false);
            }}
            onCancel={() => setEditingName(false)}
            className="min-w-0 flex-1 rounded-sm border border-white/15 bg-black/40 px-1 py-0.5 text-[13px] font-semibold text-white outline-none focus:border-white/40"
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white"
            onDoubleClick={() => setEditingName(true)}
            title="Double-click to rename"
          >
            {active.name}
          </span>
        )}
        {active.kind === 'doc' ? <MarkdownCheatSheetButton /> : null}
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
          title="Rename"
          aria-label="Rename"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <ScratchActionsMenu
          scratchName={active.name}
          onRename={() => setEditingName(true)}
          onDuplicate={() => {
            duplicateScratch(sessionId, active.id);
          }}
          onDelete={() => {
            deleteScratch(sessionId, active.id);
          }}
          onDownload={downloadHandlers}
        />
      </div>
      {active.kind === 'doc' ? (
        <DocEditor sessionId={sessionId} scratchId={active.id} />
      ) : (
        <Suspense fallback={<div className="scratch-canvas-loading">Loading canvas…</div>}>
          <CanvasEditor ref={canvasRef} sessionId={sessionId} scratchId={active.id} />
        </Suspense>
      )}
      {active.kind === 'canvas' ? (
        <ExportCanvasDialog
          open={canvasExportOpen}
          onOpenChange={setCanvasExportOpen}
          scratchName={active.name}
          onExport={handleCanvasExport}
        />
      ) : null}
    </div>
  );
}

function MarkdownCheatSheetButton() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
          title="Markdown shortcuts"
          aria-label="Markdown shortcuts"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-[300px] rounded-xl border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] p-3 text-[12px] text-slate-200 shadow-2xl backdrop-blur-md"
        >
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Markdown shortcuts
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
            {MD_SHORTCUTS.map((row) => (
              <span key={row.label} className="contents">
                <span className="text-slate-300">{row.label}</span>
                <span className="font-mono text-[11px] text-slate-400">{row.syntax}</span>
              </span>
            ))}
          </div>
          <div className="mt-3 border-t border-white/10 pt-2 text-[11px] text-slate-500">
            Type the shortcut at the start of a line. A Notion-style block menu lands in #371.
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
