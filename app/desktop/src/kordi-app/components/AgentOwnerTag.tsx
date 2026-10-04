import { messageOffersReplyDisclosure, requestReplyDisclosure } from '@/features/agentTrust/replyDisclosureTarget';
import type { Message } from '../types';

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

const AI_CHIP_CLASS = 'app-ai-chip inline-flex h-4 shrink-0 items-center rounded-[5px] border border-current px-1 text-[9px] font-semibold leading-none opacity-80';

/** The "AI" chip on agent messages. The text and accessible name never rely
 * on color. Where Kordi can describe the reply, it opens "About this reply". */
export function AgentAiChip({ message }: { message?: Message | null }) {
  if (!message) return null;
  if (!messageOffersReplyDisclosure(message)) {
    return <span className={AI_CHIP_CLASS} role="img" aria-label="AI agent">AI</span>;
  }
  return (
    <button
      type="button"
      className={`${AI_CHIP_CLASS} cursor-pointer hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-sidebar-accent)]`}
      aria-label="AI agent, about this reply"
      title="About this reply"
      data-agent-ai-chip="true"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        requestReplyDisclosure(message);
      }}
    >
      AI
    </button>
  );
}

export function AgentHeaderMeta({ sender, ownerName, message }: { sender?: string | null; ownerName?: string | null; message?: Message | null }) {
  return (
    <div className="app-message-meta flex items-center gap-1.5 px-1">
      <span>{sender}</span>
      <AgentAiChip message={message} />
      <AgentOwnerTag name={ownerName} />
    </div>
  );
}
