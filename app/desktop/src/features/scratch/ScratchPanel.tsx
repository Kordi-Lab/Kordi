import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeft, Brush, FileText, HelpCircle, MoreHorizontal, Pencil } from 'lucide-react';

import { DocEditor } from './DocEditor';
import { setActiveScratchId, useActiveScratchId, useScratchList } from './scratchStore';

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
        {active.kind === 'doc' ? (
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
        ) : null}
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
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-[12px] text-slate-500">
          <div className="font-medium text-slate-400">Canvas editor placeholder</div>
          <div>Coming in PR-03 (#358).</div>
        </div>
      )}
    </div>
  );
}
