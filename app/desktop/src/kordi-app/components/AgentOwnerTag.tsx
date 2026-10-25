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

/** The human inline-sender look, used for agent names in group chats. */
export const AGENT_GROUP_NAME_CLASS = 'app-message-inline-sender truncate text-[12px] font-semibold leading-4';

export function AgentHeaderMeta({ sender, ownerName, className, highlightName = false }: { sender?: string | null; ownerName?: string | null; className?: string; highlightName?: boolean }) {
  return (
    <div className={cn('app-message-meta flex items-center gap-1.5 px-1', className)}>
      <span className={highlightName ? AGENT_GROUP_NAME_CLASS : undefined}>{sender}</span>
      <AgentOwnerTag name={ownerName} />
    </div>
  );
}
