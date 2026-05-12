import { ArrowLeft, Brush, FileText, MoreHorizontal, Pencil } from 'lucide-react';

import { setActiveScratchId, useActiveScratchId, useScratchList } from './scratchStore';

type Props = {
  sessionId: string;
};

export function ScratchPanel({ sessionId }: Props) {
  const scratches = useScratchList(sessionId);
  const activeScratchId = useActiveScratchId(sessionId);
  const active = activeScratchId ? scratches.find((s) => s.id === activeScratchId) ?? null : null;

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-[13px] font-semibold text-slate-200">No scratch open</div>
        <div className="text-[12px] text-slate-500">
          Open the <span className="font-medium text-slate-300">Scratch ▾</span> menu above to create or pick one.
        </div>
      </div>
    );
  }

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
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-[12px] text-slate-500">
        <div className="font-medium text-slate-400">
          {active.kind === 'canvas' ? 'Canvas editor' : 'Doc editor'} placeholder
        </div>
        <div>Coming in {active.kind === 'canvas' ? 'PR-03 (#358)' : 'PR-02 (#357)'}.</div>
      </div>
    </div>
  );
}
