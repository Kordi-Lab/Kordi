import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Brush, ChevronRight, FileText, MoreHorizontal, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';

import { createScratch, formatRelativeTime, setActiveScratchId, useScratchList } from './scratchStore';
import type { ScratchKind } from './types';

type Props = {
  sessionId: string;
  active: boolean;
  onActivateScratchTab: () => void;
  triggerClassName: string;
};

const ITEM_CLASS = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-200 outline-none transition data-[highlighted]:bg-white/10 data-[highlighted]:text-white';

const SUB_TRIGGER_CLASS = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-200 outline-none transition data-[highlighted]:bg-white/10 data-[highlighted]:text-white data-[state=open]:bg-white/10 data-[state=open]:text-white';

const POPOVER_CLASS = 'z-50 rounded-xl border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] p-1.5 text-[13px] text-slate-200 shadow-2xl backdrop-blur-md';

export function MoreTabDropdown({ sessionId, active, onActivateScratchTab, triggerClassName }: Props) {
  const scratches = useScratchList(sessionId);

  const handleCreate = (kind: ScratchKind) => {
    if (!sessionId) return;
    createScratch(sessionId, kind);
    onActivateScratchTab();
  };

  const handleSelect = (scratchId: string) => {
    if (!sessionId) return;
    setActiveScratchId(sessionId, scratchId);
    onActivateScratchTab();
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(triggerClassName, 'flex min-w-0 items-center justify-center')}
          title="More"
          aria-label="More"
          data-active={active ? 'true' : undefined}
        >
          <MoreHorizontal className="size-[1.1em] shrink-0" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          className={cn(POPOVER_CLASS, 'min-w-[180px]')}
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={SUB_TRIGGER_CLASS}>
              <span className="min-w-0 flex-1 truncate">Scratch</span>
              <ChevronRight className="h-3 w-3 opacity-60" aria-hidden />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={4}
                alignOffset={-4}
                collisionPadding={8}
                className={cn(POPOVER_CLASS, 'min-w-[260px]')}
              >
                <DropdownMenu.Item className={ITEM_CLASS} onSelect={() => handleCreate('canvas')}>
                  <Plus className="h-3.5 w-3.5 opacity-70" />
                  <Brush className="h-4 w-4 opacity-70" />
                  <span className="flex-1">New Canvas</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={ITEM_CLASS} onSelect={() => handleCreate('doc')}>
                  <Plus className="h-3.5 w-3.5 opacity-70" />
                  <FileText className="h-4 w-4 opacity-70" />
                  <span className="flex-1">New Doc</span>
                </DropdownMenu.Item>
                {scratches.length > 0 ? (
                  <>
                    <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
                    <div className="max-h-[280px] overflow-y-auto">
                      <DropdownMenu.Group>
                        {scratches.map((scratch) => (
                          <DropdownMenu.Item
                            key={scratch.id}
                            className={ITEM_CLASS}
                            onSelect={() => handleSelect(scratch.id)}
                          >
                            {scratch.kind === 'canvas' ? (
                              <Brush className="h-4 w-4 opacity-70" />
                            ) : (
                              <FileText className="h-4 w-4 opacity-70" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{scratch.name}</span>
                            <span className="shrink-0 text-[11px] text-slate-500">
                              edited {formatRelativeTime(scratch.updatedAt)}
                            </span>
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Group>
                    </div>
                  </>
                ) : null}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
