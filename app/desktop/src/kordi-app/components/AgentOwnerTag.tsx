import { cn } from '@/lib/utils';

export function AgentOwnerTag({ name }: { name?: string | null }) {
  const owner = name?.trim();
  if (!owner) return null;
  return (
    <span
      className="inline-flex max-w-48 items-center truncate text-[9px] font-medium leading-none opacity-75"
      aria-label={`Owner: ${owner}`}
      title={`Owner: ${owner}`}
    >
      Owner · {owner}
    </span>
  );
}

export function AgentHeaderMeta({ sender, ownerName, className }: { sender?: string | null; ownerName?: string | null; className?: string }) {
  return (
    <div className={cn('app-message-meta flex items-center gap-1.5 px-1', className)}>
      <span>{sender}</span>
      <AgentOwnerTag name={ownerName} />
    </div>
  );
}
