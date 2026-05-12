import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Pencil } from 'lucide-react';

import { cn } from '@/lib/utils';

type Props = {
  active: boolean;
  onActivateScratchTab: () => void;
  triggerClassName: string;
};

const ITEM_CLASS = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-200 outline-none transition data-[highlighted]:bg-white/10 data-[highlighted]:text-white';

export function MoreTabDropdown({ active, onActivateScratchTab, triggerClassName }: Props) {
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
          className="z-50 min-w-[180px] rounded-xl border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] p-1.5 text-[13px] text-slate-200 shadow-2xl backdrop-blur-md"
        >
          <DropdownMenu.Item className={ITEM_CLASS} onSelect={onActivateScratchTab}>
            <Pencil className="h-4 w-4 opacity-70" />
            <span className="flex-1">Scratch</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
