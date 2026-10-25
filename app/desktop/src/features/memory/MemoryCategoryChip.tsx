import { cn } from '@/lib/utils';

import { memoryCategoryLabel } from './memoryCategory';

/** The category after a memory's date caption; nothing for a missing or unknown category. */
export function MemoryCategoryChip({ category, className }: { category: string | null | undefined; className?: string }) {
  const label = memoryCategoryLabel(category);
  if (!label) return null;
  return (
    <span
      data-memory-category={category ?? undefined}
      className={cn(
        'ml-1.5 inline-flex h-4 shrink-0 items-center rounded-full bg-[color:var(--app-palette-selected)] px-1.5 align-[1px] text-[10px] font-medium leading-none text-[color:var(--utility-muted-text)]',
        className,
      )}
    >
      {label}
    </span>
  );
}
