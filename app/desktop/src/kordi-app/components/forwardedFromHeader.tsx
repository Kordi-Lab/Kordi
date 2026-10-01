import { Forward } from 'lucide-react';

import { withAiLabel } from '@/features/agentTrust/agentAuthorship';

/** Names a quoted or forwarded sender, marking messages an agent wrote. The
 * mark comes from the source message's kind, which the sender's app declares. */
export function sourceSenderLabelWithAi(label: string, sourceMessageKind?: string | null) {
  return withAiLabel(label, sourceMessageKind === 'agent-turn');
}

export function ForwardedFromHeader({ senderLabel, sourceMessageKind }: {
  senderLabel?: string | null;
  sourceMessageKind?: string | null;
}) {
  const sender = sourceSenderLabelWithAi(senderLabel?.trim() || 'Unknown sender', sourceMessageKind);

  return (
    <div
      data-message-forwarded-header="true"
      className="app-message-forwarded-header mb-1.5 flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-4"
    >
      <Forward className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="shrink-0">Forwarded from</span>
      <span className="app-message-forwarded-header-name min-w-0 truncate font-semibold">{sender}</span>
    </div>
  );
}
