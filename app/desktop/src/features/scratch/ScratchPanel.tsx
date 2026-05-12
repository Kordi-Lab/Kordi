import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeft, Brush, FileText, HelpCircle, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { Suspense, lazy } from 'react';

import { DocEditor } from './DocEditor';
import {
  createScratch,
  formatRelativeTime,
  setActiveScratchId,
  useActiveScratchId,
  useScratchList,
} from './scratchStore';
import type { ScratchKind, ScratchMetadata } from './types';

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

function ScratchListView({ sessionId, scratches }: { sessionId: string; scratches: readonly ScratchMetadata[] }) {
  const handleCreate = (kind: ScratchKind) => {
    if (!sessionId) return;
    createScratch(sessionId, kind);
  };

  const handleSelect = (id: string) => {
    if (!sessionId) return;
    setActiveScratchId(sessionId, id);
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
              return (
                <li key={scratch.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(scratch.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition hover:bg-white/5"
                  >
                    <KindIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">{scratch.name}</span>
                    <span className="shrink-0 text-[11px] text-slate-500">
                      edited {formatRelativeTime(scratch.updatedAt)}
                    </span>
                  </button>
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
  const KindIcon = active.kind === 'canvas' ? Brush : FileText;
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
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">{active.name}</span>
        {active.kind === 'doc' ? <MarkdownCheatSheetButton /> : null}
        <button
          type="button"
          disabled
          className="grid h-7 w-7 place-items-center rounded-md text-slate-500 opacity-40"
          title="Rename (PR-04)"
          aria-label="Rename (PR-04)"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled
          className="grid h-7 w-7 place-items-center rounded-md text-slate-500 opacity-40"
          title="More (PR-04)"
          aria-label="More (PR-04)"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {active.kind === 'doc' ? (
        <DocEditor sessionId={sessionId} scratchId={active.id} />
      ) : (
        <Suspense fallback={<div className="scratch-canvas-loading">Loading canvas…</div>}>
          <CanvasEditor sessionId={sessionId} scratchId={active.id} />
        </Suspense>
      )}
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
