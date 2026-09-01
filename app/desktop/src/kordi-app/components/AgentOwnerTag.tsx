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

export function AgentHeaderMeta({ sender, ownerName }: { sender?: string | null; ownerName?: string | null }) {
  return (
    <div className="app-message-meta flex items-center gap-1.5 px-1">
      <span>{sender}</span>
      <AgentOwnerTag name={ownerName} />
    </div>
  );
}
